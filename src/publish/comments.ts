/**
 * Comments on the links this daemon published (PROTOCOL.md "Comments"). The share host keeps them and cannot reach
 * this computer, so the daemon pulls each live link's events after the cursor it last saw: every 15 s while a client
 * watches that link (`comments.list`), every 2 minutes otherwise, never for an expired one. It keeps them per link in
 * `comments/<token>.json` (mode 0600), with the cursor and what the owner has read, so a client gets them at once and
 * a removed link's comments can still be read. The owner's replies and resolves go to the host with the link's key.
 */
import { EventEmitter } from "node:events";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CommentId, commentThreadsOf, OWNER_AUTHOR_ID, ShareCommentEvent, ShareToken, type CommentThread, type CommentsFrame, type ShareCommentPost } from "@grenade/protocol";
import type { Logger } from "../log.js";
import { tokenForLog } from "./publishPlan.js";
import type { ShareClient } from "./shareClient.js";

/** How often a watched link is asked for new comments, and how often every other live link is. */
export const COMMENTS_WATCHED_MS = 15_000;
export const COMMENTS_IDLE_MS = 120_000;

/** Why a reply, a resolve or a seen could not be done; `message` is a sentence for the user. */
export class CommentError extends Error {}

/** A link as comments need it: its token and key, and whether the host still serves it. */
export interface CommentLink {
  token: string;
  key: string;
  live: boolean;
}

export interface CommentServiceDeps {
  /** The folder of the per-link files. */
  dir: string;
  client: Pick<ShareClient, "getComments" | "postComment">;
  /** The links this daemon keeps now. */
  links(): CommentLink[];
  /** The owner's name ("" for none), for the owner's events. */
  ownerName(): string;
  log: Logger;
  now?: () => Date;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
}

interface LinkComments {
  events: ShareCommentEvent[];
  cursor?: string;
  /** Per thread, the time up to which the owner has read it. */
  seen: Record<string, string>;
  /** Why the last pull failed. */
  error?: string;
  /** When it was last asked for (ms), not kept. */
  pulled: number;
  pulling?: Promise<void>;
}

export class CommentService extends EventEmitter {
  private readonly state = new Map<string, LinkComments>();
  private readonly watchers = new Map<string, number>();
  private readonly now: () => Date;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (t: unknown) => void;
  private timer: unknown;
  private stopped = true;

  constructor(private readonly d: CommentServiceDeps) {
    super();
    this.now = d.now ?? (() => new Date());
    this.setTimer = d.setTimer ?? ((fn, ms) => {
      const t = setTimeout(fn, ms);
      t.unref?.();
      return t;
    });
    this.clearTimer = d.clearTimer ?? ((t) => clearTimeout(t as NodeJS.Timeout));
  }

