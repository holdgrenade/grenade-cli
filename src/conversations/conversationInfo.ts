/**
 * Pure: what a list row says about a Claude Code transcript (PROTOCOL.md "Conversations"), read from its first and
 * last few hundred kilobytes. Which lines are prompts is the protocol's rule (`activityEntriesIn`).
 */
import { CONVERSATION_TEXT_MAX, activityEntriesIn } from "@grenade/protocol";

export interface ConversationInfo {
  /** The folder it was started in: the first `cwd` Claude Code stamped on a line. */
  cwd: string;
  /** Claude Code's newest `ai-title`, else the first prompt. */
  title: string;
  /** The newest prompt the user typed. */
  lastPrompt: string | undefined;
}

/**
 * `head` is the start of the transcript, `tail` its end (they may overlap, or be the same text for a small file, and
 * either may start or end mid-line). Null when it holds no prompt the user typed, or names no folder: not a
 * conversation anyone would resume.
 */
export function conversationInfoIn(head: string, tail: string): ConversationInfo | null {
  const cwd = firstCwd(head);
  const headPrompts = asked(head);
  const tailPrompts = asked(tail);
  const first = headPrompts[0] ?? tailPrompts[0];
  if (!cwd || first === undefined) return null;
  const title = lastTitle(tail) ?? lastTitle(head) ?? first;
  const last = tailPrompts.at(-1) ?? headPrompts.at(-1);
  return { cwd, title: clip(title), lastPrompt: last === undefined ? undefined : clip(last) };
}

/** One line of at most CONVERSATION_TEXT_MAX characters; a cut text ends with `…`. */
export function clip(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > CONVERSATION_TEXT_MAX ? line.slice(0, CONVERSATION_TEXT_MAX - 1) + "…" : line;
}

function asked(jsonl: string): string[] {
  return activityEntriesIn(jsonl).flatMap((e) => (e.kind === "asked" ? [e.text] : []));
}

function firstCwd(jsonl: string): string | null {
  for (const line of jsonl.split("\n")) {
    if (!line.includes('"cwd"')) continue;
    const entry = parse(line);
    if (entry && entry["isSidechain"] !== true && typeof entry["cwd"] === "string" && entry["cwd"]) return entry["cwd"];
  }
  return null;
}

/** Claude Code writes `{"type":"ai-title","aiTitle":…}` and repeats it as the title changes; the last one wins. */
function lastTitle(jsonl: string): string | null {
  let title: string | null = null;
  for (const line of jsonl.split("\n")) {
    if (!line.includes('"ai-title"')) continue;
    const entry = parse(line);
    const text = entry?.["aiTitle"];
    if (entry?.["type"] === "ai-title" && typeof text === "string" && text.trim()) title = text;
  }
  return title;
}

function parse(line: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(line);
    return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
