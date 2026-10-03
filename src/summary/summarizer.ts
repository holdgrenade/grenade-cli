/**
 * Keeps each session's one-sentence `summary` and its few-word `title` fresh. Triggers: a session starts working (after a
 * short delay, so the screen shows the task), a session starts waiting, and a new user prompt.
 * At most one run per session per minute, one run at a time overall, and none when nothing the
 * model would see has changed since the last run.
 */
import { createHash } from "node:crypto";
import type { Session } from "@grenade/protocol";
import type { Logger } from "../log.js";
import { buildSummaryInput, parseSummaryReply } from "./summaryPrompt.js";
import { SUMMARY_WORKING_DELAY_MS, summaryDelay } from "./summaryTiming.js";

const PROMPTS_KEPT = 3;

export interface SummaryRegistryPort {
  on(event: "updated", listener: (session: Session) => void): unknown;
  on(event: "removed", listener: (sessionId: string) => void): unknown;
  off(event: "updated", listener: (session: Session) => void): unknown;
  off(event: "removed", listener: (sessionId: string) => void): unknown;
  get(id: string): Session | undefined;
  screenOf(id: string): { lines: string[] } | undefined;
  setSummary(id: string, summary: string): void;
  setGuessedTitle(id: string, title: string): void;
}

export interface SummarizerOptions {
  registry: SummaryRegistryPort;
  log: Logger;
  /** Sends the model input, resolves with the raw reply. */
  run: (input: string) => Promise<string>;
  now?: () => number;
}

interface Track {
  status: Session["status"] | undefined;
  /** Background tasks hold the session `working` after its turn ended. */
  held: boolean;
  prompts: string[];
  timer: ReturnType<typeof setTimeout> | undefined;
  lastRunAt: number | undefined;
  lastInputHash: string | undefined;
}

export class Summarizer {
  private readonly registry: SummaryRegistryPort;
  private readonly log: Logger;
  private readonly run: (input: string) => Promise<string>;
  private readonly now: () => number;
  private readonly tracks = new Map<string, Track>();
  private queue: Promise<void> = Promise.resolve();
  private stopped = false;
  private failures = 0;

  constructor(opts: SummarizerOptions) {
    this.registry = opts.registry;
    this.log = opts.log;
    this.run = opts.run;
    this.now = opts.now ?? Date.now;
  }

  start(): void {
    this.registry.on("updated", this.onUpdated);
    this.registry.on("removed", this.onRemoved);
  }

  stop(): void {
    this.stopped = true;
    this.registry.off("updated", this.onUpdated);
    this.registry.off("removed", this.onRemoved);
    for (const t of this.tracks.values()) clearTimeout(t.timer);
    this.tracks.clear();
  }

  /** A `UserPromptSubmit` hook: a new task has started. */
  notePrompt(id: string, prompt: string): void {
    if (prompt.trim() === "") return;
    const t = this.track(id);
    t.prompts = [...t.prompts, prompt].slice(-PROMPTS_KEPT);
    this.schedule(id, SUMMARY_WORKING_DELAY_MS);
  }

  private readonly onUpdated = (session: Session): void => {
    const t = this.track(session.id);
    const before = t.status;
    const wasHeld = t.held;
    t.status = session.status;
    t.held = session.background !== undefined;
    // A turn that ended with background tasks running stays `working`, but its reply is there: summarize it now.
    if (t.held && !wasHeld) return this.schedule(session.id, 0);
    if (before === session.status) return;
    if (session.status === "working") this.schedule(session.id, SUMMARY_WORKING_DELAY_MS);
    else if (session.status === "waiting") this.schedule(session.id, 0);
  };

  private readonly onRemoved = (id: string): void => {
    clearTimeout(this.tracks.get(id)?.timer);
    this.tracks.delete(id);
  };

  private track(id: string): Track {
    let t = this.tracks.get(id);
    if (!t) {
      t = { status: undefined, held: false, prompts: [], timer: undefined, lastRunAt: undefined, lastInputHash: undefined };
      this.tracks.set(id, t);
    }
    return t;
  }

  /** A pending timer already covers any newer trigger: it reads the screen when it fires. */
  private schedule(id: string, wantDelayMs: number): void {
    const t = this.track(id);
    if (this.stopped || t.timer !== undefined) return;
    const delay = summaryDelay(this.now(), wantDelayMs, t.lastRunAt);
    t.timer = setTimeout(() => {
      t.timer = undefined;
      this.queue = this.queue.then(() => this.summarize(id));
    }, delay);
  }

  private async summarize(id: string): Promise<void> {
    const t = this.tracks.get(id);
    const session = this.registry.get(id);
    if (this.stopped || !t || !session || session.status === "gone") return;
    const input = buildSummaryInput({
      name: session.name,
      agent: session.agent,
      cwd: session.cwd,
      prompts: t.prompts,
      lines: this.registry.screenOf(id)?.lines ?? [],
    });
    const hash = createHash("sha1").update(input).digest("hex");
    if (hash === t.lastInputHash) return;
    t.lastInputHash = hash;
    t.lastRunAt = this.now();
    try {
      const { title, summary } = parseSummaryReply(await this.run(input));
      this.failures = 0;
      if (this.stopped || !this.registry.get(id)) return;
      if (title) this.registry.setGuessedTitle(id, title);
      if (summary) this.registry.setSummary(id, summary);
      this.log.debug("Summarized session", { session: id, title, summary });
    } catch (e) {
      t.lastInputHash = undefined; // let the next trigger try the same input again
      // Log the first failure in a row as a warning so a broken `claude` is visible, the rest quietly.
      if (this.failures++ === 0) this.log.warn("Could not summarize a session with claude -p", { session: id, error: e });
      else this.log.debug("Summary failed again", { session: id, error: e });
    }
  }
}
