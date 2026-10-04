/**
 * Pure: whether a `session.model` can be done (PROTOCOL.md "Models"). The choice must be one the session's agent
 * lists, and the agent must be at its prompt.
 */
import type { AgentInfo, Session } from "@grenade/protocol";

/** Why `model` with `effort` is not a choice of this agent, or null when it is. */
export function modelChoiceProblem(agent: AgentInfo | undefined, model: string, effort: string | undefined): string | null {
  if (!agent?.models) return "this session's agent has no models to choose from";
  const choice = agent.models.find((m) => m.name === model);
  if (!choice) return `${agent.name} has no model named ${model}`;
  if (effort !== undefined && !choice.efforts?.includes(effort)) return `${model} has no ${effort} effort`;
  return null;
}

/** Why the session cannot switch right now, or null when its agent is at its prompt. */
export function switchTimingProblem(session: Session): string | null {
  if (session.status === "gone") return "the session has ended";
  if (session.status === "working") return "the agent is working: choose a model when its turn is over";
  if (session.status === "waiting" && session.waitingFor === "answer") return "the agent is waiting for an answer: answer it first";
  return null;
}
