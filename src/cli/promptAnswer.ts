/** What a phone answered to a test card, read off the hook reply it became, in words. Pure. */
import type { PromptKind } from "@grenade/protocol";

interface Decision {
  behavior?: unknown;
  message?: unknown;
  updatedInput?: { answers?: unknown };
}

export function answerLines(kind: PromptKind, reply: Record<string, unknown>): string[] {
  const decision = ((reply["hookSpecificOutput"] as { decision?: Decision } | undefined)?.decision ?? {}) as Decision;
  const allowed = decision.behavior === "allow";
  switch (kind) {
    case "permission":
      return [allowed ? "Allow once" : "Deny"];
    case "plan":
      return [allowed ? "Approve" : "Send back"];
    case "question": {
      if (!allowed) return ["Dismiss"];
      const answers = decision.updatedInput?.answers;
      if (typeof answers !== "object" || answers === null) return ["Answer"];
      return Object.entries(answers).map(([question, answer]) => `${question}  →  ${String(answer)}`);
    }
  }
}

/** What Claude Code would have told the agent after a "no": the phone's note is inside it. */
export function messageToAgent(reply: Record<string, unknown>): string | undefined {
  const decision = (reply["hookSpecificOutput"] as { decision?: Decision } | undefined)?.decision;
  return typeof decision?.message === "string" ? decision.message : undefined;
}
