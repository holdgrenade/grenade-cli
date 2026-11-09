/**
 * The agents this daemon can start and what it does with each (PROTOCOL.md "Agents"): sent as `daemon.agents`, and
 * what `session.create`, `grenade new --agent` and the subscribe reply check against. Adding an agent starts here.
 */
import type { AgentInfo } from "@grenade/protocol";

const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"];

/**
 * The models a Claude Code session can be switched to (PROTOCOL.md "Models"): the current ones, named as the rows of
 * Claude Code's `/model` picker and as `modelLabel` names a reply's model. A name the picker does not have is refused
 * when it is chosen, so a list that falls behind Claude Code never switches to the wrong model.
 */
const CLAUDE_MODELS = [
  { name: "Fable 5.1", efforts: CLAUDE_EFFORTS },
  { name: "Opus 5.5", efforts: CLAUDE_EFFORTS },
  { name: "Sonnet 5.5", efforts: CLAUDE_EFFORTS },
  { name: "Haiku 4.5" },
];

export const AGENTS = [
  { kind: "claude", name: "Claude Code", activity: true, conversations: true, models: CLAUDE_MODELS, plans: true },
  { kind: "codex", name: "Codex", activity: true, conversations: true, plans: true },
  { kind: "shell", name: "Shell" },
] as const satisfies readonly AgentInfo[];

/** An agent this daemon knows how to start. */
export type KnownAgent = (typeof AGENTS)[number]["kind"];

/**
 * What the daemon learned about an agent on this computer as it started: Codex's models come from its own cache
 * (`codexModels.ts`), not from this file. Set once by the daemon (`learnAgent`); tests may set it again.
 */
const learned = new Map<string, Partial<AgentInfo>>();

export function learnAgent(kind: KnownAgent, info: Partial<AgentInfo>): void {
  learned.set(kind, info);
}

/** Every agent, with what was learned about it here. */
export function agentList(): AgentInfo[] {
  return AGENTS.map((a) => ({ ...a, ...learned.get(a.kind) }));
}

export function agentInfo(kind: string): AgentInfo | undefined {
  return agentList().find((a) => a.kind === kind);
}

export function isKnownAgent(kind: string): kind is KnownAgent {
  return agentInfo(kind) !== undefined;
}
