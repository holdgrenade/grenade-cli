/**
 * Pure: what a list row says about a Codex rollout (PROTOCOL.md "Conversations", Codex's row of the table), read from
 * its first and last few hundred kilobytes. Which lines are prompts is the protocol's rule (`codexActivityEntriesIn`).
 */
import { codexActivityEntriesIn } from "@grenade/protocol";
import { basename } from "node:path";
import { clip, type ConversationInfo } from "./conversationInfo.js";

/** The conversation id in a rollout's file name, `rollout-<time>-<uuid>.jsonl`; null for any other file. */
export function codexConversationIdOf(path: string): string | null {
  const m = /^rollout-.+-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i.exec(basename(path));
  return m ? m[1]!.toLowerCase() : null;
}

/**
 * `head` is the start of the rollout, `tail` its end (they may overlap, or be the same text, and either may be cut
 * mid-line). `title` is Codex's own name for the thread, from session_index.jsonl. Null when it holds no prompt the
 * user typed, or names no folder.
 */
export function codexConversationInfoIn(head: string, tail: string, title: string | undefined): ConversationInfo | null {
  const cwd = sessionCwd(head);
  const headPrompts = asked(head);
  const tailPrompts = asked(tail);
  const first = headPrompts[0] ?? tailPrompts[0];
  if (!cwd || first === undefined) return null;
  const last = tailPrompts.at(-1) ?? headPrompts.at(-1);
  return { cwd, title: clip(title?.trim() || first), lastPrompt: last === undefined ? undefined : clip(last) };
}

/** Thread id → its newest `thread_name`, from the lines of session_index.jsonl. */
export function codexTitlesIn(jsonl: string): Map<string, string> {
  const titles = new Map<string, string>();
  for (const line of jsonl.split("\n")) {
    const entry = parse(line);
    if (entry && typeof entry["id"] === "string" && typeof entry["thread_name"] === "string" && entry["thread_name"].trim()) {
      titles.set(entry["id"].toLowerCase(), entry["thread_name"]);
    }
  }
  return titles;
}

/**
 * The thread a rollout was forked from (`codex fork`): its first line names it and the first of its lines the copy
 * does not hold (`forked_from_ordinal_exclusive`). A fork's own rollout holds only what came after; its history is
 * the original's lines before that. Null for a rollout that is not a fork.
 */
export function codexForkOf(head: string): { from: string; before: number } | null {
  const newline = head.indexOf("\n");
  const first = parse(newline === -1 ? head : head.slice(0, newline));
  const payload = first?.["type"] === "session_meta" ? first["payload"] : undefined;
  if (!payload || typeof payload !== "object") return null;
  const from = (payload as Record<string, unknown>)["forked_from_id"];
  const before = (payload as Record<string, unknown>)["forked_from_ordinal_exclusive"];
  return typeof from === "string" && /^[A-Za-z0-9-]{1,64}$/.test(from) ? { from: from.toLowerCase(), before: typeof before === "number" ? before : Infinity } : null;
}

/** The lines of a rollout whose `ordinal` is below `before`: what a fork took from it. A line without one is kept. */
export function codexLinesBefore(jsonl: string, before: number): string {
  return jsonl
    .split("\n")
    .filter((line) => {
      const ordinal = /^\{"timestamp":"[^"]*","ordinal":(\d+)/.exec(line)?.[1] ?? parse(line)?.["ordinal"];
      return ordinal === undefined || ordinal === null || Number(ordinal) < before;
    })
    .join("\n");
}

function asked(jsonl: string): string[] {
  return codexActivityEntriesIn(jsonl).flatMap((e) => (e.kind === "asked" ? [e.text] : []));
}

/**
 * The folder of the rollout's first line, `session_meta`. That line holds Codex's whole instructions and may be cut
 * by the slice, so a line that does not parse is searched for its `cwd`, which comes before them.
 */
function sessionCwd(head: string): string | null {
  const first = head.slice(0, head.indexOf("\n") === -1 ? undefined : head.indexOf("\n"));
  if (!first.includes('"session_meta"')) return null;
  const entry = parse(first);
  const payload = entry?.["payload"];
  if (payload && typeof payload === "object") {
    const cwd = (payload as Record<string, unknown>)["cwd"];
    return typeof cwd === "string" && cwd ? cwd : null;
  }
  const m = /"cwd":"((?:[^"\\]|\\.)*)"/.exec(first);
  if (!m) return null;
  try {
    return (JSON.parse(`"${m[1]}"`) as string) || null;
  } catch {
    return null;
  }
}

function parse(line: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(line);
    return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
