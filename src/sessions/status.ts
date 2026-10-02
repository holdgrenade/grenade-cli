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
}

export type StatusEvent =
  | { kind: "hook"; status: SessionStatus; waitingFor?: WaitingFor | undefined; at: number }
  /** `busy`: what the screen says, for an agent whose screen shows it (Claude Code's spinner); absent otherwise. */
  | { kind: "output"; changed: boolean; busy?: boolean | undefined; at: number }
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
      const hooked = s.hookDriven ? s : { ...s, hookDriven: true };
      if (e.status !== "waiting") return set(hooked, e.status, e.at);
      const reason = e.waitingFor ?? "done";
      if (reason === "stopped") return stop(hooked, "error", e.at);
      // The user has seen this already: a Notification for the prompt a PermissionRequest announced.
      if (hooked.status === "idle" && hooked.waitingFor === reason) return hooked;
      return wait(hooked, reason, e.at);
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
      if (next.hookDriven && next.status === "working" && e.busy === false && e.at - next.lastOutputAt >= STOPPED_QUIET_MS) {
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
