/**
 * The prompts an agent is showing right now (PROTOCOL.md "Prompts"): Claude Code's, each with the way to answer the
 * hook request that is held open for it, and the dialogs read off a screen (`openScreen`, Codex's startup dialogs),
 * each with the way to answer it with keys. No sockets, no timers: the HTTP route, the screen and the connections
 * drive it.
 */
import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  PROMPT_HOOK_TIMEOUT_S,
  hookReplyFor,
  promptFromClaudeHook,
  promptsClosedByClaudeHook,
  type PromptBody,
  type PromptClosedFrame,
  type PromptClosedReason,
  type PromptDecision,
  type PromptFrame,
} from "@grenade/protocol";

/** Answers the held hook request: with a decision, or with nothing, which leaves the prompt to the terminal. */
export type Respond = (reply: Record<string, unknown> | null) => void;

export interface PromptEvents {
  opened: [frame: PromptFrame];
  closed: [frame: PromptClosedFrame];
  /** A phone answered a hook's prompt: the agent goes on. (Not for a screen's: the screen says what happens next.) */
  answered: [sessionId: string, allow: boolean];
}

/** What became of a `prompt.answer`: used, too late, or why it does not fit the prompt. */
export type AnswerOutcome = "answered" | "elsewhere" | { error: string };

interface OpenPrompt {
  frame: PromptFrame;
  /** `tool_name` as Claude Code sent it: a later `PostToolUse` of that tool means it was answered on the Mac. */
  toolName: string;
  payload: unknown;
  openedAt: number;
  respond: Respond;
  /** A test card: no agent is behind it, so what the session's agent does next says nothing about it. */
  test: boolean;
  /** A dialog read off the screen: answered with keys, never by a hook reply, never closed by a hook. */
  screen?: ScreenAnswer;
}

/** Answers a dialog read off the screen; returns why the decision does not fit it, or null once it is answered. */
export type ScreenAnswer = (decision: PromptDecision) => string | null;

export interface PromptStoreOptions {
  now?: () => number;
  newId?: () => string;
}

/** A request that Claude Code dropped this close to the hook's timeout ran out of time; earlier, it was answered on the Mac. */
const TIMEOUT_SLACK_MS = 5000;

export class PromptStore extends EventEmitter<PromptEvents> {
  private readonly open_ = new Map<string, OpenPrompt>();
  private readonly now: () => number;
  private readonly newId: () => string;

  constructor(opts: PromptStoreOptions = {}) {
    super();
    this.now = opts.now ?? Date.now;
    this.newId = opts.newId ?? (() => `p-${randomBytes(4).toString("hex")}`);
  }

  /** Open prompts, oldest first. */
  list(): PromptFrame[] {
    return [...this.open_.values()].map((p) => p.frame);
  }

  /**
   * A `PermissionRequest` arrived for a session. Returns the prompt, which stays open until it is answered,
   * dropped or closed, or null when the payload is not something a card can show (`respond` is not called then).
   */
  open(sessionId: string, payload: unknown, respond: Respond, opts: { test?: boolean } = {}): PromptFrame | null {
    const body = promptFromClaudeHook(payload);
    if (!body) return null;
    const at = this.now();
    const frame: PromptFrame = { type: "prompt", sessionId, promptId: this.newId(), since: new Date(at).toISOString(), ...body };
    const toolName = (payload as { tool_name: string }).tool_name;
    this.open_.set(frame.promptId, { frame, toolName, payload, openedAt: at, respond, test: opts.test === true });
    this.emit("opened", frame);
    return frame;
  }

  /** A dialog the screen shows (`codexDialogs.ts`). Open until it is answered or `close`d when the screen moves on. */
  openScreen(sessionId: string, body: PromptBody, answer: ScreenAnswer): PromptFrame {
    const at = this.now();
    const frame: PromptFrame = { type: "prompt", sessionId, promptId: this.newId(), since: new Date(at).toISOString(), ...body };
    this.open_.set(frame.promptId, { frame, toolName: "", payload: null, openedAt: at, respond: () => {}, test: false, screen: answer });
    this.emit("opened", frame);
    return frame;
  }

  /** The screen no longer shows the dialog: it was answered on the Mac. */
  close(promptId: string): void {
    const p = this.open_.get(promptId);
    if (p) this.closeWith(p, "elsewhere", null);
  }

  /** A phone sent `prompt.answer`. */
  answer(sessionId: string, promptId: string, decision: PromptDecision): AnswerOutcome {
    const p = this.open_.get(promptId);
    if (!p || p.frame.sessionId !== sessionId) return "elsewhere";
    if (p.screen) {
      const error = p.screen(decision);
      if (error) return { error };
      this.closeWith(p, "answered", null);
      return "answered";
    }
    const reply = hookReplyFor(p.payload, decision);
    if (!reply.ok) return { error: reply.message };
    this.closeWith(p, "answered", reply.reply);
    this.emit("answered", sessionId, decision.allow);
    return "answered";
  }

  /** Claude Code dropped the held request: the prompt was answered in the terminal, or the hook ran out of time. */
  dropped(promptId: string): void {
    const p = this.open_.get(promptId);
    if (!p) return;
    const ranOut = this.now() - p.openedAt >= PROMPT_HOOK_TIMEOUT_S * 1000 - TIMEOUT_SLACK_MS;
    this.closeWith(p, ranOut ? "expired" : "elsewhere", null);
  }

  /** Nobody may answer this one any more from a phone: its time is up. */
  expire(promptId: string): void {
    const p = this.open_.get(promptId);
    if (p) this.closeWith(p, "expired", null);
  }

  /** A later hook of the session arrived (PROTOCOL.md "Prompt hook", step 3). */
  closeByHook(sessionId: string, eventName: string, toolName?: string): void {
    const closes = promptsClosedByClaudeHook(eventName);
    if (!closes) return;
    const ofSession = [...this.open_.values()].filter((p) => p.frame.sessionId === sessionId && !p.test && !p.screen);
    const gone = closes === "all" ? ofSession : ofSession.filter((p) => p.toolName === toolName).slice(0, 1);
    for (const p of gone) this.closeWith(p, "elsewhere", null);
  }

  /** The session ended or was removed. */
  closeSession(sessionId: string): void {
    for (const p of [...this.open_.values()]) if (p.frame.sessionId === sessionId) this.closeWith(p, "elsewhere", null);
  }

  /** The daemon is stopping: hand every prompt back to the terminal. */
  closeAll(): void {
    for (const p of [...this.open_.values()]) this.closeWith(p, "elsewhere", null);
  }

  private closeWith(p: OpenPrompt, reason: PromptClosedReason, reply: Record<string, unknown> | null): void {
    this.open_.delete(p.frame.promptId);
    p.respond(reply);
    this.emit("closed", { type: "prompt.closed", sessionId: p.frame.sessionId, promptId: p.frame.promptId, reason });
  }
}
