/**
 * Pure: which conversations live Grenade sessions hold (PROTOCOL.md "Conversations" `sessionId`). A session holds the
 * conversation its transcript is: the one its agent writes now (a resumed session's copy once its first prompt is
 * sent, the original until then).
 */
import { basename } from "node:path";
import { codexConversationIdOf } from "./codexConversationInfo.js";

export function heldConversations(transcripts: { id: string; path: string }[], isLive: (sessionId: string) => boolean): Map<string, string> {
  const held = new Map<string, string>();
  for (const t of transcripts) if (isLive(t.id) && t.path.endsWith(".jsonl")) held.set(conversationIdOf(t.path), t.id);
  return held;
}

/** The conversation id of a transcript path: Claude Code's `<id>.jsonl`, Codex's `rollout-<time>-<id>.jsonl`. */
export function conversationIdOf(path: string): string {
  return codexConversationIdOf(path) ?? basename(path, ".jsonl");
}
