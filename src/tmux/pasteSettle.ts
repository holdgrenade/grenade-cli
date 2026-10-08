/**
 * Waits for an agent to take in a paste before Enter is pressed. Claude Code reads a picture path in pasted text (a
 * `<picked-element>`'s `screenshot:`, an attachment) into an `[Image #n]` in the background, and an Enter that comes
 * while it does is lost: the prompt sat in the box unsent. So the pane is read every `intervalMs` until it has changed
 * from what it showed before the paste and then looks the same `quietReads` times running, or `maxMs` has passed (an
 * agent at work repaints its spinner without end). Reads and sleeps are injected, so this is pure.
 */

export interface SettleOptions {
  intervalMs: number;
  quietReads: number;
  maxMs: number;
}

export const PASTE_SETTLE: SettleOptions = { intervalMs: 100, quietReads: 2, maxMs: 2000 };

export async function waitForSettle(
  before: string,
  read: () => Promise<string>,
  sleep: (ms: number) => Promise<void>,
  opts: SettleOptions = PASTE_SETTLE,
): Promise<void> {
  let last = before;
  let quiet = 0;
  for (let waited = 0; waited < opts.maxMs; waited += opts.intervalMs) {
    await sleep(opts.intervalMs);
    const now = await read();
    if (now !== before && now === last) {
      if (++quiet >= opts.quietReads) return;
    } else {
      quiet = 0;
    }
    last = now;
  }
}
