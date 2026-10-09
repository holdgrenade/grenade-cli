/**
 * Every session's `Session.changes` (PROTOCOL.md "Changes"): read when a session starts, after its agent's hooks
 * (debounced), after a push and every 10 s; the `changes` and `changes.diff` replies; `git.push`; and a `push`
 * activity entry whenever commits that were waiting reach their upstream, whoever pushed them.
 */
import { canPush, PUSH_COMMITS_MAX, type ActivityEntry, type ChangesDiffFrame, type ChangesFrame, type SessionChanges } from "@grenade/protocol";
import type { Logger } from "../log.js";
import { pushText } from "./gitParse.js";
import * as git from "./git.js";

/** A `changes`, `changes.diff` or `git.push` the daemon cannot answer: sent as `bad_frame` with this message. */
export class ChangesError extends Error {}

/** What the tracker needs of the session registry. */
export interface ChangesRegistryPort {
  liveIds(): string[];
  get(id: string): { cwd: string } | undefined;
  setChanges(id: string, changes: SessionChanges | undefined): void;
  gitBaseOf(id: string): string | undefined;
  setGitBase(id: string, head: string): void;
}

/** Where push cards go. */
export interface ChangesActivityPort {
  notePush(id: string, entry: ActivityEntry): void;
}

/** What git does; `git.ts` unless a test hands in another. */
export type GitPort = Pick<typeof git, "readSnapshot" | "readFiles" | "readCommits" | "readCommitFiles" | "readDiff" | "pushBranch" | "upstreamHas" | "topOf">;

export interface ChangesTrackerOptions {
  registry: ChangesRegistryPort;
  activity: ChangesActivityPort;
  log: Logger;
  git?: GitPort;
  now?: () => number;
  /** How long after a hook the folder is read (hooks come in bursts). */
  hookDelayMs?: number;
  /** How often every live session is read, for changes made outside the agent. */
  sweepMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
}

interface Track {
  /** The commits that were waiting for an upstream at the last read; undefined before the first. */
  waiting: { hash: string; subject: string }[] | undefined;
  upstream: string | undefined;
  changes: SessionChanges | undefined;
  pushing: boolean;
  reading: Promise<void> | undefined;
  again: boolean;
  timer: unknown;
}

