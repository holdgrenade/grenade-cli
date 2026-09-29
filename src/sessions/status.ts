/**
 * Pure status state machine. See PROTOCOL.md "Status meaning".
 * Inputs are events with timestamps; output is the next state. No timers, no I/O.
 */
import type { SessionStatus, WaitingFor } from "@grenade/protocol";

export const WORKING_SETTLE_MS = 1500;
export const WAITING_TO_IDLE_MS = 10 * 60 * 1000;

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
}

export type StatusEvent =
  | { kind: "hook"; status: SessionStatus; waitingFor?: WaitingFor | undefined; at: number }
  | { kind: "output"; changed: boolean; at: number }
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
      // The user has seen this already: a Notification for the prompt a PermissionRequest announced.
      if (hooked.status === "idle" && hooked.waitingFor === reason) return hooked;
      return wait(hooked, reason, e.at);
    }
    case "seen":
      return s.status === "waiting" ? set(s, "idle", e.at) : s;
    case "output": {
      let next = e.changed ? { ...s, lastOutputAt: e.at } : s;
      if (!next.hookDriven) {
        if (e.changed && next.status !== "working") next = set(next, "working", e.at);
        else if (!e.changed && next.status === "working" && e.at - next.lastOutputAt >= WORKING_SETTLE_MS) {
          next = wait(next, "done", e.at);
        }
      }
      if (next.status === "waiting" && e.at - next.since >= WAITING_TO_IDLE_MS) next = set(next, "idle", e.at);
      return next;
    }
  }
}

/** The reason to show on the Session: only a waiting session has one. */
export function shownWaitingFor(s: StatusState): WaitingFor | undefined {
  return s.status === "waiting" ? (s.waitingFor ?? "done") : undefined;
}

/** `idle` keeps the reason the session waited for; `working` and `gone` forget it. */
function set(s: StatusState, status: SessionStatus, at: number): StatusState {
  if (status === "waiting") return wait(s, s.waitingFor ?? "done", at);
  const waitingFor = status === "idle" && s.status !== "working" ? s.waitingFor : undefined;
  if (s.status === status) return s.waitingFor === waitingFor ? s : { ...s, waitingFor };
  return { ...s, status, since: at, waitingFor };
}

/** Waiting for `reason`. A new reason on a session that waits already counts from now. */
function wait(s: StatusState, reason: WaitingFor, at: number): StatusState {
  if (s.status === "waiting" && (s.waitingFor ?? "done") === reason) return s;
  return { ...s, status: "waiting", since: at, waitingFor: reason };
}
