/**
 * Typed Talk's tools, run on the daemon against its own sessions (PROTOCOL.md "Talk by text", "What the agent may
 * do"). Mirrors the apps' `VoiceToolRunner`; the rules that must hold whatever the agent does are enforced here:
 * - a prompt goes only to a session `route_session` matched for `prompt` in this turn (`talkGuard.ts`), as one capped
 *   line, through the same `registry.sendText` the WebSocket `input` uses;
 * - no tool answers a prompt card: a session waiting for an answer, or showing a dialog, takes no prompt, and a shell
 *   takes none at all (what it is typed runs as a command);
 * - a session is started only in a known project, with a coding agent, through the same `registry.create` as
 *   `session.create`, and a few per turn at most;
 * - what sessions wrote reaches the agent labelled as data (`DATA_NOTE`).
 * Each tool returns what the agent reads and the rows the thread gains: `sent`, `started`, `which`.
 */
import type { ActivityEntry, PromptFrame, Session, TalkChoice } from "@grenade/protocol";
import { FIRST_PROMPT_WAIT_MS, LATE_NOTE, readiness } from "./agentReady.js";
import { maySend, mayStart, noteConfirmation, noteRoute, type TalkTurn } from "./talkGuard.js";
import { agentForNewSession, checkNewSession, knownProjects, matchProject, projectNames, sessionNameFor, type TalkProject } from "./talkProjects.js";
import { askAbout, decide, isRouteAction, type Candidate } from "./talkRouter.js";
import { DATA_NOTE, askingOf, folderNameOf, handleOf, headingOf, lastWords, recentEntries, resolveSession, sendable, sessionRow } from "./talkSessions.js";
import type { NewTalkEntry } from "./talkThread.js";
import { TOOL_ASK_WHICH, TOOL_CREATE, TOOL_LIST, TOOL_READ, TOOL_ROUTE, TOOL_SEND } from "./talkToolDefs.js";
import { TALK_CHOICES_MAX } from "@grenade/protocol";

/** The longest question a `which` row asks. */
export const QUESTION_MAX = 200;
/** How often a new session's screen is looked at while its first prompt waits. */
export const READY_POLL_MS = 500;

/** What the tools need of the daemon. Tests pass fakes. */
export interface TalkToolDeps {
  sessions(): Session[];
  /** The visible lines of a session's last capture. */
  screenLines(id: string): string[] | undefined;
  entriesOf(id: string): ActivityEntry[];
  /** The card a session is showing, if any. */
  openPrompt(id: string): PromptFrame | undefined;
  /** What the daemon calls an agent ("Claude Code"). */
  agentName(kind: string): string;
  /** Agents with a transcript to read (`activity`): the coding agents. */
  hasActivity(kind: string): boolean;
  /** The coding agents this computer can start, in `AGENTS` order. */
  codingAgents(): string[];
  /** Folders of the agents' recent conversations, newest first. */
  conversationFolders(): Promise<string[]>;
  home: string;
  create(input: { name: string; cwd: string; agent: string }): Promise<Session>;
  /** Types a line into a session and presses Enter: what a client's `input` does. */
  type(id: string, text: string): Promise<void>;
  now(): number;
  sleep(ms: number): Promise<void>;
}

export interface ToolResult {
  /** What the agent reads, as JSON. */
  result: Record<string, unknown>;
  isError: boolean;
  /** Rows the thread gains. */
  rows: NewTalkEntry[];
}

export class TalkTools {
  constructor(private readonly d: TalkToolDeps) {}

  async run(turn: TalkTurn, name: string, args: Record<string, unknown>): Promise<ToolResult> {
    switch (name) {
      case TOOL_LIST:
        return ok({ note: DATA_NOTE, sessions: this.rows() });
      case TOOL_READ:
        return this.read(args);
      case TOOL_ROUTE:
        return this.route(turn, args);
      case TOOL_SEND:
        return this.send(turn, args);
      case TOOL_CREATE:
        return this.create(turn, args);
      case TOOL_ASK_WHICH:
        return this.askWhich(turn, args);
      default:
        return fail(`There is no tool named ${name}.`);
    }
  }

  /** Every session as the agent reads it: what `list_sessions` returns, and what each turn's message starts with. */
  rows(): Record<string, unknown>[] {
    const now = this.d.now();
    return this.d.sessions().map((s) => sessionRow(s, this.d.agentName(s.agent), this.d.openPrompt(s.id)?.kind, now));
  }

  /** The projects a session may be started in, newest use first. */
  async projects(): Promise<TalkProject[]> {
    const live = this.d.sessions().filter((s) => s.status !== "gone").sort((a, b) => b.statusSince.localeCompare(a.statusSince)).map((s) => s.cwd);
    const conversations = await this.d.conversationFolders().catch(() => []);
    return knownProjects([...live, ...conversations], this.d.home);
  }

