/**
 * Pure: which conversations live Grenade sessions hold (PROTOCOL.md "Conversations" `sessionId`). A session holds the
 * conversation its transcript is: `<id>.jsonl`, the one Claude Code writes now (a resumed session's copy once its first
 * prompt is sent, the original until then).
 */
import { basename } from "node:path";

export function heldConversations(transcripts: { id: string; path: string }[], isLive: (sessionId: string) => boolean): Map<string, string> {
  const held = new Map<string, string>();
  for (const t of transcripts) if (isLive(t.id) && t.path.endsWith(".jsonl")) held.set(basename(t.path, ".jsonl"), t.id);
  return held;
}

/** The conversation id of a transcript path. */
export function conversationIdOf(path: string): string {
  return basename(path, ".jsonl");
}
