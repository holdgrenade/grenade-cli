/**
 * Pure rules for when a waiting session becomes a push (PROTOCOL.md "When the daemon pushes").
 * No timers, no I/O: the caller feeds sessions, the clock and whether someone is at the Mac.
 */
import type { Session, WaitingFor } from "@grenade/protocol";

/** How long a session must stay `waiting` before its push goes out: time for a phone that shows it to say `seen`. */
export const PUSH_GRACE_MS = 3000;
/** Input on the Mac within this long means someone is at it. */
export const AT_MAC_MS = 2 * 60 * 1000;
/** An agent without hooks must have been busy this long for its `done` to push. */
export const MIN_BUSY_MS = 30 * 1000;
/** A pause shorter than this, between two stretches of work, is part of the same stretch. */
export const SAME_STRETCH_MS = 10 * 1000;

export interface PendingPush {
  sessionId: string;
  event: WaitingFor;
  /** The `statusSince` of the waiting this push is about. A later waiting is another push. */
  statusSince: string;
  /** Not before this time. */
  dueAt: number;
}

export type PushDecision = "wait" | "hold" | "send" | "drop";

/** A missing `waitingFor` on a waiting session counts as `done`, as it does for clients. */
export function eventOf(session: Session): WaitingFor {
  return session.waitingFor ?? "done";
}

/** True when `next` started waiting, or waits for something else than `previous` did. */
export function startedWaiting(previous: Session | undefined, next: Session): boolean {
  if (next.status !== "waiting") return false;
  if (previous?.status !== "waiting") return true;
  return previous.statusSince !== next.statusSince || eventOf(previous) !== eventOf(next);
}

export function decide(pending: PendingPush, session: Session | undefined, atMac: boolean, now: number): PushDecision {
  if (!session || session.status !== "waiting") return "drop";
  if (session.statusSince !== pending.statusSince || eventOf(session) !== pending.event) return "drop";
  if (now < pending.dueAt) return "wait";
  return atMac ? "hold" : "send";
}

/** Since when a session has been busy, across the short pauses an agent without hooks shows as `waiting`. */
export interface BusyState {
  /** When the current stretch of work began. Null while the session is settled. */
  busySince: number | null;
  /** When it last stopped working. */
  pausedAt: number | null;
}

export const settled: BusyState = { busySince: null, pausedAt: null };

export function trackBusy(state: BusyState, status: Session["status"], now: number): BusyState {
  if (status === "working") {
    const resumed = state.busySince !== null && state.pausedAt !== null && now - state.pausedAt < SAME_STRETCH_MS;
    if (state.busySince !== null && (state.pausedAt === null || resumed)) return { busySince: state.busySince, pausedAt: null };
    return { busySince: now, pausedAt: null };
  }
  if (state.busySince === null || state.pausedAt !== null) return state;
  return { busySince: state.busySince, pausedAt: now };
}

/** How long the stretch of work that just ended was. */
export function busyFor(state: BusyState, now: number): number {
  if (state.busySince === null) return 0;
  return (state.pausedAt ?? now) - state.busySince;
}

/**
 * Whether a session that started waiting is worth a push at all. A question always is. A finished turn is,
 * unless it comes from an agent without hooks that was only busy for a moment (a quick shell command).
 */
export function worthPushing(event: WaitingFor, hookDriven: boolean, busyMs: number): boolean {
  if (event === "answer" || hookDriven) return true;
  return busyMs >= MIN_BUSY_MS;
}