export class ChangesTracker {
  private readonly tracks = new Map<string, Track>();
  private readonly git: GitPort;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (t: unknown) => void;
  private sweep: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly o: ChangesTrackerOptions) {
    this.git = o.git ?? git;
    this.now = o.now ?? Date.now;
    this.setTimer = o.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = o.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
  }

  /** Reads every live session now, then every `sweepMs`. */
  start(): void {
    for (const id of this.o.registry.liveIds()) void this.refresh(id);
    this.sweep = setInterval(() => {
      for (const id of this.o.registry.liveIds()) void this.refresh(id);
    }, this.o.sweepMs ?? 10_000);
    this.sweep.unref?.();
  }

  stop(): void {
    if (this.sweep) clearInterval(this.sweep);
    for (const t of this.tracks.values()) if (t.timer) this.clearTimer(t.timer);
    this.tracks.clear();
  }

  /** A hook of the session's agent came in: read its folder a moment later. */
  noteHook(id: string): void {
    const t = this.track(id);
    if (t.timer) this.clearTimer(t.timer);
    t.timer = this.setTimer(() => {
      t.timer = undefined;
      void this.refresh(id);
    }, this.o.hookDelayMs ?? 500);
  }

  /** The session is gone. */
  forget(id: string): void {
    const t = this.tracks.get(id);
    if (t?.timer) this.clearTimer(t.timer);
    this.tracks.delete(id);
  }

  /** Reads the session's folder and sends what changed; one read at a time per session, the last request wins. */
  refresh(id: string): Promise<void> {
    const t = this.track(id);
    if (t.reading) {
      t.again = true;
      return t.reading;
    }
    t.reading = (async () => {
      do {
        t.again = false;
        await this.read(id, t).catch((e) => this.o.log.debug("Could not read git changes", { session: id, error: e }));
      } while (t.again);
      t.reading = undefined;
    })();
    return t.reading;
  }

  /** Reply to `changes`. */
  async files(id: string, commit: string | undefined): Promise<ChangesFrame> {
    const cwd = this.cwdOf(id);
    if (commit) {
      const top = await this.git.topOf(cwd);
      if (!top) throw new ChangesError("This session's folder is not in a git repository.");
      const files = await this.git.readCommitFiles(top, commit);
      if (!files) throw new ChangesError("This repository has no such commit.");
      return { type: "changes", sessionId: id, commit, files };
    }
    const read = await this.git.readFiles(cwd);
    if (!read) throw new ChangesError("This session's folder is not in a git repository.");
    const commits = await this.git.readCommits(read.top, this.o.registry.gitBaseOf(id), this.track(id).upstream);
    return { type: "changes", sessionId: id, files: read.files, commits, ...(read.truncated ? { truncated: true as const } : {}) };
  }

  /** Reply to `changes.diff`. */
  async diff(id: string, path: string, commit: string | undefined): Promise<ChangesDiffFrame> {
    const top = await this.git.topOf(this.cwdOf(id));
    if (!top) throw new ChangesError("This session's folder is not in a git repository.");
    const d = await this.git.readDiff(top, path, commit);
    if (!d) throw new ChangesError("git could not show that file's changes.");
    return { type: "changes.diff", sessionId: id, path, ...(commit ? { commit } : {}), lines: d.lines, ...(d.binary ? { binary: true as const } : {}), ...(d.tooLong ? { tooLong: true as const } : {}) };
  }

  /**
   * `git.push`: pushes the session's branch. Resolves once git is done; a failure is a `push` entry, not an error.
   * Throws `ChangesError` when there is nothing to push.
   */
  async push(id: string): Promise<void> {
    const t = this.track(id);
    await this.refresh(id);
    const before = t.changes;
    if (t.pushing || !canPush(before) || !before) throw new ChangesError("There is nothing to push.");
    const top = await this.git.topOf(this.cwdOf(id));
    if (!top) throw new ChangesError("This session's folder is not in a git repository.");
    t.pushing = true;
    this.show(id, t);
    this.o.log.info("Pushing a session's branch", { session: id, upstream: before.upstream ?? `${before.remote}/${before.branch}` });
    let outcome: git.PushOutcome;
    try {
      outcome = await this.git.pushBranch(top, before);
    } finally {
      t.pushing = false;
    }
    if (!outcome.ok) {
      this.o.log.info("Push failed", { session: id, failed: outcome.failed });
      const upstream = before.upstream ?? (before.remote && before.branch ? `${before.remote}/${before.branch}` : undefined);
      this.o.activity.notePush(id, {
        kind: "push",
        text: pushText({ upstream, failed: outcome.failed, detail: outcome.detail }),
        at: new Date(this.now()).toISOString(),
        ...(upstream ? { upstream } : {}),
        failed: outcome.failed,
      });
    }
    // The read after a push sees the commits reach the upstream and adds the card.
    await this.refresh(id);
    this.show(id, t);
  }

  private async read(id: string, t: Track): Promise<void> {
    const session = this.o.registry.get(id);
    if (!session) return;
    let base = this.o.registry.gitBaseOf(id);
    let snap = await this.git.readSnapshot(session.cwd, base);
    if (snap && !base && snap.head) {
      // The first read of a session: its commits are the ones made from here on.
      this.o.registry.setGitBase(id, snap.head);
      base = snap.head;
      snap = await this.git.readSnapshot(session.cwd, base);
    }
    if (!this.tracks.has(id)) return;
    const was = t.waiting;
    t.changes = snap?.changes;
    t.upstream = snap?.changes.upstream;
    t.waiting = snap?.waiting ?? [];
    this.show(id, t);
    if (snap && was && snap.changes.upstream) await this.notePushed(id, snap.top, snap.changes.upstream, was, t.waiting);
  }

  /** Commits that were waiting and now are on the upstream were pushed: one card for them. */
  private async notePushed(id: string, top: string, upstream: string, was: Track["waiting"] & {}, now: Track["waiting"] & {}): Promise<void> {
    const still = new Set(now.map((c) => c.hash));
    const gone = was.filter((c) => !still.has(c.hash));
    if (gone.length === 0) return;
    const pushed: { hash: string; subject: string }[] = [];
    for (const c of gone) if (await this.git.upstreamHas(top, upstream, c.hash)) pushed.push(c);
    if (pushed.length === 0) return;
    this.o.log.info("A session's commits reached their upstream", { session: id, upstream, commits: pushed.length });
    this.o.activity.notePush(id, {
      kind: "push",
      text: pushText({ upstream, commits: pushed.length }),
      at: new Date(this.now()).toISOString(),
      upstream,
      commits: pushed.slice(0, PUSH_COMMITS_MAX).map((c) => ({ hash: c.hash.slice(0, 7), subject: c.subject.slice(0, 200) })),
    });
  }

  private show(id: string, t: Track): void {
    const shown = t.changes && t.pushing ? { ...t.changes, pushing: true as const } : t.changes;
    this.o.registry.setChanges(id, shown);
  }

  private cwdOf(id: string): string {
    const s = this.o.registry.get(id);
    if (!s) throw new ChangesError(`no session ${id}`);
    return s.cwd;
  }

  private track(id: string): Track {
    let t = this.tracks.get(id);
    if (!t) {
      t = { waiting: undefined, upstream: undefined, changes: undefined, pushing: false, reading: undefined, again: false, timer: undefined };
      this.tracks.set(id, t);
    }
    return t;
  }
}
