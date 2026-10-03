/**
 * Pure rules of the Mac board (PROTOCOL.md "Mac board"): a session's board key, and when the board pusher sends
 * an update, an `end` or nothing. No I/O and no clock: callers pass `now`.
 */
import { createHmac } from "node:crypto";
import {
  BOARD_DEBOUNCE_MS,
  BOARD_KEY_MESSAGE,
  BOARD_MIN_INTERVAL_MS,
  BOARD_QUIET_END_MS,
  boardIsActive,
  newlyAsking,
  type BoardState,
} from "@grenade/protocol";

/** First 16 hex characters of HMAC-SHA256(key: utf8(pairing token), message: utf8(BOARD_KEY_MESSAGE ‖ session id)). */
export function boardKey(token: string, sessionId: string): string {
  return createHmac("sha256", token).update(BOARD_KEY_MESSAGE + sessionId, "utf8").digest("hex").slice(0, 16);
}

/** What the pusher remembers of one phone's board between looks. */
export interface BoardTrack {
  /** The last board the push route took: what the phone shows, as far as the daemon knows. */
  sent: BoardState | null;
  /** The last board a push was tried with (taken or not), so a board that failed is not tried again and again. */
  tried: BoardState | null;
  /** When a push was last tried: two are never closer than BOARD_MIN_INTERVAL_MS. */
  triedAt: number | null;
  /** When the board first differed from `tried` (the change not pushed yet), or null. */
  changedAt: number | null;
  /** Since when the board has had nothing but idle sessions (or none), or null while it has more. */
  quietSince: number | null;
  /** One more try of the board that just failed is owed (the route could not be reached). */
  retry: boolean;
}

/** A registration that has pushed nothing yet, the phone showing `board` (it drew it itself when it registered). */
export function newTrack(board: BoardState, now: number): BoardTrack {
  return { sent: board, tried: board, triedAt: null, changedAt: null, quietSince: boardIsActive(board) ? null : now, retry: false };
}

export function sameBoard(a: BoardState | null, b: BoardState | null): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Takes in the board as it is now: notes a change not pushed yet, and since when the board is quiet. */
export function observe(track: BoardTrack, board: BoardState, now: number): BoardTrack {
  const differs = !sameBoard(track.tried, board);
  return {
    ...track,
    changedAt: differs ? (track.changedAt ?? now) : null,
    quietSince: boardIsActive(board) ? null : (track.quietSince ?? now),
    retry: track.retry && !differs,
  };
}

export type BoardStep =
  /** Push the board as it is: `event: "update"`. */
  | { action: "update" }
  /** Push `event: "end"` and forget the registration. */
  | { action: "end" }
  /** Nothing now; look again at `wakeAt` (absent: only a change can make something due). */
  | { action: "none"; wakeAt?: number };

/**
 * What to do now for a board already `observe`d. A change waits BOARD_DEBOUNCE_MS from when it was first seen, so a
 * burst is one push; no two pushes are closer than BOARD_MIN_INTERVAL_MS; a board quiet for BOARD_QUIET_END_MS ends.
 */
export function boardStep(track: BoardTrack, now: number): BoardStep {
  const earliest = track.triedAt === null ? now : track.triedAt + BOARD_MIN_INTERVAL_MS;
  if (track.quietSince !== null) {
    const endAt = Math.max(track.quietSince + BOARD_QUIET_END_MS, earliest);
    if (now >= endAt) return { action: "end" };
    if (track.changedAt === null && !track.retry) return { action: "none", wakeAt: endAt };
  }
  if (track.changedAt === null && !track.retry) return { action: "none" };
  const dueAt = Math.max(track.changedAt === null ? now : track.changedAt + BOARD_DEBOUNCE_MS, earliest);
  return now >= dueAt ? { action: "update" } : { action: "none", wakeAt: dueAt };
}

/** The outcome of a tried push, folded into the track. `retry` owes one more try (once) of the same board. */
export function afterTry(track: BoardTrack, board: BoardState, now: number, outcome: "sent" | "retry" | "failed"): BoardTrack {
  return {
    ...track,
    sent: outcome === "sent" ? board : track.sent,
    tried: board,
    triedAt: now,
    changedAt: null,
    retry: outcome === "retry" && !track.retry,
  };
}

/** A session newly needs an answer since the board last sent: worth an alert, unless someone is at the Mac. */
export function mayAlert(sent: BoardState | null, next: BoardState): boolean {
  return newlyAsking(sent, next).length > 0;
}

/** Whether a board push alerts: `mayAlert`, and nobody at the Mac. Only the alert is held for someone at the Mac, never the push. */
export function boardAlert(sent: BoardState | null, next: BoardState, atMac: boolean): boolean {
  return mayAlert(sent, next) && !atMac;
}
