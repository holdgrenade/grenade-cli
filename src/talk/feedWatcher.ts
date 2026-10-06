/**
 * FeedWatcher: writes the feed's rows (PROTOCOL.md "Talk by text", "The feed") from what the daemon already sees: a
 * hook's prompt (`asked`), the registry's status changes, a Talk `sent` or `started` (`sentTo`). Every rule is in
 * `talkFeed.ts`; this holds the timers (a waiting settles before it is a row, a `finished` waits for its reply) and
 * what it remembers per session: the previous Session, when its turn started, when Talk last sent to it.
 */
import type { ActivityEntry, Session, TalkEntry } from "@grenade/protocol";
import { REPLY_WAIT_MS, SETTLE_MS, feedText, finishedText, freshReply, repeatsLast, stillWaiting, waitingKind, workingText } from "./talkFeed.js";
import { headingOf } from "./talkSessions.js";
import type { NewTalkEntry } from "./talkThread.js";

/** How often a `finished` looks again for the turn's reply. */
export const REPLY_POLL_MS = 400;

export interface FeedDeps {
  registry: {
    list(): Session[];
    get(id: string): Session | undefined;
    on(event: "updated", cb: (s: Session) => void): unknown;
    off(event: "updated", cb: (s: Session) => void): unknown;
  };
  entriesOf(id: string): ActivityEntry[];
  /** One line that says what the session's open prompt asks, if it has one. */
  askingOf(id: string): string | undefined;
  /** Agents with `activity`: only their sessions are in the feed. */
  hasActivity(kind: string): boolean;
  /** The session's last row that says where its turns stand. */
  lastRow(id: string): TalkEntry | undefined;
  append(row: NewTalkEntry): void;
  now(): number;
}

export class FeedWatcher {
  private readonly previous = new Map<string, Session>();
  private readonly turnStart = new Map<string, number>();
  private readonly lastSent = new Map<string, number>();
  private readonly pending = new Map<string, NodeJS.Timeout>();
  private readonly onUpdated = (s: Session) => this.observe(s);

  constructor(private readonly d: FeedDeps) {
    for (const s of d.registry.list()) this.previous.set(s.id, s);
    d.registry.on("updated", this.onUpdated);
  }

  stop(): void {
    this.d.registry.off("updated", this.onUpdated);
    for (const t of this.pending.values()) clearTimeout(t);
    this.pending.clear();
  }

  /** A hook's prompt: the session starts a turn. */
  asked(id: string, prompt: string): void {
    const session = this.d.registry.get(id);
    if (!session || !this.d.hasActivity(session.agent)) return;
    const now = this.d.now();
    this.turnStart.set(id, now);
    this.cancel(id);
    const text = workingText(prompt, this.lastSent.get(id), now);
    if (text === null || repeatsLast(this.d.lastRow(id), "working", text)) return;
    this.d.append({ kind: "working", text, session: id, title: headingOf(session) });
  }

  /** The thread sent a prompt to the session, or started it with one: that turn writes no `working` row. */
  sentTo(id: string): void {
    const now = this.d.now();
    this.lastSent.set(id, now);
    this.turnStart.set(id, now);
  }

  private observe(next: Session): void {
    const previous = this.previous.get(next.id);
    this.previous.set(next.id, next);
    if (next.status === "gone") {
      this.cancel(next.id);
      this.turnStart.delete(next.id);
      return;
    }
    if (!this.d.hasActivity(next.agent)) return;
    const kind = waitingKind(previous, next);
    if (!kind) return;
    this.cancel(next.id);
    this.later(next.id, SETTLE_MS, () => (kind === "needsYou" ? this.needsYou(next) : this.finished(next, this.d.now() + REPLY_WAIT_MS)));
  }

  private needsYou(decided: Session): void {
    const current = this.d.registry.get(decided.id);
    if (!stillWaiting(decided, current)) return;
    const text = feedText(this.d.askingOf(decided.id) ?? "");
    if (repeatsLast(this.d.lastRow(decided.id), "needsYou", text)) return;
    this.d.append({ kind: "needsYou", text, session: decided.id, title: headingOf(current!) });
  }

  private finished(decided: Session, deadline: number): void {
    const current = this.d.registry.get(decided.id);
    if (!stillWaiting(decided, current)) return;
    // A turn this daemon did not see start (one it picked up after a restart) writes nothing.
    const start = this.turnStart.get(decided.id);
    if (start === undefined) return;
    const reply = freshReply(this.d.entriesOf(decided.id), start);
    if (reply === undefined && this.d.now() < deadline) return this.later(decided.id, REPLY_POLL_MS, () => this.finished(decided, deadline));
    this.turnStart.delete(decided.id);
    const text = finishedText(reply, current!.summary);
    if (repeatsLast(this.d.lastRow(decided.id), "finished", text)) return;
    this.d.append({ kind: "finished", text, session: decided.id, title: headingOf(current!) });
  }

  private later(id: string, ms: number, run: () => void): void {
    const timer = setTimeout(() => {
      this.pending.delete(id);
      run();
    }, ms);
    timer.unref?.();
    this.pending.set(id, timer);
  }

  private cancel(id: string): void {
    const timer = this.pending.get(id);
    if (timer) clearTimeout(timer);
    this.pending.delete(id);
  }
}
