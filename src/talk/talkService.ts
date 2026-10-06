/**
 * TalkService: the daemon's side of typed Talk (PROTOCOL.md "Talk by text"). Keeps the day's thread, answers the
 * owner's words one turn at a time in the order they came, runs the chosen agent for each turn with Grenade's tools,
 * and adds the rows that follow: `you` from `talk.say`, `sent` / `started` / `which` from the tools, `it` from the
 * agent's answer, `failed` when there is none, and `needsYou` / `finished` from the status of the sessions the thread
 * sent to or started today (the push rule, `startedWaiting`; never the agent's words).
 *
 * Emits `entry` for a new row, `busy` when the agent starts or stops, and `thread` when the day or the agent changes;
 * `Connection` passes them on to clients that sent `talk.thread`.
 */
import { EventEmitter } from "node:events";
import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { Session, TalkEntry, TalkThreadFrame } from "@grenade/protocol";
import type { Logger } from "../log.js";
import { eventOf, startedWaiting } from "../push/pushPolicy.js";
import { failureSentence, isTalkAgentKind, noAgentSentence, type McpLaunch, type TalkAgentKind } from "./talkAgents.js";
import { isTurnCall, newTurn, type TalkTurn } from "./talkGuard.js";
import { ENV_PORT, ENV_SECRET, ENV_TURN } from "./talkMcp.js";
import { TALK_INSTRUCTIONS, turnMessage } from "./talkPrompt.js";
import { projectNames } from "./talkProjects.js";
import type { TalkRun } from "./talkRunner.js";
import { headingOf } from "./talkSessions.js";
import { loadTalkSettings, saveTalkSettings, type TalkSettings } from "./talkSettings.js";
import { TalkThread, type NewTalkEntry } from "./talkThread.js";
import type { TalkTools } from "./talkTools.js";

/** How often the calendar is looked at, so a new day starts a new thread without waiting for words. */
export const DAY_CHECK_MS = 60_000;

export interface TalkServiceEvents {
  entry: [entry: TalkEntry];
  busy: [busy: boolean];
  thread: [frame: TalkThreadFrame];
}

export interface TalkServiceOptions {
  /** Where the day files are: `<GRENADE_HOME>/talk`. */
  dir: string;
  /** The private folder agents run in. */
  workDir: string;
  /** `talk.json`. */
  settingsPath: string;
  tools: TalkTools;
  /** The sessions' changes, for `needsYou` and `finished`. */
  registry: { list(): Session[]; on(event: "updated", cb: (s: Session) => void): unknown; off(event: "updated", cb: (s: Session) => void): unknown };
  /** The agents that can answer here, in `AGENTS` order. */
  agents: readonly TalkAgentKind[];
  agentName(kind: string): string;
  run: TalkRun;
  mcp: McpLaunch;
  controlPort: number;
  log: Logger;
  /** "Mac" or "computer", for the owner's sentences. */
  computer: string;
  now?: () => Date;
}

/** The agent that answers: the one chosen, while it can; else the first that can. Pure. */
export function answeringAgent(chosen: string | undefined, agents: readonly TalkAgentKind[]): TalkAgentKind | undefined {
  const kept = agents.find((a) => a === chosen);
  return kept ?? agents[0];
}

/** The conversation a turn continues, or none when the day or the agent is not the one it was. Pure. */
export function continuing(settings: TalkSettings, date: string, agent: string): string | undefined {
  const c = settings.conversation;
  return c && c.date === date && c.agent === agent ? c.id : undefined;
}

/** The row a session's change is, for a session the thread is about, or null. The push rule: a session that started waiting. Pure. */
export function sessionEventKind(previous: Session | undefined, next: Session): "needsYou" | "finished" | null {
  if (!startedWaiting(previous, next)) return null;
  return eventOf(next) === "answer" ? "needsYou" : "finished";
}

/** The sessions a thread sent to or started. Pure. */
export function sessionsOf(entries: readonly TalkEntry[]): Set<string> {
  return new Set(entries.filter((e) => (e.kind === "sent" || e.kind === "started") && e.session).map((e) => e.session!));
}

export class TalkService extends EventEmitter<TalkServiceEvents> {
  private readonly thread: TalkThread;
  private readonly now: () => Date;
  private readonly queue: string[] = [];
  private running = false;
  private turn: TalkTurn | null = null;
  private readonly previous = new Map<string, Session>();
  private readonly dayTimer: NodeJS.Timeout;
  private readonly onUpdated = (s: Session) => this.observe(s);

  constructor(private readonly o: TalkServiceOptions) {
    super();
    this.now = o.now ?? (() => new Date());
    this.thread = new TalkThread(o.dir, this.now);
    for (const s of o.registry.list()) this.previous.set(s.id, s);
    o.registry.on("updated", this.onUpdated);
    this.dayTimer = setInterval(() => this.checkDay(), DAY_CHECK_MS);
    this.dayTimer.unref();
  }

  stop(): void {
    clearInterval(this.dayTimer);
    this.o.registry.off("updated", this.onUpdated);
  }

  /** The agent that answers now, if any can. */
  agent(): TalkAgentKind | undefined {
    return answeringAgent(loadTalkSettings(this.o.settingsPath).agent, this.o.agents);
  }

  busy(): boolean {
    return this.running;
  }

