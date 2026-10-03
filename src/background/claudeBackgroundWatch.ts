/**
 * Notices that a Claude Code session's background tasks are over when no hook says so (PROTOCOL.md "Background
 * tasks"). A task that ends by itself wakes Claude Code, and its hooks report the new turn; a task the user stops in
 * Claude Code's own task view fires nothing. Claude Code keeps what each process is doing in
 * `<claude dir>/sessions/<pid>.json` (`runningClaude.ts`): `idle` there, on two looks in a row, means nothing runs
 * any more, and the held session finishes. Any other status, or no file, changes nothing: the file is Claude Code's
 * own and not a documented format.
 */
import type { AgentKind } from "@grenade/protocol";
import type { Logger } from "../log.js";
import { conversationIdOf } from "../conversations/heldConversations.js";
import { runningClaudeProcesses, type ClaudeProcess } from "../conversations/runningClaude.js";

export const BACKGROUND_WATCH_MS = 3000;
/** How many looks in a row must say `idle`: one could fall between a turn's end and Claude Code writing `shell`. */
export const IDLE_LOOKS = 2;

export interface BackgroundWatchPort {
  /** The sessions held `working` by background tasks, with the transcript their last hook named. */
  heldInBackground(): { id: string; agent: AgentKind; transcript: string | undefined }[];
  backgroundOver(id: string): void;
}

/** Pure: whether the process that has this conversation open says it is idle. */
export function claudeSaysIdle(processes: readonly ClaudeProcess[], conversationId: string): boolean {
  return processes.find((p) => p.sessionId === conversationId)?.status === "idle";
}

export class ClaudeBackgroundWatch {
  private timer: NodeJS.Timeout | undefined;
  /** Looks in a row that found the session's process idle. */
  private readonly idleLooks = new Map<string, number>();

  constructor(
    private readonly registry: BackgroundWatchPort,
    private readonly sessionsDir: string,
    private readonly log: Logger,
    private readonly processes: (sessionsDir: string) => Promise<ClaudeProcess[]> = runningClaudeProcesses,
  ) {}

  start(intervalMs = BACKGROUND_WATCH_MS): void {
    this.timer = setInterval(() => void this.look().catch((e) => this.log.debug("Could not check on background tasks", { error: e })), intervalMs);
    this.timer.unref();
  }

  stop(): void {
    clearInterval(this.timer);
  }

  /** One look at every held Claude Code session. Reads the sessions folder only when there is one. */
  async look(): Promise<void> {
    const held = this.registry.heldInBackground().filter((s) => s.agent === "claude" && s.transcript);
    for (const id of this.idleLooks.keys()) if (!held.some((s) => s.id === id)) this.idleLooks.delete(id);
    if (held.length === 0) return;
    const processes = await this.processes(this.sessionsDir);
    for (const { id, transcript } of held) {
      if (!claudeSaysIdle(processes, conversationIdOf(transcript ?? ""))) {
        this.idleLooks.delete(id);
        continue;
      }
      const looks = (this.idleLooks.get(id) ?? 0) + 1;
      if (looks < IDLE_LOOKS) {
        this.idleLooks.set(id, looks);
        continue;
      }
      this.idleLooks.delete(id);
      this.log.debug("Background tasks are over: Claude Code is idle", { session: id });
      this.registry.backgroundOver(id);
    }
  }
}
