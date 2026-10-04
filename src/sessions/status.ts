/**
 * Pure status state machine. See PROTOCOL.md "Status meaning".
 * Inputs are events with timestamps; output is the next state. No timers, no I/O.
 */
import type { SessionStatus, StoppedBecause, WaitingFor } from "@grenade/protocol";

export const WORKING_SETTLE_MS = 1500;
export const WAITING_TO_IDLE_MS = 10 * 60 * 1000;
/** A Claude Code turn whose screen has not changed for this long, with no spinner on it, has stopped partway. */
export const STOPPED_QUIET_MS = 30 * 1000;
/** The daemon looks at every session each second; a look this late means the Mac slept in between. */
export const SLEEP_GAP_MS = 30 * 1000;

export interface StatusState {
  status: SessionStatus;
  /** When `status` last changed (ms since epoch). */
  since: number;
  /** When the screen last changed. */
  lastOutputAt: number;
  /** Once a hook has spoken, output heuristics stop driving status. */
  hookDriven: boolean;
  /**
   * Why the session is waiting. Kept while it is `idle` after that, as the reason the user has already
   * seen, and cleared when it works again. The Session shows it only while `waiting`.
   */
  waitingFor?: WaitingFor | undefined;
  /** Why the turn stopped partway, with `waitingFor: "stopped"`. */
  stoppedBecause?: StoppedBecause | undefined;
  /** When the screen was last looked at during this turn, to tell that the Mac slept. */
  lastLookAt?: number | undefined;
  /** The Mac slept during the current turn. Cleared when a turn starts. */
  sleptThisTurn?: boolean | undefined;
  /**
   * The turn ended, but what the agent started in the background still runs (PROTOCOL.md "Background tasks"): the
   * session stays `working` until that is over. Any other hook clears it.
   */
  background?: boolean | undefined;
  /**
   * What a hook-driven session was when a dialog on its screen made it wait (`asks`): no hook says such a dialog is
   * over, so the session goes back to this once the screen no longer shows it (`asked`). Any hook forgets it.
   */
  beforeAsk?: { status: SessionStatus; since: number; waitingFor: WaitingFor | undefined; stoppedBecause: StoppedBecause | undefined } | undefined;
}

export type StatusEvent =
  /**
   * `background`: a turn that ended with tasks still running; only with `working`.
   * `aside`: work that is not the agent's own turn (a tool call inside a subagent, a prompt that was answered); only
   * with `working`. It never starts a turn on a session that has finished, and never ends a background hold.
   */
  | { kind: "hook"; status: SessionStatus; waitingFor?: WaitingFor | undefined; background?: boolean | undefined; aside?: boolean | undefined; at: number }
  /**
   * What is known of the background tasks without a hook: `running: false` ends the hold (the turn is `done`);
   * `running: true` holds a hook-driven session that had just finished, for a screen that showed them a moment late.
   */
  | { kind: "background"; running: boolean; at: number }
  /** `busy`: what the screen says, for an agent whose screen shows it (Claude Code's spinner); absent otherwise. */
  | { kind: "output"; changed: boolean; busy?: boolean | undefined; at: number }
  /**
   * The screen shows a dialog the agent waits on (a Codex startup dialog, PROTOCOL.md "Codex dialogs"): waiting for
   * an answer, without making the session hook-driven, since its hooks may never run.
   */
  | { kind: "asks"; at: number }
  /** That dialog is gone from the screen: a hook-driven session is what it was before it (PROTOCOL.md "Claude Code dialogs"). */
  | { kind: "asked"; at: number }
  | { kind: "seen"; at: number }
  | { kind: "gone"; at: number };

export function initialStatus(at: number): StatusState {
  return { status: "working", since: at, lastOutputAt: at, hookDriven: false };
}

