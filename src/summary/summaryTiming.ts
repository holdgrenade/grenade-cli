/** Pure: when the next summary for a session may run. */

export const SUMMARY_MIN_GAP_MS = 60_000;
/** After a session starts working, wait so the screen shows what it started on. */
export const SUMMARY_WORKING_DELAY_MS = 8_000;
/** After a failed run, no summary runs for this long; each failure in a row doubles it, up to the maximum. */
export const SUMMARY_FAILURE_PAUSE_MS = 2 * 60_000;
export const SUMMARY_FAILURE_PAUSE_MAX_MS = 30 * 60_000;

/**
 * Milliseconds from `now` until a summary wanted after `wantDelayMs` may run, given the last run
 * started at `lastRunAt` (undefined if never). Never sooner than `minGapMs` after the last run.
 */
export function summaryDelay(now: number, wantDelayMs: number, lastRunAt: number | undefined, minGapMs = SUMMARY_MIN_GAP_MS): number {
  const earliest = lastRunAt === undefined ? now : lastRunAt + minGapMs;
  return Math.max(wantDelayMs, earliest - now, 0);
}

/**
 * How long summaries pause after `failuresInARow` failed runs: 2 minutes, then 4, 8, 16, 30 at most. A `claude -p`
 * that cannot reach the network sits until its time limit kills it, and with a session a minute that is one killed
 * process after another for as long as the network is down.
 */
export function failurePause(failuresInARow: number, firstMs = SUMMARY_FAILURE_PAUSE_MS, maxMs = SUMMARY_FAILURE_PAUSE_MAX_MS): number {
  if (failuresInARow <= 0) return 0;
  return Math.min(firstMs * 2 ** (failuresInARow - 1), maxMs);
}
