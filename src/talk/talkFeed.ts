/**
 * The feed (PROTOCOL.md "Talk by text", "The feed"): which `working`, `needsYou` or `finished` row a session's change
 * makes, for every session of an agent with `activity`, from its own status and words, never from the Talk agent and
 * at no model's cost. Pure, tested; `feedWatcher.ts` feeds it the changes and writes the rows.
 *
 * - `working`: a turn starts (the hook's prompt, `UserPromptSubmit`). Not for a turn the thread itself started with a
 *   `sent` row (a prompt within `SENT_TURN_MS` of a send to that session), nor for a slash command or a prompt the
 *   agent wrote itself (`<task-notification>`): those still start a turn, so its `finished` follows.
 * - `needsYou`: the push rule (`startedWaiting`, answer or stopped), once it held `SETTLE_MS`; `text` is what the open
 *   prompt asks. Not again while the same question is the session's last feed row.
 * - `finished`: the push rule's `done`, once it held, for a turn this daemon saw start; `text` is the start of the
 *   reply the turn wrote, waited for up to `REPLY_WAIT_MS` (the transcript can lag the Stop), else the session's
 *   summary, else empty. A daemon that restarts sees no turn start, so it writes no `finished` for what it picks up.
 * One row per real change: a status that flickers and comes back writes nothing, and a row that repeats the
 * session's last feed row is not written again.
 */
import { TALK_FEED_TEXT_MAX, type ActivityEntry, type Session, type TalkEntry } from "@grenade/protocol";
import { eventOf, startedWaiting } from "../push/pushPolicy.js";

/** The feed's kinds. */
export const FEED_KINDS: ReadonlySet<string> = new Set(["working", "needsYou", "finished"]);
/** A turn that starts this soon after a `sent` to the session is that send's turn: no `working` row. */
export const SENT_TURN_MS = 15_000;
/** How long a waiting must hold before it is a row: a status that flickers back writes nothing. */
export const SETTLE_MS = 1_500;
/** How long a `finished` waits for the turn's reply to be read from the transcript. */
export const REPLY_WAIT_MS = 6_000;
/** Transcript times and the daemon's clock may differ a little. */
export const CLOCK_SLACK_MS = 2_000;

/** Text as a feed row carries it: whitespace folded to single spaces, at most `TALK_FEED_TEXT_MAX`, cut with "…". */
export function feedText(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > TALK_FEED_TEXT_MAX ? `${line.slice(0, TALK_FEED_TEXT_MAX - 1)}…` : line;
}

/** Whether a hook's prompt is the owner's words, worth a `working` row: not a slash command, not text the agent wrote itself. */
export function isOwnersPrompt(prompt: string): boolean {
  const t = prompt.trimStart();
  return t.length > 0 && !t.startsWith("/") && !t.startsWith("<");
}

/** The `working` row's text for a turn's prompt, or null when it makes none. */
export function workingText(prompt: string, lastSentAt: number | undefined, now: number): string | null {
  if (!isOwnersPrompt(prompt)) return null;
  if (lastSentAt !== undefined && now - lastSentAt >= 0 && now - lastSentAt < SENT_TURN_MS) return null;
  const text = feedText(prompt);
  return text || null;
}

/** The waiting a change starts, as a feed kind, or null. The push rule. */
export function waitingKind(previous: Session | undefined, next: Session): "needsYou" | "finished" | null {
  if (!startedWaiting(previous, next)) return null;
  return eventOf(next) === "answer" ? "needsYou" : "finished";
}

/** Whether the session still waits as it did when the row was decided: what a settle checks. */
export function stillWaiting(decided: Session, now: Session | undefined): boolean {
  return now !== undefined && now.status === "waiting" && now.statusSince === decided.statusSince && eventOf(now) === eventOf(decided);
}

/** The newest reply the agent wrote since `since` (ms), or undefined while the transcript has none yet. */
export function freshReply(entries: readonly ActivityEntry[], since: number): string | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]!;
    if (Date.parse(e.at) < since - CLOCK_SLACK_MS) return undefined;
    if (e.kind === "said") return e.text;
    // The turn's prompt: anything older is an earlier turn's.
    if (e.kind === "asked") return undefined;
  }
  return undefined;
}

/** A `finished` row's text: the reply, else the summary, else empty. */
export function finishedText(reply: string | undefined, summary: string | undefined): string {
  return feedText(reply ?? summary ?? "");
}

/** Whether a row would only repeat the session's last feed row. */
export function repeatsLast(last: Pick<TalkEntry, "kind" | "text"> | undefined, kind: string, text: string): boolean {
  return last !== undefined && last.kind === kind && last.text === text;
}

/** Each session's last row that says where its turns stand (feed rows and `sent` / `started`), from a day's rows. */
export function lastRowsBySession(entries: readonly TalkEntry[]): Map<string, TalkEntry> {
  const last = new Map<string, TalkEntry>();
  for (const e of entries) {
    if (e.session && (FEED_KINDS.has(e.kind) || e.kind === "sent" || e.kind === "started")) last.set(e.session, e);
  }
  return last;
}
