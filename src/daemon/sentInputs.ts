/**
 * The `input` ids this daemon has typed (PROTOCOL.md "Sending prompts"), so a prompt a phone sends again after a
 * dropped connection reaches the agent once. Shared by every connection: the repeat comes on a new one.
 */
export const SENT_INPUTS_MAX = 1000;
export const SENT_INPUTS_TTL_MS = 10 * 60 * 1000;

export class SentInputs {
  /** By key: the typing (pending or done) and when it started. Oldest first, as a Map keeps insertion order. */
  private readonly typed = new Map<string, { done: Promise<void>; at: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  /**
   * Types once per key: the first call runs `type`; a later one waits for that first one and types nothing. A
   * failed typing is forgotten, so the phone's next try types it.
   */
  async once(key: string, type: () => Promise<void>): Promise<void> {
    this.prune();
    const known = this.typed.get(key);
    if (known) return known.done;
    const done = type();
    this.typed.set(key, { done, at: this.now() });
    try {
      await done;
    } catch (e) {
      if (this.typed.get(key)?.done === done) this.typed.delete(key);
      throw e;
    }
  }

  get size(): number {
    return this.typed.size;
  }

  private prune(): void {
    const cutoff = this.now() - SENT_INPUTS_TTL_MS;
    for (const [key, entry] of this.typed) {
      if (entry.at >= cutoff && this.typed.size < SENT_INPUTS_MAX) break;
      this.typed.delete(key);
    }
  }
}
