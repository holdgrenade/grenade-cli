/**
 * Codex's startup dialogs as prompts (PROTOCOL.md "Codex dialogs"): when a Codex session's screen shows one
 * (`codexDialogIn`), the session waits for an answer and every phone gets a `question` card; the answer is typed as
 * the keys that pick its option. The card closes when the screen no longer shows the dialog, however it was answered.
 */
import type { AgentKind, KeyName, PromptDecision } from "@grenade/protocol";
import type { Logger } from "../log.js";
import { codexDialogIn, type CodexDialog } from "./codexDialogs.js";
import type { PromptStore } from "./promptStore.js";

export interface ScreenPromptsPort {
  on(event: "captured", cb: (id: string, agent: AgentKind, lines: string[]) => void): unknown;
  asks(id: string): void;
  sendKey(id: string, key: KeyName): Promise<void>;
}

interface Shown {
  dialog: CodexDialog["id"];
  promptId: string;
}

export class ScreenPrompts {
  /** The dialog each session's card is for. */
  private readonly shown = new Map<string, Shown>();

  constructor(
    private readonly registry: ScreenPromptsPort,
    private readonly prompts: PromptStore,
    private readonly log: Logger,
  ) {
    registry.on("captured", (id, agent, lines) => {
      if (agent === "codex") this.look(id, lines);
    });
    prompts.on("closed", (frame) => {
      if (this.shown.get(frame.sessionId)?.promptId === frame.promptId) this.shown.delete(frame.sessionId);
    });
  }

  private look(id: string, lines: string[]): void {
    const dialog = codexDialogIn(lines);
    const shown = this.shown.get(id);
    if (shown && shown.dialog === dialog?.id) return;
    // The dialog went away, or another took its place: the Mac answered it.
    if (shown) this.prompts.close(shown.promptId);
    if (!dialog) return;
    this.registry.asks(id);
    const frame = this.prompts.openScreen(id, dialog.body, (decision) => this.answer(id, dialog, decision));
    this.shown.set(id, { dialog: dialog.id, promptId: frame.promptId });
    this.log.debug(`Codex shows a dialog: ${dialog.id}`, { session: id });
  }

  /** Types the keys of the chosen option. A dismissal leaves the dialog to the terminal. */
  private answer(id: string, dialog: CodexDialog, decision: PromptDecision): string | null {
    if (!decision.allow) return null;
    const label = decision.answers?.[0]?.[0];
    const choice = dialog.choices.find((c) => c.label === label);
    if (!choice) return `pick one of: ${dialog.choices.map((c) => c.label).join(", ")}`;
    void this.press(id, choice.keys);
    return null;
  }

  private async press(id: string, keys: KeyName[]): Promise<void> {
    try {
      for (const key of keys) await this.registry.sendKey(id, key);
    } catch (e) {
      this.log.warn("Could not answer a Codex dialog", { session: id, error: e });
    }
  }
}
