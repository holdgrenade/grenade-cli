/** Pure: what a push says. PROTOCOL.md "Push encryption" has the shape, this file the wording rules. */
import { SESSION_TITLE_MAX, type DaemonInfo, type PushContent, type PushEvent, type Session } from "@grenade/protocol";

export const PUSH_TEXT_MAX = 200;

/** One line, at most 200 characters, cut on a character boundary with an ellipsis. */
export function clip(text: string, max: number = PUSH_TEXT_MAX): string {
  const line = text.replace(/\s+/g, " ").trim();
  const chars = [...line];
  return chars.length <= max ? line : chars.slice(0, max - 1).join("") + "…";
}

/** What a push says about a turn that stopped partway, by why it stopped. */
export function stoppedPushText(because: "sleep" | "error" | "quiet", computer: string = "Mac"): string {
  switch (because) {
    case "sleep":
      return `Stopped partway: your ${computer} went to sleep during the reply.`;
    case "error":
      return "Stopped partway: Claude Code hit an error.";
    case "quiet":
      return "Stopped partway: nothing has happened for a while.";
  }
}

type PushedSession = Pick<Session, "summary" | "lastLine" | "waitingFor" | "stoppedBecause">;

/**
 * The text of a push: for a question what was asked (the hook's message), for a finished turn the
 * session's summary, for a turn that stopped partway why; the last line of the screen when there is none.
 */
export function pushText(event: PushEvent, session: PushedSession, asked?: string, computer: string = "Mac"): string {
  if (session.waitingFor === "stopped") return stoppedPushText(session.stoppedBecause ?? "quiet", computer);
  const first = event === "answer" ? asked : session.summary;
  return clip(first?.trim() || session.lastLine);
}

export interface PushContentInput {
  id: string;
  /** Milliseconds since epoch. */
  at: number;
  event: Exclude<PushEvent, "test">;
  daemon: Pick<DaemonInfo, "id" | "name">;
  session: Pick<Session, "id" | "name" | "title" | "agent" | "summary" | "lastLine" | "waitingFor" | "stoppedBecause">;
  /** What the agent asked, when a hook said so. */
  asked?: string | undefined;
  /** What the daemon's machine is called (`computerWord`): "Mac" when absent. */
  computer?: string;
}

export function pushContentFor(input: PushContentInput): PushContent {
  const title = clip(input.session.title ?? "", SESSION_TITLE_MAX);
  return {
    v: 1,
    id: input.id,
    at: new Date(input.at).toISOString(),
    event: input.event,
    daemonId: input.daemon.id,
    daemonName: clip(input.daemon.name, 100),
    sessionId: input.session.id,
    sessionName: clip(input.session.name, 40) || input.session.id,
    // What the phone heads the notification with; a session without a title yet is headed with its name.
    ...(title ? { sessionTitle: title } : {}),
    agent: input.session.agent,
    text: pushText(input.event, input.session, input.asked, input.computer),
  };
}

/** `grenade push test`: proves the whole path without a session. */
export function testPushContent(id: string, at: number, daemon: Pick<DaemonInfo, "id" | "name">): PushContent {
  return { v: 1, id, at: new Date(at).toISOString(), event: "test", daemonId: daemon.id, daemonName: clip(daemon.name, 100), text: "Push notifications work." };
}
