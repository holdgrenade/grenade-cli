/**
 * A page of the thread's history (PROTOCOL.md "Talk by text", "History"): the newest rows of a day written before a row,
 * at most `TALK_THREAD_MAX`, walking back to the latest earlier day that has rows when the day has none left, and the
 * cursor of the page before. Pure: the caller lists the day files and reads a day's rows.
 */
import { TALK_THREAD_MAX, type TalkEntry, type TalkHistoryCursor } from "@grenade/protocol";

export interface TalkHistoryPage {
  date: string;
  entries: TalkEntry[];
  earlier?: TalkHistoryCursor;
}

/** The days that have a file in the talk folder, from its file names: "2026-10-10.jsonl" → "2026-10-10". Pure. */
export function talkDays(fileNames: readonly string[]): string[] {
  return fileNames.flatMap((n) => (/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(n) ? [n.slice(0, 10)] : [])).sort();
}

/**
 * The page asked for: `date`'s rows before `before` (all of them without it); else the latest earlier day with rows.
 * Null when `before` is not a row of `date`. `days` are the days with a file, in any order; `read` gives a day's rows.
 */
export function historyPage(
  days: readonly string[],
  read: (day: string) => readonly TalkEntry[],
  date: string,
  before: string | undefined,
  max = TALK_THREAD_MAX,
): TalkHistoryPage | null {
  const rows = read(date);
  let left: readonly TalkEntry[] = rows;
  if (before !== undefined) {
    const index = rows.findIndex((e) => e.id === before);
    if (index < 0) return null;
    left = rows.slice(0, index);
  }
  let day = date;
  const earlierDays = [...new Set(days)].filter((d) => d < date).sort().reverse();
  while (left.length === 0) {
    const next = earlierDays.shift();
    if (next === undefined) return { date, entries: [] };
    day = next;
    left = read(next);
  }
  const entries = left.slice(-max);
  if (entries.length < left.length) return { date: day, entries, earlier: { date: day, before: entries[0]!.id } };
  const older = earlierDays.find((d) => read(d).length > 0);
  return { date: day, entries, ...(older ? { earlier: { date: older } } : {}) };
}
