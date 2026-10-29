/**
 * Pure: which conversations live Grenade sessions hold (PROTOCOL.md "Conversations" `sessionId`). A session holds the
 * conversation its transcript is: the one its agent writes now (a resumed session's copy once its first prompt is
 * sent, the original until then).
 */
import { basename } from "node:path";
import type { Conversation, Session } from "@grenade/protocol";
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

/**
 * Pure: each conversation no live session holds, with the newest ended session it was in (`lastSession`, PROTOCOL.md
 * "Conversations"), so a client continues it in that session's place.
 */
export function withLastSessions(list: Conversation[], sessions: readonly Session[], transcripts: readonly { id: string; path: string }[]): Conversation[] {
  const ended = new Map(sessions.filter((s) => s.status === "gone").map((s) => [s.id, s]));
  const last = new Map<string, Session>();
  for (const t of transcripts) {
    const session = ended.get(t.id);
    if (!session || !t.path.endsWith(".jsonl")) continue;
    const id = conversationIdOf(t.path);
    const was = last.get(id);
    if (!was || session.statusSince > was.statusSince) last.set(id, session);
  }
  return list.map((c) => {
    const session = c.sessionId ? undefined : last.get(c.id);
    return session ? { ...c, lastSession: session.id } : c;
  });
}
