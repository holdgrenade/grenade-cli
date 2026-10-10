/**
 * The words a turn's highlights carry (PROTOCOL.md "Highlights", "Words"), from the session's activity: the owner's
 * ask, the agent's approach (its first sentence after the ask), the owner's choice after a board, the agent's last
 * sentence; and the caption of a picture, the agent's sentence nearest its time. Pure.
 */
import { HIGHLIGHT_CAPTION_MAX, HIGHLIGHT_WORD_MAX, HIGHLIGHT_WORDS_MAX, type ActivityEntry, type HighlightWord } from "@grenade/protocol";

/** A sentence shorter than this, or a question back to the owner, is not the approach. */
export const APPROACH_MIN_CHARS = 20;
/** How far from a picture's time the agent's sentence may be to caption it. */
export const CAPTION_WINDOW_MS = 10 * 60_000;

/** Text as a word or a caption carries it: whitespace folded, cut with "…". */
export function wordText(text: string, max: number): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** The entries whose time falls in the turn, from `from` to `to` inclusive (ISO times). */
export function entriesInTurn(entries: readonly ActivityEntry[], from: string, to: string): ActivityEntry[] {
  const start = Date.parse(from);
  const end = Date.parse(to);
  return entries.filter((e) => {
    const at = Date.parse(e.at);
    return !Number.isNaN(at) && at >= start && at <= end;
  });
}

/** Whether a sentence of the agent's reads as its approach: long enough, and not a question back. */
export function isApproach(text: string): boolean {
  const line = text.trim();
  return line.length >= APPROACH_MIN_CHARS && !line.endsWith("?");
}

/** The most `chose` words a turn keeps: the first prompt after the boards, and the last two. */
export const CHOSE_MAX = 3;

/**
 * The turn's words: `asked` (the first prompt), `said` (the approach, when the agent's first sentence is one), `chose`
 * (the owner's prompts after the first board was saved: the first of them and the last two, `CHOSE_MAX`), `said` (the
 * last sentence, when it is not the approach). `boardTimes` are when the turn's boards were saved. In time order, at
 * most `HIGHLIGHT_WORDS_MAX`; the ask, the approach and the result are never the ones cut.
 */
export function wordsOf(turn: readonly ActivityEntry[], boardTimes: readonly string[]): HighlightWord[] {
  const words: HighlightWord[] = [];
  const asked = turn.find((e) => e.kind === "asked");
  if (asked) words.push({ kind: "asked", at: asked.at, text: wordText(asked.text, HIGHLIGHT_WORD_MAX) });
  const saids = turn.filter((e) => e.kind === "said" && e.text.trim().length > 0);
  const first = saids[0];
  if (first && isApproach(first.text)) words.push({ kind: "said", at: first.at, text: wordText(first.text, HIGHLIGHT_WORD_MAX) });
  const last = saids.at(-1);
  if (last && last !== first) words.push({ kind: "said", at: last.at, text: wordText(last.text, HIGHLIGHT_WORD_MAX) });
  const firstBoard = boardTimes.map((t) => Date.parse(t)).filter((t) => !Number.isNaN(t)).sort((a, b) => a - b)[0];
  if (firstBoard !== undefined) {
    const chose = turn.filter((e) => e.kind === "asked" && e !== asked && Date.parse(e.at) > firstBoard);
    const kept = chose.length <= CHOSE_MAX ? chose : [chose[0]!, ...chose.slice(-(CHOSE_MAX - 1))];
    const room = Math.max(0, HIGHLIGHT_WORDS_MAX - words.length);
    for (const e of kept.slice(0, room)) words.push({ kind: "chose", at: e.at, text: wordText(e.text, HIGHLIGHT_WORD_MAX) });
  }
  words.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  return words.slice(0, HIGHLIGHT_WORDS_MAX);
}

/** The agent's sentence nearest `at` within `CAPTION_WINDOW_MS` (after it wins a tie), else `fallback`, as a caption. */
export function captionFor(at: string, turn: readonly ActivityEntry[], fallback: string): string {
  const time = Date.parse(at);
  let best: ActivityEntry | undefined;
  let bestDistance = Infinity;
  for (const e of turn) {
    if (e.kind !== "said" || !e.text.trim()) continue;
    const delta = Date.parse(e.at) - time;
    const distance = Math.abs(delta);
    if (distance > CAPTION_WINDOW_MS) continue;
    if (distance < bestDistance || (distance === bestDistance && delta > 0)) {
      best = e;
      bestDistance = distance;
    }
  }
  return wordText(best?.text ?? fallback, HIGHLIGHT_CAPTION_MAX);
}

/** The first line of a prompt, as a `yours` tile's caption. */
export function firstLine(text: string): string {
  return wordText(text.split("\n").find((l) => l.trim()) ?? "", HIGHLIGHT_CAPTION_MAX);
}
