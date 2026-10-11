/**
 * Follows a working session's transcript, so what the agent says reaches the phone as it is written rather than with
 * the next hook. Hooks alone left gaps: a `Stop` can run before Claude Code has written the reply (and when the turn
 * said something earlier, the read after it found that and looked done), and a long stretch of thinking or one long
 * tool call fires no hook at all. So the reply sometimes waited for the next prompt.
 *
 * Each tick costs one `stat`; the transcript is read only when it grew. Following goes on for `tailMs` after the
 * session stops working, to take the lines Claude Code writes after its last hook.
 */
export const FOLLOW_EVERY_MS = 750;
export const FOLLOW_TAIL_MS = 20_000;

export interface FollowPorts {
  /** Reads what the transcript gained into the session's activity (the daemon's `readActivity`). */
  read(sessionId: string, path: string): Promise<unknown>;
  /** The file's size in bytes; throws when it is gone. */
  size(path: string): Promise<number>;
  /** The session is working (its turn, or background tasks): follow it for as long as that holds. */
  isWorking(sessionId: string): boolean;
}

interface Follow {
  path: string;
  /** The size at the last read; -1 reads at the first tick. */
  size: number;
  /** When the session was first seen not working, or null while it works. */
  quietSince: number | null;
  timer: NodeJS.Timeout;
}

export class TranscriptFollower {
  private readonly follows = new Map<string, Follow>();

  constructor(
    private readonly ports: FollowPorts,
    private readonly everyMs = FOLLOW_EVERY_MS,
    private readonly tailMs = FOLLOW_TAIL_MS,
  ) {}

  /** Follows a session's transcript from now: on every hook, so a new turn or a new file restarts the tail. */
  follow(sessionId: string, path: string): void {
    const f = this.follows.get(sessionId);
    if (f && f.path === path) {
      f.quietSince = null;
      return;
    }
    if (f) clearTimeout(f.timer);
    this.follows.set(sessionId, { path, size: -1, quietSince: null, timer: this.schedule(sessionId) });
  }

  /** Whether a session is being followed (for tests and logs). */
  isFollowing(sessionId: string): boolean {
    return this.follows.has(sessionId);
  }

  /** The session is gone. */
  forget(sessionId: string): void {
    const f = this.follows.get(sessionId);
    if (f) clearTimeout(f.timer);
    this.follows.delete(sessionId);
  }

  stop(): void {
    for (const id of [...this.follows.keys()]) this.forget(id);
  }

  private schedule(sessionId: string): NodeJS.Timeout {
    const timer = setTimeout(() => void this.tick(sessionId), this.everyMs);
    timer.unref?.();
    return timer;
  }

  private async tick(sessionId: string): Promise<void> {
    const f = this.follows.get(sessionId);
    if (!f) return;
    const now = Date.now();
    if (this.ports.isWorking(sessionId)) f.quietSince = null;
    else f.quietSince ??= now;
    try {
      const size = await this.ports.size(f.path);
      if (size !== f.size) {
        f.size = size;
        await this.ports.read(sessionId, f.path);
      }
    } catch {
      // Gone or unreadable for now: the next tick tries again, and the tail still ends it.
    }
    // Forgotten, or followed again with another file, while it read: that follow has its own timer.
    if (this.follows.get(sessionId) !== f) return;
    if (f.quietSince !== null && Date.now() - f.quietSince >= this.tailMs) {
      this.follows.delete(sessionId);
      return;
    }
    f.timer = this.schedule(sessionId);
  }
}