  /** The day's thread as `talk.thread` carries it. */
  frame(): TalkThreadFrame {
    this.checkDay();
    const agent = this.agent();
    return { type: "talk.thread", date: this.thread.date, entries: this.thread.entries(), busy: this.running, ...(agent ? { agent } : {}) };
  }

  /** The owner's words (`talk.say`). False when that id was said already: it is not said again. */
  say(id: string, text: string): boolean {
    this.checkDay();
    if (this.thread.has(id)) return false;
    this.append({ id, kind: "you", text });
    this.queue.push(text);
    void this.drain();
    return true;
  }

  /** Chooses the agent that answers (`talk.agent`). False when it cannot answer here. */
  setAgent(kind: string): boolean {
    if (!isTalkAgentKind(kind) || !this.o.agents.includes(kind)) return false;
    // The new agent starts a conversation of its own; the day's rows stay.
    saveTalkSettings(this.o.settingsPath, { agent: kind });
    this.o.log.info(`Talk is answered by ${this.o.agentName(kind)}`);
    this.emit("thread", this.frame());
    return true;
  }

  /** One call of the agent's tools, from Grenade's MCP server (`POST /talk/tool`). */
  async tool(turnId: unknown, secret: unknown, name: string, args: Record<string, unknown>): Promise<{ ok: true; text: string; isError: boolean } | { ok: false; message: string }> {
    const turn = this.turn;
    if (!turn || !isTurnCall(turn, turnId, secret)) return { ok: false, message: "This Talk turn is over." };
    const done = await this.o.tools.run(turn, name, args);
    for (const row of done.rows) this.append(row);
    this.o.log.info(`Talk used ${name}`, { ok: !done.isError });
    return { ok: true, text: JSON.stringify(done.result), isError: done.isError };
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.emit("busy", true);
    try {
      for (let words = this.queue.shift(); words !== undefined; words = this.queue.shift()) await this.answer(words);
    } finally {
      this.running = false;
      this.emit("busy", false);
    }
  }

  /** One turn: the agent answers the owner's words. */
  private async answer(words: string): Promise<void> {
    this.checkDay();
    const agent = this.agent();
    if (!agent) return void this.append({ kind: "failed", text: noAgentSentence(this.o.computer) });
    const name = this.o.agentName(agent);
    const settings = loadTalkSettings(this.o.settingsPath);
    const date = this.thread.date;
    const conversation = continuing(settings, date, agent);
    const newConversation = conversation ? undefined : randomUUID();
    // A new conversation is handed the day so far, the owner's words just added left out.
    const earlier = conversation ? undefined : this.thread.all().slice(0, -1);
    const turn = newTurn();
    this.turn = turn;
    const started = Date.now();
    try {
      mkdirSync(this.o.workDir, { recursive: true, mode: 0o700 });
      const message = turnMessage({ sessions: this.o.tools.rows(), projects: projectNames(await this.o.tools.projects()), earlier, words });
      const env = { [ENV_PORT]: String(this.o.controlPort), [ENV_TURN]: turn.id, [ENV_SECRET]: turn.secret };
      const outcome = await this.o.run(agent, { conversation, newConversation, mcp: this.o.mcp, instructions: TALK_INSTRUCTIONS, workDir: this.o.workDir }, message, env);
      if ("failure" in outcome) {
        this.o.log.warn(`Talk: ${name} could not answer`, { failure: outcome.failure, detail: outcome.detail.slice(0, 300) });
        // A conversation that cannot be continued must not fail every turn after it.
        saveTalkSettings(this.o.settingsPath, { ...(settings.agent ? { agent: settings.agent } : {}) });
        return void this.append({ kind: "failed", text: failureSentence(name, outcome.failure, outcome.detail, this.o.computer) });
      }
      const id = outcome.conversation ?? conversation ?? newConversation;
      if (id) saveTalkSettings(this.o.settingsPath, { ...(settings.agent ? { agent: settings.agent } : {}), conversation: { date, agent, id } });
      this.o.log.info(`Talk: ${name} answered`, { ms: Date.now() - started });
      if (outcome.text) this.append({ kind: "it", text: outcome.text });
    } catch (e) {
      this.o.log.error("Talk turn failed", { error: e });
      this.append({ kind: "failed", text: failureSentence(name, "failed", e instanceof Error ? e.message : String(e), this.o.computer) });
    } finally {
      this.turn = null;
    }
  }

  /** A session changed: a row when one the thread is about started to need the owner or finished. */
  private observe(next: Session): void {
    const previous = this.previous.get(next.id);
    this.previous.set(next.id, next);
    const kind = sessionEventKind(previous, next);
    if (!kind) return;
    this.checkDay();
    if (!sessionsOf(this.thread.all()).has(next.id)) return;
    this.append({ kind, text: "", session: next.id, title: headingOf(next) });
  }

  private append(row: NewTalkEntry): void {
    const entry = this.thread.append(row);
    this.emit("entry", entry);
  }

  /** A new day: a new thread, told to every client that watches. */
  private checkDay(): void {
    if (!this.thread.rollover()) return;
    const agent = this.agent();
    this.emit("thread", { type: "talk.thread", date: this.thread.date, entries: this.thread.entries(), busy: this.running, ...(agent ? { agent } : {}) });
  }
}
