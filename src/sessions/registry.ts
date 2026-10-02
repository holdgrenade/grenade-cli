/**
 * In-memory registry of Grenade sessions. Owns the Session objects the phone sees,
 * drives the status machine, caches the last screen, and persists session metadata
 * so a restarted daemon re-adopts its `gr-*` tmux sessions.
 */
import { EventEmitter } from "node:events";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";
import type { AgentKind, KeyName, Session, SessionStatus, WaitingFor } from "@grenade/protocol";
import type { HistoryFrame, ScreenFrame } from "../frames.js";
import type { Logger } from "../log.js";
import { expandCwd, isGrenadeSession, lastNonEmptyLine, sessionIdFor, type Screen } from "../tmux/parse.js";
import type { Tmux } from "../tmux/tmux.js";
import { nextHistoryMark, type HistoryMark } from "./historyEpoch.js";
import { defaultGroupFor, isJoinableGroup, membersInOrder, nextOrder, otherMembers, placeAt } from "./groups.js";
import { initialStatus, reduceStatus, shownStoppedBecause, shownWaitingFor, type StatusState } from "./status.js";
import { claudeIsWorking } from "../activity/claudeScreen.js";
import { WIDTH_FLOOR, onRelease, onSweep } from "./widthFloor.js";

export interface RegistryEvents {
  /** A brand-new session (not an adopted one). */
  created: [session: Session];
  updated: [session: Session];
  /**
   * A live session moved to another group, or its group was reordered (`from` equals its group).
   * Emitted once, after `updated` for every member whose group or order changed.
   */
  regrouped: [session: Session, from: string | undefined];
  removed: [sessionId: string];
  screen: [frame: ScreenFrame];
}

interface Record_ {
  session: Session;
  state: StatusState;
  screen: Screen | null;
  hash: string;
  seq: number;
  subscribers: number;
  /** The connection whose `resize` sized the window, if any; released when it gives the width back or the last subscriber leaves. */
  sizedBy: object | null;
  /** Held at `WIDTH_FLOOR` because every Mac terminal on it is narrower (`widthFloor.ts`). */
  floored: boolean;
  /** Epoch of the pane's history indexes (see historyEpoch.ts). Null until the first capture. */
  mark: HistoryMark | null;
  /** The Claude Code transcript the last hook named; saved, so the activity comes back after a restart. */
  transcript: string | undefined;
  /** Claude Code's title for the conversation; beats `guessedTitle` as the session's `title`. */
  aiTitle: string | undefined;
  /** The summarizer's title, used until Claude Code has written one and for other agents. */
  guessedTitle: string | undefined;
}

interface PersistedSession {
  id: string;
  name: string;
  agent: AgentKind;
  cwd: string;
  createdAt: string;
  group?: string | undefined;
  order?: number | undefined;
  summary?: string | undefined;
  aiTitle?: string | undefined;
  guessedTitle?: string | undefined;
  model?: string | undefined;
  transcript?: string | undefined;
  resumedFrom?: string | undefined;
  resumedAt?: string | undefined;
}

export class SessionExistsError extends Error {}
export class UnknownSessionError extends Error {}
/** The requested working directory is not an existing folder. tmux would silently fall back to $HOME. */
export class BadCwdError extends Error {}
/** The group to join has no live session in it. */
export class UnknownGroupError extends Error {}

export interface RegistryOptions {
  tmux: Tmux;
  log: Logger;
  persistPath?: string;
  now?: () => number;
  /** Home folder for `~` expansion. Defaults to os.homedir(). */
  home?: string;
  /** Folder check for new sessions. Defaults to a statSync. */
  isDirectory?: (path: string) => boolean;
  /** Makes a fresh group id. Defaults to `g-` plus 6 random hex digits. */
  newGroupId?: () => string;
}

