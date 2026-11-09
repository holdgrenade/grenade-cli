/**
 * Codex's questions and plans as cards (PROTOCOL.md "Codex questions and plans"). In Plan mode Codex asks with
 * `request_user_input` and ends with "Implement this plan?"; no hook announces either. The screen says when one is up
 * (`codexScreen.ts`), the rollout holds its words (`codexRollout.ts`): a `question` or `plan` card opens, the session
 * waits for an answer, and an answer is typed as the keys the person would press, a step at a time as the screen
 * shows what each waits for. The card closes when the screen no longer shows the dialog, however it was answered.
 */
import { planEditedNote, type AgentKind, type KeyName, type PromptBody, type PromptDecision, type WaitingFor } from "@grenade/protocol";
import type { Logger } from "../log.js";
import { cardPlan, cardQuestions, codexOpenQuestionsIn, codexProposedPlanIn, type CodexQuestion } from "./codexRollout.js";
import { codexComposerIn, codexInPlanMode, codexNotesOpenIn, codexPlanDialogIn, codexQuestionPageIn } from "./codexScreen.js";
import type { PromptStore } from "./promptStore.js";
import { keysTo, type MenuRow } from "./screenDialog.js";

export interface CodexTurnPromptsPort {
  on(event: "captured", cb: (id: string, agent: AgentKind, lines: string[]) => void): unknown;
  screenOf(id: string): { lines: string[] } | undefined;
  transcriptOf(id: string): string | undefined;
  asks(id: string): void;
  asked(id: string): void;
  sendKey(id: string, key: KeyName): Promise<void>;
  /** A prompt, sent as the person would send it. */
  sendText(id: string, text: string, submit: boolean): Promise<void>;
  applyHook(id: string, status: "waiting" | "working" | "idle" | "gone", waitingFor?: WaitingFor, aside?: boolean): boolean;
}

export interface CodexTurnPromptsOptions {
  read: (path: string) => Promise<string>;
  /** Types text as keys, not as a paste (Shift-Tab, a note): Codex reads a paste as text to send. */
  type: (id: string, text: string) => Promise<void>;
  now?: () => number;
  wait?: (ms: number) => Promise<void>;
}

/** What a session's screen shows of a Codex dialog, and its card once the rollout has been read. */
interface Shown {
  kind: "question" | "plan";
  /** Its card, while open. */
  promptId?: string | undefined;
  /** The session was set waiting for it: the dialog's end gives it back what it was. */
  waits?: boolean;
  questions?: CodexQuestion[];
  plan?: string;
}

/** One key press (or a few) an answer still owes, made once the screen shows what it waits for. */
interface Step {
  when: (lines: string[]) => boolean;
  act: (lines: string[]) => Promise<void>;
}

/** Shift-Tab as a terminal sends it: Codex's way between Default and Plan mode. */
export const SHIFT_TAB = "\x1b[Z";
/** How long each step waits for its screen. */
const STEP_WAIT_MS = 10_000;
/** Codex reads fast typing followed by Enter as a paste and keeps the Enter as a newline: a pause tells them apart. */
const BEFORE_ENTER_MS = 400;
const NONE_OF_THE_ABOVE = "None of the above";

/** The prompt that builds a plan Codex did not write itself, or with words added after it. */
export function buildPrompt(plan: string, note?: string): string {
  return `Implement this plan:\n\n${plan}${note ? `\n\n${note}` : ""}`;
}

export class CodexTurnPrompts {
  private readonly shown = new Map<string, Shown>();
  private readonly steps = new Map<string, { list: Step[]; until: number; busy: boolean }>();
  private readonly now: () => number;
  private readonly wait: (ms: number) => Promise<void>;

  constructor(
    private readonly registry: CodexTurnPromptsPort,
    private readonly prompts: PromptStore,
    private readonly log: Logger,
    private readonly opts: CodexTurnPromptsOptions,
  ) {
    this.now = opts.now ?? Date.now;
    this.wait = opts.wait ?? ((ms) => new Promise((done) => setTimeout(done, ms)));
    registry.on("captured", (id, agent, lines) => {
      if (agent === "codex") this.saw(id, lines);
    });
    prompts.on("closed", (frame) => {
      // A card closed for any other reason than this answer leaves the dialog to the terminal: no second card for it.
      const shown = this.shown.get(frame.sessionId);
      if (shown?.promptId === frame.promptId && frame.reason !== "answered") shown.promptId = undefined;
    });
  }

