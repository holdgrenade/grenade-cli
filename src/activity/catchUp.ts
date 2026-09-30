/**
 * A `Stop` hook can run before Claude Code has written the reply to the transcript (seen in one run of three), and
 * in a turn without tool calls no later hook reads it, so the reply reached the phone only with the next prompt.
 * After a Stop whose read showed nothing said, this reads the transcript again a few times until something is.
 */
export const CATCH_UP_DELAYS_MS = [250, 500, 1000, 2000, 3000, 5000];

/** Reads a session's transcript once more; resolves true when the reply arrived and the catch-up can end. */
export type CatchUpRead = (sessionId: string, path: string) => Promise<boolean>;

export class CatchUp {
  private readonly timers = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly read: CatchUpRead,
    private readonly delays: readonly number[] = CATCH_UP_DELAYS_MS,
  ) {}

  /** Starts reading again for a session, replacing a catch-up already running for it. */
  start(sessionId: string, path: string): void {
    this.cancel(sessionId);
    this.schedule(sessionId, path, 0);
  }

  /** A hook of the session read its transcript, or the session is gone: nothing more to catch up. */
  cancel(sessionId: string): void {
    const timer = this.timers.get(sessionId);
    if (timer) clearTimeout(timer);
    this.timers.delete(sessionId);
  }

  stop(): void {
    for (const id of [...this.timers.keys()]) this.cancel(id);
  }

  private schedule(sessionId: string, path: string, attempt: number): void {
    if (attempt >= this.delays.length) return;
    const timer = setTimeout(() => {
      this.timers.delete(sessionId);
      this.read(sessionId, path).then(
        (done) => {
          if (!done) this.schedule(sessionId, path, attempt + 1);
        },
        () => this.schedule(sessionId, path, attempt + 1),
      );
    }, this.delays[attempt]);
    timer.unref?.();
    this.timers.set(sessionId, timer);
  }
}
