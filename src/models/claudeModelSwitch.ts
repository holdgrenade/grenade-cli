/**
 * Switches a Claude Code session to another model for that session only (PROTOCOL.md "Models"), by steering its
 * `/model` picker in the terminal: open it, move to the model's row, set the effort, press "s". The saved default in
 * Claude Code's settings is never touched: Enter, which saves it, is pressed only to open the picker.
 * In a conversation that has messages Claude Code then asks "Switch model?" (the history is cached for the model it
 * had): that question is the user's to answer, so the switch ends there, with the screen that asks (`asks`).
 * The screen logic is in `claudeModelPicker.ts`; this file only types and looks.
 */
import type { KeyName } from "@grenade/protocol";
import { claudeDialogIn } from "../prompts/claudeDialogs.js";
import { modelPickerIn, promptText, rowsDownTo, selectedModel, switchedModelIn, type ModelPicker } from "./claudeModelPicker.js";

/** The session's terminal, as much of it as a switch needs. */
export interface ModelTerminal {
  /** The visible rows, as plain text. */
  lines(): Promise<string[]>;
  /** Types `text` as it is, without Enter. */
  type(text: string): Promise<void>;
  key(key: KeyName): Promise<void>;
}

/** The agent did not switch. The message is for the person who asked. */
export class ModelSwitchError extends Error {}

/** What a `session.model` is answered with when Claude Code asks first: the question is a card in the session by then. */
export const MODEL_ASKS = "Claude Code asks before it switches. Answer its question in the session.";

export interface ModelSwitchTiming {
  wait(ms: number): Promise<void>;
  /** How long to look for each change on the screen. */
  patienceMs: number;
}

const COMMAND = "/model";
/** The Right arrow as a terminal sends it: `KeyName` has no arrow but up and down. */
const RIGHT = "\x1b[C";
const LOOK_EVERY_MS = 120;
/** More rows than the picker has, and more effort levels than a model has: a cursor that never arrives stops here. */
const MOST_MOVES = 20;
/** Typed text shows at once: no need to wait long before saying the prompt holds something else. */
const TYPED_PATIENCE_MS = 1500;
const MOST_EFFORT_STEPS = 8;

const DEFAULT_TIMING: ModelSwitchTiming = { wait: (ms) => new Promise((done) => setTimeout(done, ms)), patienceMs: 5000 };

export interface ModelSwitched {
  /** The effort level the session has once it runs the model. */
  effort: string | undefined;
  /**
   * Claude Code asks before it switches: the screen that shows its question. The model is chosen, not yet switched
   * to; the answer to the question decides (PROTOCOL.md "Claude Code dialogs").
   */
  asks?: string[];
}

/** Switches to `model` (a row of the picker, "Opus 5.5"), as far as Claude Code lets it without asking the user. */
export async function switchClaudeModel(
  term: ModelTerminal,
  model: string,
  effort: string | undefined,
  timing: ModelSwitchTiming = DEFAULT_TIMING,
): Promise<ModelSwitched> {
  /** Looks until `read` finds something, or patience runs out. */
  const look = async <T>(read: (lines: string[]) => T | null | undefined, patienceMs = timing.patienceMs): Promise<T | null> => {
    for (let waited = 0; ; waited += LOOK_EVERY_MS) {
      const found = read(await term.lines());
      if (found !== null && found !== undefined) return found;
      if (waited >= patienceMs) return null;
      await timing.wait(LOOK_EVERY_MS);
    }
  };
  const picker = async (): Promise<ModelPicker | null> => modelPickerIn(await term.lines());
  /** Closes the picker without choosing, and says why. */
  const giveUp = async (why: string): Promise<never> => {
    await term.key("escape");
    throw new ModelSwitchError(why);
  };

  if (await picker()) throw new ModelSwitchError("The model picker is already open in the terminal.");

  // Type the command without Enter first: on top of text someone left in the prompt box it would be sent as a prompt.
  await term.type(COMMAND);
  if (!(await look((lines) => (promptText(lines) === COMMAND ? true : null), Math.min(timing.patienceMs, TYPED_PATIENCE_MS)))) {
    for (let i = 0; i < COMMAND.length; i++) await term.key("backspace");
    throw new ModelSwitchError("Claude Code's prompt is not empty. Send or clear what is typed there, then choose again.");
  }
  await term.key("enter");
  let open = await look(modelPickerIn);
  if (!open) throw new ModelSwitchError("Claude Code did not open its model picker.");
  if (!open.sessionOnly) await giveUp("This Claude Code cannot switch one session only. Update Claude Code, then choose again.");

  for (let moves = 0; selectedModel(open) !== model; moves++) {
    if (moves >= MOST_MOVES) await giveUp(`Claude Code's picker has no ${model}.`);
    // A row that is not on screen is above: the rows Grenade offers are the first ones.
    const down = rowsDownTo(open, model);
    await term.key(down !== null && down > 0 ? "down" : "up");
    await timing.wait(LOOK_EVERY_MS);
    open = (await picker()) ?? (await giveUp("Claude Code closed its model picker."));
  }

  if (effort !== undefined) {
    for (let steps = 0; open.effort !== effort; steps++) {
      if (steps >= MOST_EFFORT_STEPS) await giveUp(`${model} has no ${effort} effort in Claude Code.`);
      await term.type(RIGHT);
      await timing.wait(LOOK_EVERY_MS);
      open = (await picker()) ?? (await giveUp("Claude Code closed its model picker."));
    }
  }
  const chosenEffort = open.effort ?? undefined;

  await term.type("s");
  const closed = await look((lines) => (modelPickerIn(lines) ? null : lines));
  if (!closed) await giveUp("Claude Code did not take the choice.");
  // The line that confirms it comes a moment after the picker closes; so does the question, when Claude Code asks.
  const after = await look((lines) => (claudeDialogIn(lines) ? { asks: lines } : switchedModelIn(lines) === model ? {} : null));
  if (!after) throw new ModelSwitchError("Claude Code asked something before switching. Answer it in the terminal.");
  return { effort: chosenEffort, ...after };
}
