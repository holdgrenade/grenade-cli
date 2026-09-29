/** One line that says what a prompt asks, for a push notification and the log. Pure. */
import { clip, type PromptFrame } from "@grenade/protocol";

export const PROMPT_TEXT_MAX = 200;

export function promptText(prompt: Pick<PromptFrame, "kind" | "tool" | "detail" | "questions">): string {
  switch (prompt.kind) {
    case "permission": {
      const what = (prompt.detail ?? "").split("\n")[0]?.trim() ?? "";
      return clip(what ? `${prompt.tool}: ${what}` : `Wants to use ${prompt.tool}`, PROMPT_TEXT_MAX);
    }
    case "question":
      return clip(prompt.questions?.[0]?.question ?? "Has a question for you", PROMPT_TEXT_MAX);
    case "plan":
      return "Has a plan for you to approve";
  }
}
