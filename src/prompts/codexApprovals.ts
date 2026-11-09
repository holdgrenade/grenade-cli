/**
 * Codex's approvals as cards (PROTOCOL.md "Codex approvals"). Codex runs its `PermissionRequest` hook before it shows
 * the approval in its terminal, and shows nothing while the hook runs, so the hook is never held: it opens a
 * `permission` card from its payload and lets go at once, and the card is answered with the dialog's own keys once the
 * screen shows it (Enter on "Yes, proceed", Escape to say no). Whoever answers first wins, as with Claude Code: the
 * card closes when the screen no longer shows the dialog, or when a later hook says the agent moved on.
 */
import { promptFromClaudeHook, type AgentKind, type KeyName, type PromptDecision, type WaitingFor } from "@grenade/protocol";
import type { Logger } from "../log.js";
import { codexComposerIn } from "./codexScreen.js";
import type { PromptStore } from "./promptStore.js";
import { keysTo, menuIn } from "./screenDialog.js";

export interface CodexApprovalsPort {
  on(event: "captured", cb: (id: string, agent: AgentKind, lines: string[]) => void): unknown;
  screenOf(id: string): { lines: string[] } | undefined;
  sendKey(id: string, key: KeyName): Promise<void>;
  sendText(id: string, text: string, submit: boolean): Promise<void>;
  applyHook(id: string, status: "waiting" | "working" | "idle" | "gone", waitingFor?: WaitingFor, aside?: boolean): boolean;
}

/** Pure: Codex's approval dialog on this screen, as the keys that approve it once; null when none is up. */
export function codexApprovalIn(lines: readonly string[]): { allow: KeyName[] } | null {
  if (!lines.some((l) => l.includes("Press enter to confirm or esc to cancel"))) return null;
  const allow = keysTo(menuIn([...lines], "›"), "Yes, proceed");
  return allow ? { allow } : null;
}

/** The hooks after which an open approval was answered in the terminal: every one of the session's, or that tool's. */
export function approvalsClosedByCodexHook(event: string): "all" | "tool" | null {
  if (event === "UserPromptSubmit" || event === "Stop" || event === "Interrupt" || event === "SessionEnd") return "all";
  if (event === "PostToolUse") return "tool";
  return null;
}

interface Open {
  promptId: string;
  toolName: string;
  /** The screen has shown its dialog: once it no longer does, it was answered. */
  seen: boolean;
}

/** What an answer from a card still has to type, once the screen is ready for it. */
type Owed = { kind: "allow" | "deny"; until: number } | { kind: "feedback"; text: string; until: number };

/** How long an answer waits for the screen: Codex draws its dialog a moment after the hook lets go. */
const OWED_FOR_MS = 10_000;

export class CodexApprovals {
  private readonly open = new Map<string, Open>();
  private readonly owed = new Map<string, Owed[]>();

  constructor(
    private readonly registry: CodexApprovalsPort,
    private readonly prompts: PromptStore,
    private readonly log: Logger,
    private readonly now: () => number = Date.now,
  ) {
    registry.on("captured", (id, agent, lines) => {
      if (agent === "codex") this.saw(id, lines);
    });
    prompts.on("closed", (frame) => {
      if (this.open.get(frame.sessionId)?.promptId === frame.promptId) this.open.delete(frame.sessionId);
    });
  }

  /** Codex's `PermissionRequest` hook for a session: its card. Codex asks one thing at a time, so an older card was answered. */
  requested(id: string, payload: unknown): void {
    this.closeOpen(id);
    const body = promptFromClaudeHook(payload);
    if (!body || body.kind !== "permission") return;
    const frame = this.prompts.openScreen(id, body, (decision) => this.answer(id, decision));
    const toolName = (payload as { tool_name?: unknown }).tool_name;
    this.open.set(id, { promptId: frame.promptId, toolName: typeof toolName === "string" ? toolName : "", seen: false });
    const lines = this.registry.screenOf(id)?.lines;
    if (lines) this.saw(id, lines);
  }

  /** Any later Codex hook of the session: the agent moved on, so its approval was answered in the terminal. */
  hook(id: string, event: string, toolName: string | undefined): void {
    const closes = approvalsClosedByCodexHook(event);
    const open = this.open.get(id);
    if (!open || !closes) return;
    if (closes === "all" || open.toolName === toolName) this.closeOpen(id);
  }

  /** The session ended or was removed. */
  forget(id: string): void {
    this.open.delete(id);
    this.owed.delete(id);
  }

  /** A session's screen, as it is now. */
  saw(id: string, lines: string[]): void {
    const dialog = codexApprovalIn(lines);
    this.payOwed(id, lines, dialog);
    const open = this.open.get(id);
    if (!open) return;
    if (dialog) open.seen = true;
    else if (open.seen) this.closeOpen(id);
  }

  private answer(id: string, decision: PromptDecision): string | null {
    const until = this.now() + OWED_FOR_MS;
    const owed: Owed[] = [{ kind: decision.allow ? "allow" : "deny", until }];
    // Escape stops Codex's turn; what to do instead is the prompt it then waits for.
    if (!decision.allow && decision.feedback) owed.push({ kind: "feedback", text: decision.feedback, until });
    this.owed.set(id, owed);
    if (decision.allow) this.registry.applyHook(id, "working", undefined, true);
    const lines = this.registry.screenOf(id)?.lines;
    if (lines) this.payOwed(id, lines, codexApprovalIn(lines));
    return null;
  }

  private payOwed(id: string, lines: string[], dialog: { allow: KeyName[] } | null): void {
    const owed = this.owed.get(id);
    const next = owed?.[0];
    if (!owed || !next) return;
    if (this.now() > next.until) {
      this.owed.delete(id);
      this.log.debug("Gave up answering a Codex approval: the screen never showed it", { session: id });
      return;
    }
    if (next.kind === "feedback") {
      if (dialog || !codexComposerIn(lines)) return;
      owed.shift();
      this.registry.sendText(id, next.text, true).catch((e: unknown) => this.log.warn("Could not tell Codex what to do instead", { session: id, error: e }));
    } else {
      if (!dialog) return;
      owed.shift();
      void this.press(id, next.kind === "allow" ? dialog.allow : ["escape"]);
    }
    if (owed.length === 0) this.owed.delete(id);
  }

  private async press(id: string, keys: KeyName[]): Promise<void> {
    try {
      for (const key of keys) await this.registry.sendKey(id, key);
    } catch (e) {
      this.log.warn("Could not answer a Codex approval", { session: id, error: e });
    }
  }

  private closeOpen(id: string): void {
    const open = this.open.get(id);
    if (!open) return;
    this.open.delete(id);
    this.prompts.close(open.promptId);
  }
}