function isDirectoryOnDisk(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export class SessionRegistry extends EventEmitter<RegistryEvents> {
  private readonly records = new Map<string, Record_>();
  private readonly tmux: Tmux;
  private readonly log: Logger;
  private readonly persistPath: string | undefined;
  private readonly now: () => number;
  private readonly home: string;
  private readonly isDirectory: (path: string) => boolean;
  private readonly newGroupId: () => string;

  constructor(opts: RegistryOptions) {
    super();
    this.tmux = opts.tmux;
    this.log = opts.log;
    this.persistPath = opts.persistPath;
    this.now = opts.now ?? Date.now;
    this.home = opts.home ?? homedir();
    this.isDirectory = opts.isDirectory ?? isDirectoryOnDisk;
    this.newGroupId = opts.newGroupId ?? (() => `g-${randomBytes(3).toString("hex")}`);
  }

  // ---- reading -------------------------------------------------------------

  list(): Session[] {
    return [...this.records.values()].map((r) => r.session);
  }

  get(id: string): Session | undefined {
    return this.records.get(id)?.session;
  }

  screenOf(id: string): ScreenFrame | undefined {
    const r = this.records.get(id);
    return r?.screen ? this.frameFor(r) : undefined;
  }

  /** Ids that at least one client is watching. */
  subscribedIds(): string[] {
    return [...this.records.values()].filter((r) => r.subscribers > 0).map((r) => r.session.id);
  }

  liveIds(): string[] {
    return [...this.records.values()].filter((r) => r.session.status !== "gone").map((r) => r.session.id);
  }

  // ---- lifecycle -----------------------------------------------------------

  /** Re-adopt tmux sessions that already exist (daemon restart). */
  async adopt(): Promise<void> {
    const persisted = this.loadPersisted();
    const live = (await this.tmux.listSessions()).filter(isGrenadeSession);
    const fallbackAt = new Date(this.now()).toISOString();
    // Oldest first, so sessions saved before groups existed fall into their folder's group in a stable order.
    const createdAt = (id: string) => persisted.get(id)?.createdAt ?? fallbackAt;
    for (const id of [...live].sort((a, b) => createdAt(a).localeCompare(createdAt(b)))) {
      if (this.records.has(id)) continue;
      const meta = persisted.get(id);
      const cwd = meta?.cwd ?? "";
      const group = meta?.group ?? defaultGroupFor(cwd, this.list()) ?? this.newGroupId();
      this.add({
        id,
        name: meta?.name ?? id.slice(3),
        agent: meta?.agent ?? "shell",
        cwd,
        createdAt: createdAt(id),
        group,
        order: meta?.order ?? nextOrder(group, this.list()),
        summary: meta?.summary,
        aiTitle: meta?.aiTitle,
        guessedTitle: meta?.guessedTitle,
        model: meta?.model,
        transcript: meta?.transcript,
        resumedFrom: meta?.resumedFrom,
        resumedAt: meta?.resumedAt,
      });
      // Sessions started by an older daemon lack mouse mode and the blank fill; set them like `newSession` does.
      this.tmux.applySessionOptions(id).catch((e) => this.log.debug("Could not set tmux session options", { session: id, error: e }));
    }
    if (live.length > 0) this.log.info(`Picked up ${live.length} running session${live.length === 1 ? "" : "s"}`, { sessions: live.join(",") });
  }

  /** `resume` starts a copy of that Claude Code conversation (PROTOCOL.md "Conversations"); `agent` must be `claude`. */
  async create(input: { name: string; cwd: string; agent: AgentKind; group?: string | undefined; resume?: string | undefined }): Promise<Session> {
    const id = sessionIdFor(input.name);
    const cwd = expandCwd(input.cwd, this.home);
    if (!cwd || !this.isDirectory(cwd)) throw new BadCwdError(`folder not found on the Mac: ${input.cwd}`);
    if (input.group !== undefined && !isJoinableGroup(input.group, this.list(), id)) {
      throw new UnknownGroupError(`no live session in group ${input.group}`);
    }
    if (this.records.get(id)?.session.status !== undefined && this.records.get(id)?.session.status !== "gone") {
      throw new SessionExistsError(`session ${id} already exists`);
    }
    if (await this.tmux.hasSession(id)) throw new SessionExistsError(`tmux session ${id} already exists`);
    await this.tmux.newSession({ id, cwd, agent: input.agent, resume: input.resume });
    this.records.delete(id);
    const others = this.list().filter((s) => s.id !== id);
    const group = input.group ?? defaultGroupFor(cwd, others) ?? this.newGroupId();
    const order = nextOrder(group, others);
    const createdAt = new Date(this.now()).toISOString();
    const resumed = input.resume !== undefined ? { resumedFrom: input.resume, resumedAt: createdAt } : {};
    const session = this.add({ id, name: input.name, agent: input.agent, cwd, createdAt, group, order, ...resumed });
    this.log.info(`Started ${input.agent} session ${id}`, { cwd, group });
    this.emit("created", session);
    return session;
  }

  async kill(id: string): Promise<void> {
    const r = this.require(id);
    if (r.session.status !== "gone") {
      try {
        await this.tmux.killSession(id);
      } catch (e) {
        this.log.warn(`Could not stop tmux session ${id}`, { error: e });
      }
    }
    this.records.delete(id);
    this.persist();
    this.log.info(`Ended session ${id}`);
    this.emit("removed", id);
  }

  /**
   * Moves a live session into `group` (another live session's group), or out into a new group of
   * its own when `group` is null. `index` places it among the group's members (clamped; default
   * last); with its own group and an `index` this reorders the group. Returns the session; a move
   * to where it already is changes nothing.
   */
  setGroup(id: string, group: string | null, index?: number): Session {
    const r = this.require(id);
    if (r.session.status === "gone") throw new UnknownSessionError(`session ${id} has ended`);
    const from = r.session.group;
    if (group === null) {
      if (from !== undefined && otherMembers(from, this.list(), id).length === 0) return r.session;
      r.session = { ...r.session, group: this.newGroupId(), order: 0 };
      this.persist();
      this.log.info(`Moved ${id} into a group of its own`);
      this.emit("updated", r.session);
      this.emit("regrouped", r.session, from);
      return r.session;
    }
    if (group === from && index === undefined) return r.session;
    if (group !== from && !isJoinableGroup(group, this.list(), id)) throw new UnknownGroupError(`no live session in group ${group}`);
    const ids = membersInOrder(group, this.list()).map((s) => s.id);
    const placed = placeAt(ids, id, index ?? ids.length);
    const changed: Record_[] = [];
    placed.forEach((memberId, order) => {
      const m = this.records.get(memberId);
      if (!m || (m.session.group === group && m.session.order === order)) return;
      m.session = { ...m.session, group, order };
      changed.push(m);
    });
    if (changed.length === 0) return r.session;
    this.persist();
    this.log.info(group === from ? `Reordered group ${group}` : `Moved ${id} into group ${group}`, { order: placed.join(",") });
    for (const m of changed) this.emit("updated", m.session);
    this.emit("regrouped", r.session, from);
    return r.session;
  }

  markGone(id: string): void {
    const r = this.records.get(id);
    if (!r || r.session.status === "gone") return;
    this.setState(r, reduceStatus(r.state, { kind: "gone", at: this.now() }));
  }

  // ---- input ---------------------------------------------------------------

  async sendText(id: string, text: string, submit: boolean): Promise<void> {
    this.require(id);
    await this.tmux.sendText(id, text, submit);
  }

  async sendKey(id: string, key: KeyName): Promise<void> {
    this.require(id);
    await this.tmux.sendKey(id, key);
  }

  /** `by` is the connection that asked, so a later `releaseSize` from it undoes only its own width. */
  async resize(id: string, cols: number, rows: number | undefined, by: object): Promise<void> {
    const r = this.require(id);
    await this.tmux.resize(id, cols, rows);
    r.sizedBy = by;
    r.floored = false;
  }

  /** `resize` with `cols: null`: the window fits the Mac terminals again, unless another client has sized it since. */
  async releaseSize(id: string, by: object): Promise<void> {
    const r = this.require(id);
    if (r.sizedBy !== by) return;
    r.sizedBy = null;
    await this.giveWidthBack(id, r);
  }

  /** The window fits the Mac terminals again, or the floor when they are all narrower (`widthFloor.ts`). */
  private async giveWidthBack(id: string, r: Record_): Promise<void> {
    const widest = (await this.tmux.windowWidths()).get(id)?.widest ?? null;
    if (r.sizedBy) return; // another client sized it meanwhile
    if (onRelease(widest) === "floor") {
      await this.tmux.resize(id, WIDTH_FLOOR);
      r.floored = true;
    } else {
      await this.tmux.releaseSize(id);
      r.floored = false;
    }
  }

  /** The poller's 1 s sweep: hold windows no Grenade client sizes at the floor while the Mac terminals are narrower. */
  async enforceWidthFloor(): Promise<void> {
    const widths = await this.tmux.windowWidths();
    for (const [id, r] of this.records) {
      const window = widths.get(id);
      if (!window || r.sizedBy || r.session.status === "gone") continue;
      const action = onSweep(window, r.floored);
      if (action === "floor") {
        await this.tmux.resize(id, WIDTH_FLOOR);
        r.floored = true;
        this.log.debug("Held a window at the width floor", { session: id, width: window.width, widest: window.widest });
      } else if (action === "follow") {
        await this.tmux.releaseSize(id);
        r.floored = false;
      }
    }
  }

  /** Scrollback rows before history index `before` (see PROTOCOL.md "Scrollback"). Throws a TmuxError for a gone pane. */
  async history(id: string, before: number, count: number): Promise<HistoryFrame> {
    const r = this.require(id);
    const { rows, geo } = await this.tmux.captureHistory(id, before, count);
    r.mark = nextHistoryMark(r.mark, geo);
    return { type: "history", sessionId: id, epoch: r.mark.epoch, start: rows.start, lines: rows.lines, styled: rows.styled };
  }

  seen(id: string): void {
    const r = this.require(id);
    this.setState(r, reduceStatus(r.state, { kind: "seen", at: this.now() }));
  }

  /** The one-sentence description of what the session is working on (see `Summarizer`). */
  setSummary(id: string, summary: string): void {
    const r = this.records.get(id);
    if (!r || r.session.summary === summary) return;
    r.session = { ...r.session, summary };
    this.persist();
    this.emit("updated", r.session);
  }

  /** Claude Code's title for the session's conversation (`ai-title` in its transcript). */
  setAiTitle(id: string, title: string): void {
    const r = this.records.get(id);
    if (!r || r.aiTitle === title) return;
    r.aiTitle = title;
    this.updateTitle(r);
  }

  /** The summarizer's few-word title; shown only while Claude Code has written none. */
  setGuessedTitle(id: string, title: string): void {
    const r = this.records.get(id);
    if (!r || r.guessedTitle === title) return;
    r.guessedTitle = title;
    this.updateTitle(r);
  }

  private updateTitle(r: Record_): void {
    this.persist();
    const title = r.aiTitle ?? r.guessedTitle;
    if (title === undefined || r.session.title === title) return;
    r.session = { ...r.session, title };
    this.emit("updated", r.session);
  }

  /** The folder the agent works in now (PROTOCOL.md "Session": `cwd` follows the agent). */
  setCwd(id: string, cwd: string): void {
    const r = this.records.get(id);
    if (!r || r.session.cwd === cwd) return;
    r.session = { ...r.session, cwd };
    this.persist();
    this.emit("updated", r.session);
  }

  /** The label of the model the agent last answered with (see `readTranscriptModel`). */
  setModel(id: string, model: string): void {
    const r = this.records.get(id);
    if (!r || r.session.model === model) return;
    r.session = { ...r.session, model };
    this.persist();
    this.emit("updated", r.session);
  }

  /** `waitingFor` says why, for a hook that makes the session wait. */
  applyHook(id: string, status: SessionStatus, waitingFor?: WaitingFor): boolean {
    const r = this.records.get(id);
    if (!r) return false;
    this.setState(r, reduceStatus(r.state, { kind: "hook", status, waitingFor, at: this.now() }));
    return true;
  }

  /** A hook has spoken for this session: its status no longer comes from watching the screen. */
  hookDriven(id: string): boolean {
    return this.records.get(id)?.state.hookDriven ?? false;
  }

  // ---- subscriptions and screens ------------------------------------------

  subscribe(id: string): void {
    this.require(id).subscribers++;
  }

  unsubscribe(id: string): void {
    const r = this.records.get(id);
    if (!r || r.subscribers === 0) return;
    r.subscribers--;
    // Nobody is looking any more: hand the width back to the Mac terminals.
    if (r.subscribers === 0 && r.sizedBy) {
      r.sizedBy = null;
      this.giveWidthBack(id, r).catch((e) => this.log.debug("Could not release the phone width", { session: id, error: e }));
    }
  }

  /** Called by the poller with a fresh capture. Emits `screen` only when content changed. */
  updateScreen(id: string, screen: Screen): boolean {
    const r = this.records.get(id);
    if (!r) return false;
    const before = r.session;
    r.mark = nextHistoryMark(r.mark, screen);
    const hash = createHash("sha1").update(`${r.mark.epoch} ${screen.start}\n${screen.styled.join("\n")}`).digest("hex");
    const changed = hash !== r.hash;
    r.screen = screen;
    if (changed) {
      r.hash = hash;
      r.seq++;
      const lastLine = lastNonEmptyLine(screen.lines);
      if (lastLine !== r.session.lastLine) r.session = { ...r.session, lastLine };
      if (r.subscribers > 0) this.emit("screen", this.frameFor(r));
    }
    // Claude Code's spinner says whether it is still on its turn; other agents' screens say nothing.
    const busy = r.session.agent === "claude" ? claudeIsWorking(screen.lines) : undefined;
    this.setState(r, reduceStatus(r.state, { kind: "output", changed, busy, at: this.now() }), /* emit */ false);
    // Only a real change to the session (status, statusSince or lastLine) is worth a `session.updated`. A screen
    // that changed without touching any of those (an agent's spinner, say) used to send one five times a second,
    // and every phone re-sorted and redrew its whole list for nothing.
    if (before !== r.session) this.emit("updated", r.session);
    return changed;
  }

  /** The transcript a hook named. Not part of the session phones see; only saved. */
  setTranscript(id: string, path: string): void {
    const r = this.records.get(id);
    if (!r || r.transcript === path) return;
    r.transcript = path;
    this.persist();
  }

  /** The transcript a hook named for a session, if any. */
  transcriptOf(id: string): string | undefined {
    return this.records.get(id)?.transcript;
  }

  /** Sessions with a known transcript, to read their activity from (PROTOCOL.md "Activity"). */
  transcripts(): { id: string; path: string }[] {
    return [...this.records.values()].flatMap((r) => (r.transcript ? [{ id: r.session.id, path: r.transcript }] : []));
  }

  // ---- internals -----------------------------------------------------------

  private add(meta: PersistedSession): Session {
    const at = this.now();
    const state = initialStatus(at);
    const session: Session = {
      id: meta.id,
      name: meta.name,
      agent: meta.agent,
      cwd: meta.cwd,
      status: state.status,
      statusSince: new Date(state.since).toISOString(),
      lastLine: "",
      ...((meta.aiTitle ?? meta.guessedTitle) !== undefined ? { title: meta.aiTitle ?? meta.guessedTitle } : {}),
      ...(meta.summary !== undefined ? { summary: meta.summary } : {}),
      ...(meta.model !== undefined ? { model: meta.model } : {}),
      createdAt: meta.createdAt,
      ...(meta.group !== undefined ? { group: meta.group } : {}),
      ...(meta.order !== undefined ? { order: meta.order } : {}),
      ...(meta.resumedFrom !== undefined ? { resumedFrom: meta.resumedFrom } : {}),
      ...(meta.resumedAt !== undefined ? { resumedAt: meta.resumedAt } : {}),
    };
    this.records.set(meta.id, { session, state, screen: null, hash: "", seq: 0, subscribers: 0, sizedBy: null, floored: false, mark: null, transcript: meta.transcript, aiTitle: meta.aiTitle, guessedTitle: meta.guessedTitle });
    this.persist();
    this.emit("updated", session);
    return session;
  }

  private require(id: string): Record_ {
    const r = this.records.get(id);
    if (!r) throw new UnknownSessionError(`no session ${id}`);
    return r;
  }

  private setState(r: Record_, next: StatusState, emit = true): void {
    if (next === r.state) return;
    // A session that waits for something else than before (a question after a finished turn) changed too.
    const changed =
      next.status !== r.state.status || shownWaitingFor(next) !== r.session.waitingFor || shownStoppedBecause(next) !== r.session.stoppedBecause;
    r.state = next;
    if (changed) {
      const { waitingFor: _was, stoppedBecause: _because, ...rest } = r.session;
      const waitingFor = shownWaitingFor(next);
      const stoppedBecause = shownStoppedBecause(next);
      r.session = {
        ...rest,
        status: next.status,
        statusSince: new Date(next.since).toISOString(),
        ...(waitingFor ? { waitingFor } : {}),
        ...(stoppedBecause ? { stoppedBecause } : {}),
      };
      if (emit) this.emit("updated", r.session);
    }
  }

  private frameFor(r: Record_): ScreenFrame {
    const s = r.screen ?? { lines: [], styled: [], cursor: { row: 0, col: 0 }, cols: 1, rows: 1 };
    const history = r.screen && r.mark ? { start: r.screen.start, epoch: r.mark.epoch } : {};
    return { type: "screen", sessionId: r.session.id, seq: r.seq, cols: s.cols, rows: s.rows, lines: s.lines, styled: s.styled, cursor: s.cursor, ...history };
  }

  private loadPersisted(): Map<string, PersistedSession> {
    const map = new Map<string, PersistedSession>();
    if (!this.persistPath || !existsSync(this.persistPath)) return map;
    try {
      const list = JSON.parse(readFileSync(this.persistPath, "utf8")) as PersistedSession[];
      for (const s of list) map.set(s.id, s);
    } catch (e) {
      this.log.warn("Could not read sessions.json; session names and folders may be missing", { error: e });
    }
    return map;
  }

  private persist(): void {
    if (!this.persistPath) return;
    const list: PersistedSession[] = [...this.records.values()]
      .filter((r) => r.session.status !== "gone")
      .map(({ session: s, transcript, aiTitle, guessedTitle }) => ({ id: s.id, name: s.name, agent: s.agent, cwd: s.cwd, createdAt: s.createdAt, group: s.group, order: s.order, summary: s.summary, aiTitle, guessedTitle, model: s.model, transcript, resumedFrom: s.resumedFrom, resumedAt: s.resumedAt }));
    try {
      mkdirSync(dirname(this.persistPath), { recursive: true });
      writeFileSync(this.persistPath, JSON.stringify(list, null, 2) + "\n");
    } catch (e) {
      this.log.warn("Could not save sessions.json", { error: e });
    }
  }
}
