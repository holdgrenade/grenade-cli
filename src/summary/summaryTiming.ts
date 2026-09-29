/** Pure: when the next summary for a session may run. */

export const SUMMARY_MIN_GAP_MS = 60_000;
/** After a session starts working, wait so the screen shows what it started on. */
export const SUMMARY_WORKING_DELAY_MS = 8_000;

/**
 * Milliseconds from `now` until a summary wanted after `wantDelayMs` may run, given the last run
 * started at `lastRunAt` (undefined if never). Never sooner than `minGapMs` after the last run.
 */
export function summaryDelay(now: number, wantDelayMs: number, lastRunAt: number | undefined, minGapMs = SUMMARY_MIN_GAP_MS): number {
  const earliest = lastRunAt === undefined ? now : lastRunAt + minGapMs;
  return Math.max(wantDelayMs, earliest - now, 0);
}