  /** Starts asking the live links for comments. */
  start(): void {
    this.stopped = false;
    this.tick();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== undefined) this.clearTimer(this.timer);
    this.timer = undefined;
  }

  /** Asks every link that is due, then again in 15 s. */
  private tick(): void {
    if (this.stopped) return;
    const now = this.now().getTime();
    for (const link of this.d.links()) {
      if (!link.live) continue;
      const watched = (this.watchers.get(link.token) ?? 0) > 0;
      const state = this.stateOf(link.token);
      if (now - state.pulled >= (watched ? COMMENTS_WATCHED_MS : COMMENTS_IDLE_MS) - 500) void this.pull(link.token);
    }
    this.timer = this.setTimer(() => this.tick(), COMMENTS_WATCHED_MS);
  }

  /** A client follows `token`'s comments; returns how to stop. It is asked for at once, then every 15 s. */
  watch(token: string): () => void {
    this.watchers.set(token, (this.watchers.get(token) ?? 0) + 1);
    void this.pull(token);
    let done = false;
    return () => {
      if (done) return;
      done = true;
      const n = (this.watchers.get(token) ?? 1) - 1;
      if (n <= 0) this.watchers.delete(token);
      else this.watchers.set(token, n);
    };
  }

  /** A link's threads, newest change first. */
  threads(token: string): CommentThread[] {
    const state = this.stateOf(token);
    return commentThreadsOf(state.events, state.seen);
  }

  /** What a client is sent for a link. */
  frame(token: string, id?: string): CommentsFrame {
    const state = this.stateOf(token);
    return { type: "comments", ...(id ? { id } : {}), token, threads: this.threads(token), ...(state.error ? { error: state.error } : {}) };
  }

  /** How many threads are open and how many comments in them the owner has not read, for a link's `comments`. */
  summary(token: string): { open: number; unread: number } {
    const open = this.threads(token).filter((t) => !t.resolved);
    return { open: open.length, unread: open.reduce((n, t) => n + t.unread, 0) };
  }

  /** Brings a link's comments up to date; one pull at a time per link. */
  pull(token: string): Promise<void> {
    const link = this.d.links().find((l) => l.token === token);
    const state = this.stateOf(token);
    if (!link || !link.live) return Promise.resolve();
    if (state.pulling) return state.pulling;
    state.pulled = this.now().getTime();
    state.pulling = (async () => {
      try {
        const reply = await this.d.client.getComments(token, link.key, state.cursor);
        const added = this.add(state, reply.events);
        const errorWas = state.error;
        delete state.error;
        if (reply.cursor) state.cursor = reply.cursor;
        if (added || errorWas) {
          this.save(token, state);
          this.changed(token);
        } else if (reply.cursor) this.save(token, state);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        if (state.error !== message) {
          state.error = message;
          this.d.log.debug("Could not ask for a link's comments", { link: tokenForLog(token), error: message });
          this.changed(token);
        }
      } finally {
        delete state.pulling;
      }
    })();
    return state.pulling;
  }

  /** The owner replies to a thread. */
  async reply(token: string, thread: string, text: string): Promise<CommentsFrame> {
    return this.post(token, { kind: "reply", thread, text });
  }

  /** The owner resolves a thread for everyone, or reopens it. */
  async resolve(token: string, thread: string, resolved: boolean): Promise<CommentsFrame> {
    return this.post(token, { kind: resolved ? "resolve" : "reopen", thread });
  }

  /** The owner has read a thread up to now. */
  seen(token: string, thread: string): void {
    if (!CommentId.safeParse(thread).success) return;
    const state = this.stateOf(token);
    if (!state.events.some((e) => e.thread === thread)) return;
    state.seen[thread] = this.now().toISOString();
    this.save(token, state);
    this.changed(token);
  }

  private async post(token: string, what: Omit<ShareCommentPost, "author">): Promise<CommentsFrame> {
    const link = this.d.links().find((l) => l.token === token);
    if (!link) throw new CommentError("That link is not one of this computer's.");
    if (!link.live) throw new CommentError("That link has expired, so it takes no more comments.");
    const state = this.stateOf(token);
    if (what.thread && !this.threads(token).some((t) => t.id === what.thread)) await this.pull(token);
    if (what.thread && !this.threads(token).some((t) => t.id === what.thread)) throw new CommentError("That comment is gone.");
    let event: ShareCommentEvent;
    try {
      event = await this.d.client.postComment(token, link.key, { ...what, author: { id: OWNER_AUTHOR_ID, name: this.d.ownerName() } });
    } catch (e) {
      throw new CommentError(e instanceof Error ? e.message : String(e));
    }
    this.add(state, [event]);
    // What the owner answers, they have read.
    state.seen[event.thread] = event.at > (state.seen[event.thread] ?? "") ? event.at : state.seen[event.thread]!;
    this.save(token, state);
    this.changed(token);
    // Fills in anything posted meanwhile, and moves the cursor past this one.
    void this.pull(token);
    return this.frame(token);
  }

  /** Adds events not seen yet; true when any was. */
  private add(state: LinkComments, events: ShareCommentEvent[]): boolean {
    const have = new Set(state.events.map((e) => e.id));
    const fresh = events.filter((e) => !have.has(e.id));
    if (fresh.length === 0) return false;
    state.events = [...state.events, ...fresh].sort((a, b) => (a.cursor < b.cursor ? -1 : a.cursor > b.cursor ? 1 : 0));
    return true;
  }

  private changed(token: string): void {
    this.emit("changed", this.frame(token));
  }

  private pathOf(token: string): string {
    return join(this.d.dir, `${token}.json`);
  }

  private stateOf(token: string): LinkComments {
    let state = this.state.get(token);
    if (!state) {
      state = this.load(token);
      this.state.set(token, state);
    }
    return state;
  }

  private load(token: string): LinkComments {
    const empty: LinkComments = { events: [], seen: {}, pulled: 0 };
    if (!ShareToken.safeParse(token).success) return empty;
    const path = this.pathOf(token);
    if (!existsSync(path)) return empty;
    try {
      const j = JSON.parse(readFileSync(path, "utf8")) as { events?: unknown; cursor?: unknown; seen?: unknown };
      const events = Array.isArray(j.events) ? j.events.flatMap((e) => {
        const parsed = ShareCommentEvent.safeParse(e);
        return parsed.success ? [parsed.data] : [];
      }) : [];
      const seen: Record<string, string> = {};
      if (typeof j.seen === "object" && j.seen !== null) for (const [k, v] of Object.entries(j.seen)) if (typeof v === "string") seen[k] = v;
      return { events, seen, pulled: 0, ...(typeof j.cursor === "string" ? { cursor: j.cursor } : {}) };
    } catch {
      return empty;
    }
  }

  private save(token: string, state: LinkComments): void {
    if (!ShareToken.safeParse(token).success) return;
    try {
      mkdirSync(this.d.dir, { recursive: true, mode: 0o700 });
      const path = this.pathOf(token);
      const temp = `${path}.tmp`;
      writeFileSync(temp, JSON.stringify({ events: state.events, ...(state.cursor ? { cursor: state.cursor } : {}), seen: state.seen }) + "\n", { mode: 0o600 });
      chmodSync(temp, 0o600);
      renameSync(temp, path);
    } catch (e) {
      this.d.log.error("Could not save a link's comments", { link: tokenForLog(token), error: e instanceof Error ? e.message : String(e) });
    }
  }
}
