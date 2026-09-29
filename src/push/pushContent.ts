/** Pure: what a push says. PROTOCOL.md "Push encryption" has the shape, this file the wording rules. */
import type { DaemonInfo, PushContent, PushEvent, Session } from "@grenade/protocol";

export const PUSH_TEXT_MAX = 200;

/** One line, at most 200 characters, cut on a character boundary with an ellipsis. */
export function clip(text: string, max: number = PUSH_TEXT_MAX): string {
  const line = text.replace(/\s+/g, " ").trim();
  const chars = [...line];
  return chars.length <= max ? line : chars.slice(0, max - 1).join("") + "…";
}

/**
 * The text of a push: for a question what was asked (the hook's message), for a finished turn the
 * session's summary; the last line of the screen when there is neither.
 */
export function pushText(event: PushEvent, session: Pick<Session, "summary" | "lastLine">, asked?: string): string {
  const first = event === "answer" ? asked : session.summary;
  return clip(first?.trim() || session.lastLine);
}

export interface PushContentInput {
  id: string;
  /** Milliseconds since epoch. */
  at: number;
  event: Exclude<PushEvent, "test">;
  daemon: Pick<DaemonInfo, "id" | "name">;
  session: Pick<Session, "id" | "name" | "agent" | "summary" | "lastLine">;
  /** What the agent asked, when a hook said so. */
  asked?: string | undefined;
}

export function pushContentFor(input: PushContentInput): PushContent {
  return {
    v: 1,
    id: input.id,
    at: new Date(input.at).toISOString(),
    event: input.event,
    daemonId: input.daemon.id,
    daemonName: clip(input.daemon.name, 100),
    sessionId: input.session.id,
    sessionName: clip(input.session.name, 40) || input.session.id,
    agent: input.session.agent,
    text: pushText(input.event, input.session, input.asked),
  };
}

/** `grenade push test`: proves the whole path without a session. */
export function testPushContent(id: string, at: number, daemon: Pick<DaemonInfo, "id" | "name">): PushContent {
  return { v: 1, id, at: new Date(at).toISOString(), event: "test", daemonId: daemon.id, daemonName: clip(daemon.name, 100), text: "Push notifications work." };
}
