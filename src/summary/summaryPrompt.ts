/**
 * Pure: what the summary model is told, and how its reply becomes a Session `summary`.
 * No I/O, no clock.
 */
import type { AgentKind } from "@grenade/protocol";

export const SUMMARY_MAX = 200;
const SCREEN_LINES = 60;
const PROMPTS_KEPT = 3;
const PROMPT_CHARS = 600;

export const SUMMARY_SYSTEM_PROMPT = [
  "You describe what a terminal session on a developer's Mac is working on, for a one-line status on their phone.",
  "Reply with exactly one plain sentence under 120 characters, present tense, about the task rather than the tool.",
  "No preamble, no quotes, no markdown, no trailing commentary. If there is nothing to go on, describe the folder and program.",
].join(" ");

export interface SummaryInput {
  name: string;
  agent: AgentKind;
  cwd: string;
  /** The user's recent prompts, oldest first. */
  prompts: readonly string[];
  /** The current screen, plain text. */
  lines: readonly string[];
}

/** The user message for the model: session facts, recent prompts, and the tail of the screen. */
export function buildSummaryInput(input: SummaryInput): string {
  const prompts = input.prompts.slice(-PROMPTS_KEPT).map((p) => `- ${clip(oneLine(p), PROMPT_CHARS)}`);
  const screen = input.lines.map((l) => l.trimEnd()).filter((l) => l.trim() !== "").slice(-SCREEN_LINES);
  return [
    `Session: ${input.name} (${input.agent}) in ${input.cwd || "an unknown folder"}`,
    "",
    "Recent prompts from the user:",
    ...(prompts.length > 0 ? prompts : ["(none)"]),
    "",
    "End of the terminal screen:",
    ...(screen.length > 0 ? screen : ["(empty)"]),
  ].join("\n");
}

/** First non-empty line of the reply, unwrapped from quotes and markdown, at most SUMMARY_MAX chars. */
export function cleanSummary(raw: string): string | undefined {
  const line = raw.split("\n").map((l) => l.trim()).find((l) => l !== "");
  if (!line) return undefined;
  const text = oneLine(line.replace(/^[-*#>\s]+/, "").replace(/^["'“‘`*_]+|["'”’`*_]+$/g, ""));
  if (text === "") return undefined;
  return clip(text, SUMMARY_MAX);
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** Cuts at a word boundary and ends with an ellipsis when too long. */
function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return (space > max / 2 ? cut.slice(0, space) : cut).trimEnd() + "…";
}
