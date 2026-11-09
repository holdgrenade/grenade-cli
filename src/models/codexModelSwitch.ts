/**
 * Switches a Codex session to another model and effort for that session only (PROTOCOL.md "Models"), by steering its
 * `/model` picker as the person would: type `/model`, move to the model and press Enter (which opens its levels and
 * saves nothing), move to the level (through "More reasoning…" for Max and Ultra) and press "s", for this session.
 * Enter on a level would save it as Codex's default, so it is never pressed there. Codex's screen says "Model changed
 * to <slug> <effort> for this session only" when it took it. The screen logic is in `codexModelPicker.ts`.
 */
import type { KeyName } from "@grenade/protocol";
import { codexInPlanMode } from "../prompts/codexScreen.js";
import { ModelSwitchError, type ModelSwitchTiming, type ModelSwitched, type ModelTerminal } from "./claudeModelSwitch.js";
import { codexComposerText, codexEffortMenuIn, codexModelMenuIn, codexSwitchedIn, hasMore, movesTo, offersSessionOnly, type PickerMenu } from "./codexModelPicker.js";
import type { CodexModel } from "./codexModels.js";

const COMMAND = "/model";
const LOOK_EVERY_MS = 120;
/** Codex reads fast typing followed by Enter as a paste and keeps the Enter as a newline: a pause tells them apart. */
const BEFORE_ENTER_MS = 400;
const TYPED_PATIENCE_MS = 1500;

const DEFAULT_TIMING: ModelSwitchTiming = { wait: (ms) => new Promise((done) => setTimeout(done, ms)), patienceMs: 5000 };

/** The effort a switch ends on: the one asked for, else the session's when the model takes it, else the model's default. */
export function effortFor(model: CodexModel, asked: string | undefined, current: string | undefined): string | undefined {
  if (asked !== undefined) return asked;
  if (current !== undefined && model.efforts.includes(current)) return current;
  return model.defaultEffort ?? model.efforts[0];
}

/** Switches to `model` with `effort` (`effortFor` already applied), for this session only. */
export async function switchCodexModel(term: ModelTerminal, model: CodexModel, effort: string | undefined, timing: ModelSwitchTiming = DEFAULT_TIMING): Promise<ModelSwitched> {
  const look = async <T>(read: (lines: string[]) => T | null | undefined, patienceMs = timing.patienceMs): Promise<T | null> => {
    for (let waited = 0; ; waited += LOOK_EVERY_MS) {
      const found = read(await term.lines());
      if (found !== null && found !== undefined) return found;
      if (waited >= patienceMs) return null;
      await timing.wait(LOOK_EVERY_MS);
    }
  };
  const giveUp = async (why: string): Promise<never> => {
    // Out of the levels, then out of the models: the session is at its prompt again, nothing chosen.
    for (let i = 0; i < 3 && (codexModelMenuIn(await term.lines()) || codexEffortMenuIn(await term.lines())); i++) {
      await term.key("escape");
      await timing.wait(LOOK_EVERY_MS);
    }
    throw new ModelSwitchError(why);
  };
  /** Moves the cursor of the menu `read` finds onto `row`, a press at a time, looking after each. */
  const moveTo = async (read: (lines: string[]) => PickerMenu | null, row: string, missing: string): Promise<void> => {
    for (let presses = 0; ; presses++) {
      const menu = read(await term.lines()) ?? (await giveUp("Codex closed its model picker."));
      const moves = movesTo(menu, row);
      if (moves === null || presses > 20) await giveUp(missing);
      if (moves === 0) return;
      const key: KeyName = moves! > 0 ? "down" : "up";
      await term.key(key);
      await timing.wait(LOOK_EVERY_MS);
    }
  };

  const before = await term.lines();
  if (codexModelMenuIn(before) || codexEffortMenuIn(before)) throw new ModelSwitchError("Codex's model picker is already open in the terminal.");
  // In Plan mode Codex asks where a level should apply, and its answers save it: choose in Default mode.
  if (codexInPlanMode(before)) throw new ModelSwitchError("Codex is in Plan mode, where a model chosen is saved for Plan mode. Leave Plan mode (Shift-Tab), then choose again.");
  if (codexComposerText(before) !== "") throw new ModelSwitchError("Codex's prompt is not empty. Send or clear what is typed there, then choose again.");

  await term.type(COMMAND);
  if (!(await look((lines) => (codexComposerText(lines) === COMMAND ? true : null), Math.min(timing.patienceMs, TYPED_PATIENCE_MS)))) {
    for (let i = 0; i < COMMAND.length; i++) await term.key("backspace");
    throw new ModelSwitchError("Codex did not take the /model command.");
  }
  await timing.wait(BEFORE_ENTER_MS);
  await term.key("enter");
  if (!(await look(codexModelMenuIn))) throw new ModelSwitchError("Codex did not open its model picker.");

  await moveTo(codexModelMenuIn, model.name, `Codex's picker has no ${model.name}.`);
  await term.key("enter");
  const levels = await look(codexEffortMenuIn);
  if (!levels) await giveUp(`Codex did not offer ${model.name}'s reasoning levels. Look at the terminal.`);
  const target = effort ?? model.defaultEffort;
  if (target === undefined) await giveUp(`${model.name} has no reasoning level to choose.`);
  if (!levels!.rows.includes(target!)) {
    if (!hasMore(levels!)) await giveUp(`${model.name} has no ${target} reasoning in Codex.`);
    await moveTo(codexEffortMenuIn, "more", `${model.name} has no ${target} reasoning in Codex.`);
    await term.key("enter");
    const advanced = await look((lines) => (codexEffortMenuIn(lines)?.advanced ? true : null));
    if (!advanced) await giveUp("Codex did not open its advanced reasoning levels.");
  }
  await moveTo(codexEffortMenuIn, target!, `${model.name} has no ${target} reasoning in Codex.`);
  // Enter would save the level as Codex's default: only "s" is pressed, and only where the picker offers it.
  if (!(await look((lines) => (offersSessionOnly(lines) ? true : null), TYPED_PATIENCE_MS))) await giveUp("This Codex cannot switch one session only. Update Codex, then choose again.");
  await term.type("s");
  const switched = await look((lines) => {
    const s = codexSwitchedIn(lines);
    return s && s.slug === model.slug && !codexEffortMenuIn(lines) ? s : null;
  });
  if (!switched) await giveUp("Codex did not take the choice. Look at the terminal.");
  return { effort: switched!.effort ?? target };
}
