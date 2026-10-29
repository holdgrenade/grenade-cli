/**
 * What each Claude Code session's context holds (PROTOCOL.md "Usage", "Where it goes"): the parts its folder loads
 * before the user types, measured once per folder (`probeContext`) and again after a memory file changes or 30
 * minutes, one folder at a time; the conversation is the rest of the session's `used`. A session's status line comes
 * in as before; until its folder is measured it goes out without parts, and once the measure comes it goes out again.
 */
import { stat } from "node:fs/promises";
import type { SessionContext } from "@grenade/protocol";
import type { Logger } from "../log.js";
import { withParts, type ContextProbeAnswer } from "./contextProbe.js";

/** How long a folder's measure is trusted. */
export const CONTEXT_PROBE_TTL_MS = 30 * 60 * 1000;
/** How often a folder's memory files are looked at for a change. */
const MEMORY_CHECK_MS = 60 * 1000;
/** A folder whose measure failed is not tried again for this long. */
const RETRY_MS = 10 * 60 * 1000;

interface Measured {
  answer?: ContextProbeAnswer;
  at: number;
  /** The memory files' save times when measured. */
  mtimes: Map<string, number>;
  checkedAt: number;
}

export interface ContextBreakdownDeps {
  /** Measures a folder; injected so tests never start claude. */
  probe(cwd: string): Promise<ContextProbeAnswer>;
  /** A folder's measure came: its sessions' contexts go out again. */
  onMeasured(cwd: string): void;
  log: Logger;
  now?: () => number;
  mtimeOf?: (path: string) => Promise<number | undefined>;
}

const realMtime = (path: string) =>
  stat(path).then(
    (s) => s.mtimeMs,
    () => undefined,
  );

export class ContextBreakdown {
  private readonly folders = new Map<string, Measured>();
  private readonly queue: string[] = [];
  private running = false;

  constructor(private readonly d: ContextBreakdownDeps) {}

  /** The session's context with what it holds, when its folder is measured; asks for a measure when it is due. */
  of(cwd: string, context: SessionContext): SessionContext {
    const measured = this.folders.get(cwd);
    this.refreshIfDue(cwd, measured);
    return withParts(context, measured?.answer);
  }

  private refreshIfDue(cwd: string, measured: Measured | undefined): void {
    const now = (this.d.now ?? Date.now)();
    if (this.queue.includes(cwd)) return;
    if (!measured) return this.enqueue(cwd);
    if (!measured.answer) {
      if (now - measured.at >= RETRY_MS) this.enqueue(cwd);
      return;
    }
    if (now - measured.at >= CONTEXT_PROBE_TTL_MS) return this.enqueue(cwd);
    if (now - measured.checkedAt < MEMORY_CHECK_MS) return;
    measured.checkedAt = now;
    void this.memoryChanged(measured).then((changed) => {
      if (changed && !this.queue.includes(cwd)) this.enqueue(cwd);
    });
  }

  private async memoryChanged(measured: Measured): Promise<boolean> {
    const mtimeOf = this.d.mtimeOf ?? realMtime;
    for (const [path, was] of measured.mtimes) if ((await mtimeOf(path)) !== was) return true;
    return false;
  }

  private enqueue(cwd: string): void {
    this.queue.push(cwd);
    void this.drain();
  }

  /** One folder at a time: each measure starts a claude process. */
  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (let cwd = this.queue[0]; cwd !== undefined; cwd = this.queue[0]) {
        const now = (this.d.now ?? Date.now)();
        try {
          const answer = await this.d.probe(cwd);
          const mtimeOf = this.d.mtimeOf ?? realMtime;
          const mtimes = new Map<string, number>();
          for (const path of answer.memoryFiles) {
            const m = await mtimeOf(path);
            if (m !== undefined) mtimes.set(path, m);
          }
          this.folders.set(cwd, { answer, at: now, mtimes, checkedAt: now });
          this.queue.shift();
          this.d.onMeasured(cwd);
        } catch (e) {
          this.d.log.debug("Could not measure what a folder loads into Claude Code's context", { cwd, error: e instanceof Error ? e.message : String(e) });
          const kept = this.folders.get(cwd);
          this.folders.set(cwd, { ...(kept?.answer ? { answer: kept.answer } : {}), at: now, mtimes: kept?.mtimes ?? new Map(), checkedAt: now });
          this.queue.shift();
        }
      }
    } finally {
      this.running = false;
    }
  }
}
