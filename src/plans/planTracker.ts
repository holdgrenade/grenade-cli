/**
 * Plans (PROTOCOL.md "Plans"): what each session's agent is doing with its plan, read from Claude Code's hooks, and its
 * plan file, which clients follow (`plan.subscribe`), edit between the agent's turns (`plan.write`) and build with the
 * user's edits. One per daemon.
 *
 * - `planning` follows the newest hook's `permission_mode`.
 * - The plan file is the `file_path` of a write tool in `~/.claude/plans/`, or `planFilePath` of `ExitPlanMode`.
 * - `writing` is true from the agent's first write to it in a turn until that turn ends or it asks for approval.
 * - The user's edit is remembered until the next thing they say to the agent, which carries `planEditedNote`.
 *
 * The file is looked at every 400 ms while a client follows it, as a canvas is: a poll, so a file that is saved by a
 * rename is seen as readily as one written in place.
 */
import { EventEmitter } from "node:events";
import { lstat, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { PLAN_TEXT_MAX, planEditedNote, type PlanFrame, type SessionPlan } from "@grenade/protocol";

export const PLAN_POLL_MS = 400;

/** Claude Code's tools that write a file, by `file_path`. */
const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit"]);
const PLAN_TOOL = "ExitPlanMode";
/** Hook events that end the agent's turn. */
const TURN_ENDS = new Set(["Stop", "StopFailure", "SessionEnd", "UserPromptSubmit"]);

/** Runs `fn` every `ms` until the returned function is called. Tests pass one they tick by hand. */
export type Every = (fn: () => void, ms: number) => () => void;

const realEvery: Every = (fn, ms) => {
  const timer = setInterval(fn, ms);
  timer.unref?.();
  return () => clearInterval(timer);
};

/** The file system a tracker uses. Tests pass a fake. */
export interface PlanFiles {
  /** The file's text, time and size, or null when it is not a regular file (missing, a link, a folder). */
  read(path: string): Promise<{ text: string; modified: Date; bytes: number } | null>;
  /** Replaces a regular file's text. Rejects when it is not one. */
  write(path: string, text: string): Promise<void>;
}

export const diskPlanFiles: PlanFiles = {
  async read(path) {
    try {
      const info = await lstat(path);
      if (!info.isFile()) return null;
      return { text: await readFile(path, "utf8"), modified: info.mtime, bytes: info.size };
    } catch {
      return null;
    }
  },
  async write(path, text) {
    const info = await lstat(path);
    if (!info.isFile()) throw new Error("not a regular file");
    await writeFile(path, text, "utf8");
  },
};

/** Why `write` refused, in a sentence for the user. */
export class PlanWriteError extends Error {}

interface SessionState {
  path: string | undefined;
  planning: boolean;
  writing: boolean;
  /** The agent wrote the plan in the turn it is in. */
  wroteThisTurn: boolean;
  /** The user changed the plan after the agent last wrote it; the agent has not been told. */
  editedByUser: boolean;
  by: "agent" | "user";
}

interface Follower {
  send(frame: PlanFrame): void;
  /** The `modified` and size of the last frame it got. */
  last: string;
}

interface Watched {
  followers: Set<Follower>;
  stop: () => void;
  busy: boolean;
}

export interface PlanTrackerEvents {
  /** A session's `SessionPlan` changed (or went: undefined). */
  plan: [sessionId: string, plan: SessionPlan | undefined];
}

/** The slice of a Claude Code hook payload a tracker reads. */
export interface PlanHook {
  hook_event_name?: unknown;
  permission_mode?: unknown;
  tool_name?: unknown;
  tool_input?: unknown;
}

export class PlanTracker extends EventEmitter<PlanTrackerEvents> {
  private readonly sessions = new Map<string, SessionState>();
  private readonly watched = new Map<string, Watched>();
  private readonly plansFolder: string;

  /** `claudeDir` is Claude Code's folder (`~/.claude`), whose `plans` the agent writes in; `home` names paths with `~`. */
  constructor(
    private readonly files: PlanFiles = diskPlanFiles,
    claudeDir: string = join(homedir(), ".claude"),
    private readonly home: string = homedir(),
    private readonly every: Every = realEvery,
  ) {
    super();
    this.plansFolder = join(resolve(claudeDir), "plans");
  }

  /** What `Session.plan` says now, or undefined while the session has never been in plan mode. */
  planOf(sessionId: string): SessionPlan | undefined {
    const s = this.sessions.get(sessionId);
    return s ? shown(s) : undefined;
  }

  /** The plan file a restarted daemon saved for a session. */
  restore(sessionId: string, path: string): void {
    if (!this.inPlansFolder(path)) return;
    this.change(sessionId, (s) => ({ ...s, path }));
  }

  /** The plan file of a session, to save. */
  pathOf(sessionId: string): string | undefined {
    return this.sessions.get(sessionId)?.path;
  }

  /** A Claude Code hook of the session (`/hooks/claude` and the prompt hook alike). */
  hook(sessionId: string, payload: PlanHook): void {
    const event = typeof payload.hook_event_name === "string" ? payload.hook_event_name : "";
    const mode = typeof payload.permission_mode === "string" ? payload.permission_mode : undefined;
    const tool = typeof payload.tool_name === "string" ? payload.tool_name : undefined;
    const input = typeof payload.tool_input === "object" && payload.tool_input !== null ? (payload.tool_input as Record<string, unknown>) : {};
    const known = this.sessions.get(sessionId);
    // A session that has never planned has nothing to track until it does.
    if (!known && mode !== "plan") return;
    this.change(sessionId, (s) => {
      let next = mode === undefined ? s : { ...s, planning: mode === "plan" };
      const file = typeof input.file_path === "string" ? resolve(input.file_path) : undefined;
      if (tool && WRITE_TOOLS.has(tool) && file && this.inPlansFolder(file)) {
        // The agent's own write: what it is told after the user's edit is no longer news.
        next = { ...next, path: file, wroteThisTurn: true, writing: event === "PreToolUse" || next.writing, editedByUser: false, by: "agent" };
      }
      if (event === "PermissionRequest" && tool === PLAN_TOOL) {
        const planFile = typeof input.planFilePath === "string" ? resolve(input.planFilePath) : undefined;
        next = { ...next, writing: false, ...(planFile && this.inPlansFolder(planFile) ? { path: planFile } : {}) };
      }
      if (TURN_ENDS.has(event)) next = { ...next, writing: false, wroteThisTurn: false };
      return next;
    });
  }

  /** The session's agent was switched into plan mode (`session.mode`): it plans, before the next hook says so. */
  enteredPlanMode(sessionId: string): void {
    this.change(sessionId, (s) => ({ ...s, planning: true }));
  }

  /** The session stopped working without a hook saying so (an interrupt): its turn is over. */
  turnOver(sessionId: string): void {
    if (this.sessions.get(sessionId)?.writing) this.change(sessionId, (s) => ({ ...s, writing: false, wroteThisTurn: false }));
  }

  /** The session ended: forget it. */
  forget(sessionId: string): void {
    if (!this.sessions.delete(sessionId)) return;
    this.emit("plan", sessionId, undefined);
  }

  /**
   * The sentence to add after what the user says next to the agent, when they changed its plan since it last wrote it.
   * Forgotten once taken.
   */
  takeEditedNote(sessionId: string): string | undefined {
    const path = this.takeEditedPath(sessionId);
    return path === undefined ? undefined : planEditedNote(path);
  }

  /** As `takeEditedNote`, the plan file's path alone (`~/.claude/plans/x.md`), for a plan sent back. */
  takeEditedPath(sessionId: string): string | undefined {
    const s = this.sessions.get(sessionId);
    if (!s?.editedByUser || !s.path) return undefined;
    s.editedByUser = false;
    return tildePath(s.path, this.home);
  }

  /** The plan as its file holds it now, for a plan approved with the user's edits. */
  async textOf(sessionId: string): Promise<string | undefined> {
    const path = this.sessions.get(sessionId)?.path;
    if (!path) return undefined;
    return (await this.files.read(path))?.text;
  }

  /** The user's version of the plan. Rejects with `PlanWriteError` while the agent writes it or there is no file. */
  async write(sessionId: string, text: string): Promise<PlanFrame> {
    const s = this.sessions.get(sessionId);
    if (!s?.path) throw new PlanWriteError("This session has no plan to edit yet.");
    if (s.writing) throw new PlanWriteError("Claude is writing the plan. Edit it once it's done.");
    try {
      await this.files.write(s.path, text);
    } catch {
      throw new PlanWriteError("The plan file could not be saved.");
    }
    s.editedByUser = true;
    s.by = "user";
    const frame = await this.frameFor(sessionId);
    if (!frame) throw new PlanWriteError("The plan file could not be read back.");
    // Every follower hears of it now, not on the next look.
    const watched = this.watched.get(sessionId);
    if (watched) for (const f of watched.followers) this.deliver(f, frame);
    return frame;
  }

  /**
   * Starts telling `send` the plan: at once when there is a file, and again whenever it changes. Returns how to stop.
   */
  follow(sessionId: string, send: (frame: PlanFrame) => void): () => void {
    let w = this.watched.get(sessionId);
    if (!w) {
      const created: Watched = { followers: new Set(), busy: false, stop: () => {} };
      created.stop = this.every(() => void this.look(sessionId, created), PLAN_POLL_MS);
      this.watched.set(sessionId, created);
      w = created;
    }
    const follower: Follower = { send, last: "" };
    w.followers.add(follower);
    void this.frameFor(sessionId).then((frame) => {
      if (frame && w.followers.has(follower)) this.deliver(follower, frame);
    });
    const watched = w;
    return () => {
      watched.followers.delete(follower);
      if (watched.followers.size === 0 && this.watched.get(sessionId) === watched) {
        watched.stop();
        this.watched.delete(sessionId);
      }
    };
  }

  /** The `plan` frame for the session's file now, or null when it has none (yet). */
  async frameFor(sessionId: string): Promise<PlanFrame | null> {
    const s = this.sessions.get(sessionId);
    if (!s?.path) return null;
    const file = await this.files.read(s.path);
    if (!file) return null;
    return {
      type: "plan",
      sessionId,
      file: basename(s.path),
      folder: dirname(s.path),
      text: file.text.length <= PLAN_TEXT_MAX ? file.text : file.text.slice(0, PLAN_TEXT_MAX),
      modified: file.modified.toISOString(),
      by: s.by,
      writing: s.writing,
    };
  }

  private async look(sessionId: string, w: Watched): Promise<void> {
    if (w.busy) return;
    w.busy = true;
    try {
      const frame = await this.frameFor(sessionId);
      if (frame) for (const f of w.followers) this.deliver(f, frame);
    } finally {
      w.busy = false;
    }
  }

  /** Sends a follower the frame unless it has it already (same time, size and lock). */
  private deliver(f: Follower, frame: PlanFrame): void {
    const key = `${frame.modified}\n${frame.text.length}\n${frame.writing}\n${frame.by}\n${frame.id ?? ""}`;
    if (key === f.last) return;
    f.last = key;
    f.send(frame);
  }

  private change(sessionId: string, update: (s: SessionState) => SessionState): void {
    const before = this.sessions.get(sessionId) ?? { path: undefined, planning: false, writing: false, wroteThisTurn: false, editedByUser: false, by: "agent" as const };
    const after = update(before);
    this.sessions.set(sessionId, after);
    const was = shown(before);
    const now = shown(after);
    if (was.file !== now.file || was.planning !== now.planning || was.writing !== now.writing) {
      this.emit("plan", sessionId, now);
      // The lock is part of the frame: followers hear when it lifts.
      if (was.writing !== now.writing) {
        const w = this.watched.get(sessionId);
        if (w) void this.look(sessionId, w);
      }
    }
  }

  private inPlansFolder(path: string): boolean {
    const file = resolve(path);
    return dirname(file) === this.plansFolder && file.endsWith(".md") && !basename(file).startsWith(".");
  }
}

function shown(s: SessionState): SessionPlan {
  return { ...(s.path ? { file: basename(s.path) } : {}), planning: s.planning, writing: s.writing };
}

/** `path` with the home folder written `~`, as the agent itself would name it. */
function tildePath(path: string, home: string): string {
  return path.startsWith(home + sep) ? "~" + path.slice(home.length) : path;
}

/**
 * Tells `onChange` whenever the file at `path` is saved (its time or size changed), looking every 400 ms: what a
 * published plan follows (PROTOCOL.md "Publishing", plans). Returns how to stop.
 */
export function watchPlanFile(path: string, onChange: () => void, every: Every = realEvery): () => void {
  let last: string | undefined;
  let busy = false;
  return every(() => {
    if (busy) return;
    busy = true;
    lstat(path)
      .then((info) => `${info.mtimeMs}\n${info.size}`)
      .catch(() => "gone")
      .then((key) => {
        if (last !== undefined && key !== last) onChange();
        last = key;
      })
      .finally(() => {
        busy = false;
      });
  }, PLAN_POLL_MS);
}