  private read(args: Record<string, unknown>): ToolResult {
    const handle = stringArg(args, "handle");
    if (!handle) return fail("read_session needs a handle.");
    const session = resolveSession(handle, this.d.sessions());
    if (!session) return unknown(handle);
    const result: Record<string, unknown> = { note: DATA_NOTE, title: headingOf(session), status: session.status };
    if (session.status === "waiting" && session.waitingFor) result["waiting_for"] = session.waitingFor;
    const prompt = this.d.openPrompt(session.id);
    if (prompt) result["asking"] = askingOf(prompt);
    if (!this.d.hasActivity(session.agent)) {
      result["note_on_words"] = "This session has no transcript to read.";
      result["last_line"] = session.lastLine;
      return ok(result);
    }
    const count = typeof args["entries"] === "number" ? args["entries"] : undefined;
    result["entries"] = recentEntries(this.d.entriesOf(session.id), count, this.d.now());
    return ok(result);
  }

  /** The sessions as the router scores them. A prompt goes to a coding agent only, never to a shell. */
  private candidates(forPrompt: boolean): Candidate[] {
    return this.d
      .sessions()
      .filter((s) => !forPrompt || this.d.hasActivity(s.agent))
      .map((s) => ({
        key: s.id,
        handle: handleOf(s.id),
        title: headingOf(s),
        name: s.name,
        folder: folderNameOf(s.cwd),
        summary: s.summary,
        status: s.status,
        statusSince: Date.parse(s.statusSince),
        recentWords: lastWords(this.d.entriesOf(s.id)),
      }));
  }

  private route(turn: TalkTurn, args: Record<string, unknown>): ToolResult {
    const intent = typeof args["intent"] === "string" ? args["intent"] : null;
    if (intent === null) return fail("route_session needs an intent.");
    const action = args["action"];
    if (!isRouteAction(action)) return fail("route_session routes to a status, a read or a prompt, and to nothing else.");
    const explicit = stringArg(args, "explicit_title");
    const decision = decide(intent, explicit, action, this.candidates(action === "prompt"), this.d.now());
    const confidence = Math.round(decision.confidence * 100) / 100;
    if ("route" in decision.outcome) {
      const c = decision.outcome.route;
      noteRoute(turn, c.key, action);
      return ok({ decision: "route", handle: c.handle, title: c.title, confidence, action });
    }
    // When the words matched some sessions, those are the choices; when they matched none, the closest by status.
    const matched = decision.ranked.filter((s) => s.words > 0).map((s) => s.candidate);
    const asked = (matched.length > 0 ? matched : askAbout(decision)).slice(0, TALK_CHOICES_MAX);
    noteConfirmation(turn, asked.map((c): TalkChoice => ({ session: c.key, title: c.title.slice(0, 200), status: c.status })));
    return ok({
      decision: "confirmation_needed",
      reason: decision.outcome.confirm,
      confidence,
      candidates: asked.map((c) => c.title),
      note: asked.length > 0 ? "Do not choose one. Call ask_which with a short question, then end your turn." : "No session fits. Say so to the owner in one sentence.",
    });
  }

  private async send(turn: TalkTurn, args: Record<string, unknown>): Promise<ToolResult> {
    const handle = stringArg(args, "handle");
    const text = typeof args["text"] === "string" ? args["text"] : null;
    if (!handle || text === null) return fail("send_to_session needs a handle and a text.");
    const session = resolveSession(handle, this.d.sessions());
    if (!session) return unknown(handle);
    const title = headingOf(session);
    if (session.status === "gone") return fail(`${title} has ended. Nothing was sent.`);
    if (!maySend(turn, session.id)) {
      return fail(`Nothing was sent: ${title} was not routed in this turn. Call route_session with the owner's words and the action prompt first; if it asks for confirmation, call ask_which.`);
    }
    if (!this.d.hasActivity(session.agent)) return fail(`${title} is a shell: what it is typed runs as a command. Nothing was sent.`);
    const prompt = this.d.openPrompt(session.id);
    if (prompt || (session.status === "waiting" && session.waitingFor === "answer")) {
      return fail(`${title} is waiting for the owner to answer ${prompt ? `a ${prompt.kind}` : "a question"} on their screen. Nothing was sent: say so, and that the card is on their screen.`);
    }
    const ready = readiness(session.agent, this.d.screenLines(session.id), true);
    if (typeof ready === "object") return fail(`${ready.hold} Nothing was sent to ${title}.`);
    const line = sendable(text);
    if (!line) return fail("The text was empty. Nothing was sent.");
    try {
      await this.d.type(session.id, line);
    } catch (e) {
      return fail(`${title} did not take it (${e instanceof Error ? e.message : String(e)}). Nothing was sent.`);
    }
    return { result: { state: "sent", to: title, text: line }, isError: false, rows: [{ kind: "sent", text: line, session: session.id, title }] };
  }

