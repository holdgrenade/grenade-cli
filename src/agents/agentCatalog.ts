/**
 * The agents this daemon can start and what it does with each (PROTOCOL.md "Agents"): sent as `daemon.agents`, and
 * what `session.create`, `grenade new --agent` and the subscribe reply check against. Adding an agent starts here.
 */
import type { AgentInfo } from "@grenade/protocol";

export const AGENTS = [
  { kind: "claude", name: "Claude Code", activity: true, conversations: true },
  { kind: "codex", name: "Codex", activity: true, conversations: true },
  { kind: "shell", name: "Shell" },
] as const satisfies readonly AgentInfo[];

/** An agent this daemon knows how to start. */
export type KnownAgent = (typeof AGENTS)[number]["kind"];

export function agentInfo(kind: string): AgentInfo | undefined {
  return AGENTS.find((a) => a.kind === kind);
}

export function isKnownAgent(kind: string): kind is KnownAgent {
  return agentInfo(kind) !== undefined;
}
