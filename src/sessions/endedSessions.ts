/**
 * Ended sessions started again in their place (PROTOCOL.md "Conversations", "An ended session"): `session.resume`
 * resumes a copy of the session's own conversation, or starts its agent or shell fresh when it has none, and an
 * `input` sent right after waits until the agent is at its prompt box. The registry does the restart; this decides
 * what to restart with and holds the first prompt. I/O only through its deps.
 */
import type { ActivityEntry, AgentKind, Session } from "@grenade/protocol";
import { conversationIdOf } from "../conversations/heldConversations.js";
import { FIRST_PROMPT_WAIT_MS, LATE_NOTE, readiness } from "../talk/agentReady.js";

/** How often a held first prompt looks at the screen again (typed Talk's `READY_POLL_MS`). */
const READY_POLL_MS = 500;

/** An `input` that was not typed because the agent did not reach its prompt box; its message says why. */
export class PromptHeldError extends Error {}

export interface EndedSessionsDeps {
  get(id: string): Session | undefined;
  transcriptOf(id: string): string | undefined;
  restart(id: string, opts: { cwd: string; resume?: string | undefined }): Promise<Session>;
  setTranscript(id: string, path: string): void;
  /** A conversation on this computer: its agent, transcript and the folder it was started in. */
  findConversation(id: string): Promise<{ agent: AgentKind; path: string; cwd: string } | null>;
  /** Its last activity entries, the history a resumed copy shows until its first prompt. */
  previewConversation(id: string): Promise<ActivityEntry[] | null>;
  replaceActivity(id: string, entries: ActivityEntry[]): void;
  /** Agents whose conversations can be resumed (`AgentInfo.conversations`). */
  resumes(agent: AgentKind): boolean;
  screenLines(id: string): readonly string[] | undefined;
  now(): number;
  sleep(ms: number): Promise<void>;
}

export class EndedSessions {
  /** Sessions started again whose agent has not shown its prompt box yet: an `input` to one waits (`whenReady`). */
  private readonly starting = new Set<string>();

  constructor(private readonly d: EndedSessionsDeps) {}

  /** Starts the ended session `id` again. Throws the registry's errors (not ended, folder gone, agent missing). */
  async resume(id: string): Promise<Session> {
    const session = this.d.get(id);
    const conversation = session && this.d.resumes(session.agent) ? await this.conversationOf(id, session.agent) : null;
    const started = conversation
      ? await this.d.restart(id, { cwd: conversation.cwd, resume: conversation.id })
      : await this.d.restart(id, { cwd: session?.cwd ?? "" });
    if (conversation && started.resumedFrom === conversation.id) {
      // As for a conversation resumed from the list: the agent writes the copy only with its first prompt.
      this.d.setTranscript(id, conversation.path);
      const history = await this.d.previewConversation(conversation.id);
      if (history) this.d.replaceActivity(id, history);
    }
    if (started.agent !== "shell" && started.status !== "gone") this.starting.add(id);
    return started;
  }

  /**
   * Before an `input` is typed: for a session `resume` just started, waits until its agent shows its prompt box.
   * Throws `PromptHeldError` when it should not be typed (a dialog of its own, or not ready in time). Any other
   * session goes at once.
   */
  async whenReady(id: string): Promise<void> {
    const held = await this.heldBecause(id);
    if (held) throw new PromptHeldError(held);
  }

  private async heldBecause(id: string): Promise<string | null> {
    if (!this.starting.has(id)) return null;
    const deadline = this.d.now() + FIRST_PROMPT_WAIT_MS;
    try {
      for (;;) {
        const session = this.d.get(id);
        const ready = readiness(session?.agent ?? "", this.d.screenLines(id), session !== undefined && session.status !== "gone");
        if (ready === "send") return null;
        if (typeof ready === "object") return ready.hold;
        if (this.d.now() >= deadline) return LATE_NOTE;
        await this.d.sleep(READY_POLL_MS);
      }
    } finally {
      this.starting.delete(id);
    }
  }

  /** The conversation the session's transcript is, while it is still on this computer and the session's agent's. */
  private async conversationOf(id: string, agent: AgentKind): Promise<{ id: string; path: string; cwd: string } | null> {
    const transcript = this.d.transcriptOf(id);
    if (!transcript) return null;
    const conversationId = conversationIdOf(transcript);
    const found = await this.d.findConversation(conversationId);
    return found && found.agent === agent ? { id: conversationId, path: found.path, cwd: found.cwd } : null;
  }
}