  forget(id: string): void {
    this.shown.delete(id);
    this.steps.delete(id);
  }

  /** A session's screen, as it is now. */
  saw(id: string, lines: string[]): void {
    this.payStep(id, lines);
    const kind = codexQuestionPageIn(lines) ? "question" : codexPlanDialogIn(lines) ? "plan" : null;
    const shown = this.shown.get(id);
    if (shown && shown.kind === kind) return;
    if (shown) this.gone(id, shown);
    if (kind) this.appeared(id, kind);
  }

  private appeared(id: string, kind: Shown["kind"]): void {
    const shown: Shown = { kind };
    this.shown.set(id, shown);
    const path = this.registry.transcriptOf(id);
    if (!path) return;
    this.opts
      .read(path)
      .then((jsonl) => {
        if (this.shown.get(id) !== shown) return;
        const body = this.bodyOf(shown, jsonl);
        if (!body) return;
        this.registry.asks(id);
        shown.waits = true;
        shown.promptId = this.prompts.openScreen(id, body, (decision) => this.answer(id, shown, decision)).promptId;
      })
      .catch((e: unknown) => this.log.debug("Could not read a Codex rollout for its dialog", { session: id, error: e }));
  }

  private bodyOf(shown: Shown, jsonl: string): PromptBody | null {
    if (shown.kind === "question") {
      const open = codexOpenQuestionsIn(jsonl);
      if (!open) return null;
      shown.questions = open.questions;
      return { kind: "question", questions: cardQuestions(open.questions) };
    }
    const plan = codexProposedPlanIn(jsonl);
    if (!plan) return null;
    shown.plan = plan;
    return { kind: "plan", plan: cardPlan(plan) };
  }

  private gone(id: string, shown: Shown): void {
    this.shown.delete(id);
    if (shown.promptId) this.prompts.close(shown.promptId);
    if (shown.waits) this.registry.asked(id);
  }

  private answer(id: string, shown: Shown, decision: PromptDecision): string | null {
    const steps = shown.kind === "question" ? this.questionSteps(id, shown, decision) : this.planSteps(id, shown, decision);
    if (typeof steps === "string") return steps;
    if (decision.allow) this.registry.applyHook(id, "working", undefined, true);
    this.steps.set(id, { list: steps, until: this.now() + STEP_WAIT_MS, busy: false });
    const lines = this.registry.screenOf(id)?.lines;
    if (lines) this.payStep(id, lines);
    return null;
  }

  private questionSteps(id: string, shown: Shown, decision: PromptDecision): Step[] | string {
    if (!decision.allow) return this.declineSteps(id, (lines) => codexQuestionPageIn(lines) !== null, ["escape"], decision.feedback);
    const questions = shown.questions ?? [];
    const answers = decision.answers ?? [];
    if (answers.length !== questions.length) return `answer all ${questions.length} questions`;
    return questions.flatMap((q, k): Step[] => {
      const answer = answers[k]?.[0] ?? "";
      const onPage = (lines: string[]) => codexQuestionPageIn(lines)?.page === k + 1 && !codexNotesOpenIn(lines);
      const choice = q.options.find((o) => o.label === answer);
      if (choice) {
        return [{ when: onPage, act: (lines) => this.keys(id, codexQuestionPageIn(lines)?.menu ?? [], choice.label) }];
      }
      // A typed answer: "None of the above" with the words as its note, as Codex offers it.
      return [
        { when: onPage, act: (lines) => this.keys(id, codexQuestionPageIn(lines)?.menu ?? [], NONE_OF_THE_ABOVE, ["tab"]) },
        { when: (lines) => codexQuestionPageIn(lines)?.page === k + 1 && codexNotesOpenIn(lines), act: () => this.typeThenEnter(id, answer) },
      ];
    });
  }

