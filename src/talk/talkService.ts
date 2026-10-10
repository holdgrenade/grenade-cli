/**
 * TalkService: the daemon's side of typed Talk (PROTOCOL.md "Talk by text"). Keeps the day's thread, answers the
 * owner's words one turn at a time in the order they came, runs the chosen agent for each turn with Grenade's tools,
 * and adds the rows that follow: `you` from `talk.say`, `sent` / `started` / `which` from the tools, `it` from the
 * agent's answer, `failed` when there is none, and the feed's `working` / `needsYou` / `finished` for every session of an
 * agent with `activity` (`FeedWatcher`, rules in `talkFeed.ts`; never the agent's words).
 *
 * Emits `entry` for a new row, `busy` when the agent starts or stops, and `thread` when the day or the agent changes;
 * `Connection` passes them on to clients that sent `talk.thread`.
 */
import { EventEmitter } from "node:events";
import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { ActivityEntry, Highlights, Session, TalkEntry, TalkThreadFrame } from "@grenade/protocol";
import type { Logger } from "../log.js";
import { FeedWatcher } from "./feedWatcher.js";
import { lastRowsBySession } from "./talkFeed.js";
import { failureSentence, isTalkAgentKind, noAgentSentence, type McpLaunch, type TalkAgentKind } from "./talkAgents.js";
import { isTurnCall, newTurn, type TalkTurn } from "./talkGuard.js";
import { ENV_PORT, ENV_SECRET, ENV_TURN } from "./talkMcp.js";
import { TALK_INSTRUCTIONS, turnMessage } from "./talkPrompt.js";
import { projectNames } from "./talkProjects.js";
import type { TalkRun } from "./talkRunner.js";
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
  /** The sessions and their changes, for the feed. */
  registry: { list(): Session[]; get(id: string): Session | undefined; on(event: "updated", cb: (s: Session) => void): unknown; off(event: "updated", cb: (s: Session) => void): unknown };
  /** What the feed reads besides the registry: each session's words, what its open prompt asks, which agents have `activity`. */
  feed: { entriesOf(id: string): ActivityEntry[]; askingOf(id: string): string | undefined; hasActivity(kind: string): boolean };
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

export class TalkService extends EventEmitter<TalkServiceEvents> {
  private readonly thread: TalkThread;
  private readonly now: () => Date;
  private readonly queue: string[] = [];
  private running = false;
  private turn: TalkTurn | null = null;
  private readonly dayTimer: NodeJS.Timeout;
  private readonly feed: FeedWatcher;
  /** Each session's last row that says where its turns stand, for the feed's one-row-per-change rule. */
  private lastRows: Map<string, TalkEntry>;

  constructor(private readonly o: TalkServiceOptions) {
    super();
    this.now = o.now ?? (() => new Date());
    this.thread = new TalkThread(o.dir, this.now);
    this.lastRows = lastRowsBySession(this.thread.all());
    this.feed = new FeedWatcher({
      registry: o.registry,
      ...o.feed,
      lastRow: (id) => this.lastRows.get(id),
      append: (row) => {
        this.checkDay();
        this.append(row);
      },
      now: () => this.now().getTime(),
    });
    this.dayTimer = setInterval(() => this.checkDay(), DAY_CHECK_MS);
    this.dayTimer.unref();
  }

  stop(): void {
    clearInterval(this.dayTimer);
    this.feed.stop();
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

  /** A hook's prompt: the session starts a turn (the feed's `working`). */
  noteAsked(sessionId: string, prompt: string): void {
    this.feed.asked(sessionId, prompt);
  }

  /** The row with this id, as it is now. */
  row(id: string): TalkEntry | undefined {
    return this.thread.find(id);
  }

  /**
   * A `finished` row's highlights are ready, or changed (PROTOCOL.md "Highlights"): the row is written again with
   * them and sent to every client that watches, which replaces the row it has. Undefined when no row has the id.
   */
  setHighlights(rowId: string, highlights: Highlights | undefined): TalkEntry | undefined {
    const entry = this.thread.update(rowId, (row) => {
      const { highlights: _dropped, ...rest } = row;
      return highlights ? { ...rest, highlights } : rest;
    });
    if (entry) this.emit("entry", entry);
    return entry;
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
    for (const row of done.rows) {
      if ((row.kind === "sent" || row.kind === "started") && row.session) this.feed.sentTo(row.session);
      this.append(row);
    }
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

  private append(row: NewTalkEntry): void {
    const entry = this.thread.append(row);
    if (entry.session && lastRowsBySession([entry]).size > 0) this.lastRows.set(entry.session, entry);
    this.emit("entry", entry);
  }

  /** A new day: a new thread, told to every client that watches. */
  private checkDay(): void {
    if (!this.thread.rollover()) return;
    this.lastRows = lastRowsBySession(this.thread.all());
    const agent = this.agent();
    this.emit("thread", { type: "talk.thread", date: this.thread.date, entries: this.thread.entries(), busy: this.running, ...(agent ? { agent } : {}) });
  }
}
