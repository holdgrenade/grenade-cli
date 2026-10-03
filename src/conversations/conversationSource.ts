/**
 * Every agent's past conversations as one list (PROTOCOL.md "Conversations"). Each agent that keeps conversations has
 * a ConversationSource (ConversationIndex for Claude Code, CodexConversations for Codex); this merges them and sends
 * each request to the source that has the id. Nothing here knows an agent's files.
 */
import { CONVERSATIONS_MAX, type ActivityEntry, type AgentKind, type Conversation } from "@grenade/protocol";

/** One agent's conversations on this Mac. */
export interface ConversationSource {
  readonly agent: AgentKind;
  /** Newest first. */
  list(): Promise<Conversation[]>;
  /** Its transcript and folder, or null when this source has no conversation with that id. */
  find(id: string): Promise<{ path: string; cwd: string } | null>;
  /** Its last activity entries, or null when this source has no conversation with that id. */
  preview(id: string): Promise<ActivityEntry[] | null>;
  /** What deleting it moves to the Trash, or why not. Null when this source has no conversation with that id. */
  trashPaths(id: string): Promise<{ paths: string[] } | { refused: string } | null>;
}

/** The agent apps from before `Conversation.agent` can resume: a daemon lists only its conversations to them. */
export const LEGACY_CONVERSATION_AGENT = "claude";

export class AllConversations {
  constructor(private readonly sources: readonly ConversationSource[]) {}

  /** Every source's conversations, newest first, at most CONVERSATIONS_MAX; `anyAgent: false` keeps the legacy agent's only. */
  async list(anyAgent: boolean): Promise<Conversation[]> {
    const sources = anyAgent ? this.sources : this.sources.filter((s) => s.agent === LEGACY_CONVERSATION_AGENT);
    const lists = await Promise.all(sources.map((s) => s.list()));
    return lists.flat().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, CONVERSATIONS_MAX);
  }

  async find(id: string): Promise<{ agent: AgentKind; path: string; cwd: string } | null> {
    for (const s of this.sources) {
      const found = await s.find(id);
      if (found) return { agent: s.agent, ...found };
    }
    return null;
  }

  async preview(id: string): Promise<ActivityEntry[] | null> {
    for (const s of this.sources) {
      const entries = await s.preview(id);
      if (entries) return entries;
    }
    return null;
  }

  async trashPaths(id: string): Promise<{ paths: string[] } | { refused: string }> {
    for (const s of this.sources) {
      const target = await s.trashPaths(id);
      if (target) return target;
    }
    return { refused: `no conversation ${id} on this Mac` };
  }
}