  private planSteps(id: string, shown: Shown, decision: PromptDecision): Step[] {
    const onDialog = (lines: string[]) => codexPlanDialogIn(lines) !== null;
    const menuKeys = (lines: string[], starts: string) => this.keys(id, codexPlanDialogIn(lines)?.menu ?? [], starts);
    if (!decision.allow) {
      // A plan the person edited is planned on from their version: Codex is told where it is, as Claude Code is.
      const note = decision.planEdited ? planEditedNote(decision.planEdited) : undefined;
      const feedback = [decision.feedback, note].filter(Boolean).join(" ") || undefined;
      return [{ when: onDialog, act: (lines) => menuKeys(lines, "No, stay in Plan mode") }, ...this.feedbackSteps(id, feedback)];
    }
    // The plan file's text, which `decisionFor` adds (PROTOCOL.md "Plans"): the person's edit, when it is not Codex's.
    const edited = decision.planText?.trim() && decision.planText.trim() !== shown.plan?.trim() ? decision.planText : undefined;
    if (!decision.note && edited === undefined) return [{ when: onDialog, act: (lines) => menuKeys(lines, "Yes, implement this plan") }];
    // Codex would build the plan it wrote: back out of the dialog, leave Plan mode, and send the plan as it is now.
    return [
      { when: onDialog, act: () => this.press(id, ["escape"]) },
      { when: (lines) => codexComposerIn(lines) && codexInPlanMode(lines), act: () => this.opts.type(id, SHIFT_TAB) },
      { when: (lines) => codexComposerIn(lines) && !codexInPlanMode(lines), act: () => this.registry.sendText(id, buildPrompt(edited ?? shown.plan ?? "", decision.note), true) },
    ];
  }

  private declineSteps(id: string, on: (lines: string[]) => boolean, keys: KeyName[], feedback: string | undefined): Step[] {
    return [{ when: on, act: () => this.press(id, keys) }, ...this.feedbackSteps(id, feedback)];
  }

  /** What to do instead, sent as Codex's next prompt once it waits for one. */
  private feedbackSteps(id: string, feedback: string | undefined): Step[] {
    return feedback ? [{ when: codexComposerIn, act: () => this.registry.sendText(id, feedback, true) }] : [];
  }

  private payStep(id: string, lines: string[]): void {
    const queue = this.steps.get(id);
    if (!queue || queue.busy) return;
    if (this.now() > queue.until) {
      this.steps.delete(id);
      this.log.debug("Gave up answering a Codex dialog: the screen never showed the next step", { session: id });
      return;
    }
    const step = queue.list[0];
    if (!step) {
      this.steps.delete(id);
      return;
    }
    if (!step.when(lines)) return;
    queue.list.shift();
    queue.busy = true;
    step
      .act(lines)
      .catch((e: unknown) => this.log.warn("Could not answer a Codex dialog", { session: id, error: e }))
      .finally(() => {
        queue.busy = false;
        queue.until = this.now() + STEP_WAIT_MS;
        if (this.steps.get(id) !== queue) return;
        if (queue.list.length === 0) this.steps.delete(id);
        // A screen that came while the step typed was passed over, and may not change again: look at it now.
        else this.payStep(id, this.registry.screenOf(id)?.lines ?? []);
      });
  }

  /** The arrows from the selected row to the one starting with `starts`, then Enter (or `instead` of it). */
  private async keys(id: string, menu: MenuRow[], starts: string, instead?: KeyName[]): Promise<void> {
    const keys = keysTo(menu, starts);
    if (!keys) throw new Error(`no "${starts}" on the screen`);
    await this.press(id, instead ? [...keys.slice(0, -1), ...instead] : keys);
  }

  private async press(id: string, keys: KeyName[]): Promise<void> {
    for (const key of keys) await this.registry.sendKey(id, key);
  }

  private async typeThenEnter(id: string, text: string): Promise<void> {
    await this.opts.type(id, text);
    await this.wait(BEFORE_ENTER_MS);
    await this.registry.sendKey(id, "enter");
  }
}
