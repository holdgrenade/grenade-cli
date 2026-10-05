/**
 * PlanLimits: the newest reading of each agent's plan windows on this computer (PROTOCOL.md "Usage"), answered to a
 * `limits` frame. Kept in memory: after a restart an agent has none until it next reports.
 */
import { LIMITS_MAX, type PlanLimit } from "@grenade/protocol";

export class PlanLimits {
  private readonly byAgent = new Map<string, PlanLimit[]>();

  /** An agent's latest windows replace what it reported before. A report with none changes nothing. */
  record(agent: string, limits: readonly PlanLimit[]): void {
    if (limits.length > 0) this.byAgent.set(agent, [...limits]);
  }

  /** Every window not yet reset at `now`, shortest first, then by agent. */
  list(now: number = Date.now()): PlanLimit[] {
    return [...this.byAgent.values()]
      .flat()
      .filter((l) => l.resetsAt === undefined || Date.parse(l.resetsAt) > now)
      .sort((a, b) => a.minutes - b.minutes || a.agent.localeCompare(b.agent))
      .slice(0, LIMITS_MAX);
  }
}