export function reduceStatus(s: StatusState, e: StatusEvent): StatusState {
  if (s.status === "gone") return s;
  switch (e.kind) {
    case "gone":
      return set(s, "gone", e.at);
    case "hook": {
      // A hook knows better than what the session was before a dialog.
      if (s.beforeAsk) s = { ...s, beforeAsk: undefined };
      if (e.aside && e.status === "working") return aside(s.hookDriven ? s : { ...s, hookDriven: true }, e.at);
      const reason = e.waitingFor ?? "done";
      // A question asked while background tasks hold the session leaves the hold in place: answered, it is held again.
      const keepsHold = e.status === "waiting" && reason === "answer";
      const background = e.status === "working" && e.background === true ? true : keepsHold ? s.background : undefined;
      const hooked = s.hookDriven && s.background === background ? s : { ...s, hookDriven: true, background };
      if (e.status !== "waiting") return set(hooked, e.status, e.at);
      if (reason === "stopped") return stop(hooked, "error", e.at);
      // The user has seen this already: a Notification for the prompt a PermissionRequest announced.
      if (hooked.status === "idle" && hooked.waitingFor === reason) return hooked;
      return wait(hooked, reason, e.at);
    }
    case "background":
      if (!e.running) return s.background && s.status === "working" ? wait({ ...s, background: undefined }, "done", e.at) : s;
      if (!s.hookDriven || s.status !== "waiting" || (s.waitingFor ?? "done") !== "done") return s;
      return { ...s, status: "working", since: e.at, waitingFor: undefined, background: true };
    case "asks":
      // Seen already: the same dialog stays up, and the user knows.
      if (s.status === "idle" && s.waitingFor === "answer") return s;
      if (s.status === "waiting" && s.waitingFor === "answer") return s;
      return wait(s.hookDriven ? { ...s, beforeAsk: { status: s.status, since: s.since, waitingFor: s.waitingFor, stoppedBecause: s.stoppedBecause } } : s, "answer", e.at);
    case "asked": {
      const was = s.beforeAsk;
      if (!was) return s;
      const rest = { ...s, beforeAsk: undefined };
      if (s.waitingFor !== "answer" || (s.status !== "waiting" && s.status !== "idle")) return rest;
      // Looked at while the dialog was up: a turn that had finished has been seen too.
      if (s.status === "idle" && was.status === "waiting" && was.waitingFor !== "stopped") return { ...rest, waitingFor: was.waitingFor };
      return { ...rest, status: was.status, since: was.since, waitingFor: was.waitingFor, stoppedBecause: was.stoppedBecause };
    }
    case "seen":
      // A turn that stopped partway is not over because someone looked at it: it waits until the user goes on.
      return s.status === "waiting" && s.waitingFor !== "stopped" ? set(s, "idle", e.at) : s;
    case "output": {
      let next = e.changed ? { ...s, lastOutputAt: e.at } : s;
      // Only a hook-driven turn can stop partway, so only it keeps the time of the last look (to tell the Mac slept).
      if (s.status === "working" && s.hookDriven) {
        const slept = s.lastLookAt !== undefined && e.at - s.lastLookAt >= SLEEP_GAP_MS;
        next = { ...next, lastLookAt: e.at, ...(slept ? { sleptThisTurn: true } : {}) };
      }
      if (!next.hookDriven) {
        if (e.changed && next.status !== "working") next = set(next, "working", e.at);
        else if (!e.changed && next.status === "working" && e.at - next.lastOutputAt >= WORKING_SETTLE_MS) {
          next = wait(next, "done", e.at);
        }
      }
      if (next.hookDriven && next.status === "working" && !next.background && e.busy === false && e.at - next.lastOutputAt >= STOPPED_QUIET_MS) {
        next = stop(next, next.sleptThisTurn ? "sleep" : "quiet", e.at);
      }
      if (next.status === "waiting" && next.waitingFor !== "stopped" && e.at - next.since >= WAITING_TO_IDLE_MS) next = set(next, "idle", e.at);
      return next;
    }
  }
}

/** The reason to show on the Session: only a waiting session has one. */
export function shownWaitingFor(s: StatusState): WaitingFor | undefined {
  return s.status === "waiting" ? (s.waitingFor ?? "done") : undefined;
}

/** The reason a stopped turn shows: only a session waiting with `waitingFor: "stopped"` has one. */
export function shownStoppedBecause(s: StatusState): StoppedBecause | undefined {
  return s.status === "waiting" && s.waitingFor === "stopped" ? s.stoppedBecause : undefined;
}

/** `idle` keeps the reason the session waited for; `working` and `gone` forget it. A new turn forgets that the Mac slept. */
function set(s: StatusState, status: SessionStatus, at: number): StatusState {
  if (status === "waiting") return wait(s, s.waitingFor ?? "done", at);
  const waitingFor = status === "idle" && s.status !== "working" ? s.waitingFor : undefined;
  const turn = status === "working" && s.status !== "working" ? { lastLookAt: undefined, sleptThisTurn: undefined, stoppedBecause: undefined } : {};
  if (s.status === status) return s.waitingFor === waitingFor ? s : { ...s, waitingFor };
  return { ...s, ...turn, status, since: at, waitingFor };
}

/**
 * Work that is not the agent's own turn. A held session stays (or, after a question, is again) held; a session whose
 * turn is over stays over, because no `Stop` would follow; a question that was answered is `working` again.
 */
function aside(s: StatusState, at: number): StatusState {
  if (s.background) return set(s, "working", at);
  const over = s.status === "waiting" ? (s.waitingFor ?? "done") === "done" : s.status === "idle" && s.waitingFor !== "answer";
  return over ? s : set(s, "working", at);
}

/** Stopped partway through a turn, and why. */
function stop(s: StatusState, because: StoppedBecause, at: number): StatusState {
  if (s.status === "waiting" && s.waitingFor === "stopped") return s;
  return { ...s, status: "waiting", since: at, waitingFor: "stopped", stoppedBecause: because };
}

/** Waiting for `reason`. A new reason on a session that waits already counts from now. */
function wait(s: StatusState, reason: WaitingFor, at: number): StatusState {
  if (s.status === "waiting" && (s.waitingFor ?? "done") === reason) return s;
  return { ...s, status: "waiting", since: at, waitingFor: reason };
}
