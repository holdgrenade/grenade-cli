/**
 * Dialogs read off a screen as prompts (PROTOCOL.md "Codex dialogs", "Claude Code dialogs"): when a session's screen
 * shows one (`codexDialogIn`, `claudeDialogIn`), the session waits for an answer and every client gets a `question`
 * card; the answer is typed as the keys that pick its option. The card closes when the screen no longer shows the
 * dialog, however it was answered, and the session is then what it was before (`registry.asked`).
 */
import type { AgentKind, KeyName, PromptDecision } from "@grenade/protocol";
import type { Logger } from "../log.js";
import { claudeDialogIn } from "./claudeDialogs.js";
import { codexDialogIn } from "./codexDialogs.js";
import type { PromptStore } from "./promptStore.js";
import type { DialogChoice, ScreenDialog } from "./screenDialog.js";

export interface ScreenPromptsPort {
  on(event: "captured", cb: (id: string, agent: AgentKind, lines: string[]) => void): unknown;
  /** The screen shows a dialog the agent waits on. */
  asks(id: string): void;
  /** That dialog is gone from the screen. */
  asked(id: string): void;
  sendKey(id: string, key: KeyName): Promise<void>;
  /** The screen says the agent switched the session's model. */
  chooseModel(id: string, model: string, effort: string | undefined): unknown;
}

/** The dialog a session's screen shows. Its card may have closed already (answered from a client). */
interface Shown {
  dialog: ScreenDialog;
  promptId: string;
}

/** A key a choice still owes, pressed once the screen shows what it waits for. */
interface Owed {
  when: (lines: string[]) => boolean;
  key: KeyName;
  until: number;
}

/** Who reads which agent's screen. A shell shows no dialogs. */
const READERS: Partial<Record<AgentKind, (lines: string[]) => ScreenDialog | null>> = { codex: codexDialogIn, claude: claudeDialogIn };
/** A screen that has not shown what an owed key waits for by now never will. */
const OWED_FOR_MS = 10_000;

export class ScreenPrompts {
  private readonly shown = new Map<string, Shown>();
  private readonly owed = new Map<string, Owed>();

  constructor(
    private readonly registry: ScreenPromptsPort,
    private readonly prompts: PromptStore,
    private readonly log: Logger,
    private readonly now: () => number = Date.now,
  ) {
    registry.on("captured", (id, agent, lines) => this.saw(id, agent, lines));
    prompts.on("closed", (frame) => {
      // A session that ended takes its dialog along. An answered card stays known until the screen moves on, so
      // the dialog it answered opens no second card while its keys are on their way.
      if (frame.reason !== "answered" && this.shown.get(frame.sessionId)?.promptId === frame.promptId) this.shown.delete(frame.sessionId);
    });
  }

  /** A session's screen, as it is now. Also called by whoever saw a dialog come up before the next capture did. */
  saw(id: string, agent: AgentKind, lines: string[]): void {
    this.payOwed(id, lines);
    const read = READERS[agent];
    if (read) this.look(id, read(lines), lines);
  }

  private look(id: string, dialog: ScreenDialog | null, lines: string[]): void {
    const shown = this.shown.get(id);
    if (shown && shown.dialog.id === dialog?.id) return;
    // The dialog went away, or another took its place: it was answered, from a card or on the Mac.
    if (shown) this.gone(id, shown, lines);
    if (!dialog) return;
    this.registry.asks(id);
    const frame = this.prompts.openScreen(id, dialog.body, (decision) => this.answer(id, dialog, decision));
    this.shown.set(id, { dialog, promptId: frame.promptId });
    this.log.debug(`The screen shows a dialog: ${dialog.id}`, { session: id });
  }

  private gone(id: string, shown: Shown, lines: string[]): void {
    this.shown.delete(id);
    this.prompts.close(shown.promptId);
    this.registry.asked(id);
    const chose = shown.dialog.chose?.(lines);
    if (chose) this.registry.chooseModel(id, chose.model, chose.effort);
  }

  /** Types the keys of the chosen option. A dismissal presses the dialog's own way out, or leaves it to the terminal. */
  private answer(id: string, dialog: ScreenDialog, decision: PromptDecision): string | null {
    if (!decision.allow) {
      if (dialog.dismiss) void this.press(id, dialog.dismiss);
      return null;
    }
    const label = decision.answers?.[0]?.[0];
    const choice = dialog.choices.find((c) => c.label === label);
    if (!choice) return `pick one of: ${dialog.choices.map((c) => c.label).join(", ")}`;
    void this.press(id, choice);
    return null;
  }

  private async press(id: string, choice: DialogChoice): Promise<void> {
    try {
      // Owed before the keys go: the screen they lead to may be captured as soon as they land.
      if (choice.then) this.owed.set(id, { ...choice.then, until: this.now() + OWED_FOR_MS });
      for (const key of choice.keys) await this.registry.sendKey(id, key);
    } catch (e) {
      this.log.warn("Could not answer a dialog", { session: id, error: e });
    }
  }

  private payOwed(id: string, lines: string[]): void {
    const owed = this.owed.get(id);
    if (!owed) return;
    if (this.now() > owed.until) this.owed.delete(id);
    else if (owed.when(lines)) {
      this.owed.delete(id);
      this.registry.sendKey(id, owed.key).catch((e: unknown) => this.log.warn("Could not close what a dialog left open", { session: id, error: e }));
    }
  }
}