  private async create(turn: TalkTurn, args: Record<string, unknown>): Promise<ToolResult> {
    const request = checkNewSession(args, sendable);
    if ("problem" in request) return fail(request.problem);
    if (!mayStart(turn)) return fail("This turn has started as many sessions as it may. The owner can start more from the Sessions list.");
    const projects = await this.projects();
    const match = matchProject(request.project, projects);
    if ("path" in match) return refuse({ error: "A project is named, never given as a path. Nothing was started.", known_projects: projectNames(projects) });
    if ("none" in match) return refuse({ error: `No known project is called ${request.project}. Nothing was started. Ask the owner which project they mean.`, known_projects: projectNames(projects) });
    if ("several" in match) return refuse({ error: `Several projects are called ${request.project}. Nothing was started. Ask the owner which one they mean.` });
    const project = match.one;
    const sessions = this.d.sessions();
    const folderAgent = sessions.filter((s) => s.cwd === project.path && this.d.hasActivity(s.agent)).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]?.agent;
    const agent = agentForNewSession(folderAgent, this.d.codingAgents());
    if (!agent) return fail("No coding agent can be started on this computer. Nothing was started.");
    const liveIds = new Set(sessions.filter((s) => s.status !== "gone").map((s) => s.id));
    let session: Session;
    try {
      session = await this.d.create({ name: sessionNameFor(request.title, liveIds), cwd: project.path, agent });
    } catch (e) {
      return fail(`${e instanceof Error ? e.message : String(e)}. Nothing was started.`);
    }
    turn.started++;
    const result: Record<string, unknown> = { title: headingOf(session), status: session.status, project: project.name, agent: this.d.agentName(agent) };
    let firstPromptSent = false;
    if (request.firstPrompt) {
      const note = await this.deliverFirst(session.id, agent, request.firstPrompt);
      firstPromptSent = note === null;
      result["initial_prompt"] = note ?? "sent";
    }
    const text = firstPromptSent && request.firstPrompt ? request.firstPrompt : request.purpose;
    return { result, isError: false, rows: [{ kind: "started", text, session: session.id, title: headingOf(session) }] };
  }

  /** Types a new session's first prompt once its agent is at its prompt box. Null when sent, else why not. */
  private async deliverFirst(id: string, agent: string, line: string): Promise<string | null> {
    const deadline = this.d.now() + FIRST_PROMPT_WAIT_MS;
    for (;;) {
      const session = this.d.sessions().find((s) => s.id === id);
      const ready = readiness(agent, this.d.screenLines(id), session !== undefined && session.status !== "gone");
      if (ready === "send") {
        try {
          await this.d.type(id, line);
          return null;
        } catch (e) {
          return `The first prompt could not be typed (${e instanceof Error ? e.message : String(e)}).`;
        }
      }
      if (typeof ready === "object") return ready.hold;
      if (this.d.now() >= deadline) return LATE_NOTE;
      await this.d.sleep(READY_POLL_MS);
    }
  }

  private askWhich(turn: TalkTurn, args: Record<string, unknown>): ToolResult {
    const question = stringArg(args, "question")?.replace(/\s+/g, " ");
    if (!question) return fail("ask_which needs a question.");
    const choices = turn.choices;
    if (!choices || choices.length === 0) return fail("ask_which offers the sessions of route_session's confirmation_needed in this turn, and there are none. Call route_session first, or say in text that no session fits.");
    const text = question.length > QUESTION_MAX ? `${question.slice(0, QUESTION_MAX - 1)}…` : question;
    return {
      result: { state: "asked", choices: choices.map((c) => c.title), note: "The owner sees the question with a button per session. End your turn now; do not ask again in text." },
      isError: false,
      rows: [{ kind: "which", text, choices }],
    };
  }
}

function stringArg(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function ok(result: Record<string, unknown>): ToolResult {
  return { result, isError: false, rows: [] };
}

function fail(message: string): ToolResult {
  return { result: { error: message }, isError: true, rows: [] };
}

function refuse(result: Record<string, unknown>): ToolResult {
  return { result, isError: true, rows: [] };
}

function unknown(handle: string): ToolResult {
  return fail(`No session has the handle ${handle}. Call list_sessions for the handles.`);
}
