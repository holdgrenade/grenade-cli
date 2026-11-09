/**
 * Switches a Codex session into Plan mode (PROTOCOL.md "Plans", `session.mode`), as the person would: Shift-Tab moves
 * Codex between its modes (Default and Plan), and its footer says "Plan mode" while that one is on. This presses it
 * and looks after each press until the footer says so.
 */
import type { ModelTerminal } from "../models/claudeModelSwitch.js";
import { codexComposerIn, codexInPlanMode } from "../prompts/codexScreen.js";
import { PlanModeError, type PlanModeTiming } from "./claudePlanMode.js";
import { SHIFT_TAB } from "../prompts/codexTurnPrompts.js";

/** Codex's modes, and one more: a footer that never says Plan mode stops here. */
const MOST_PRESSES = 3;
const LOOK_EVERY_MS = 120;

const DEFAULT_TIMING: PlanModeTiming = { wait: (ms) => new Promise((done) => setTimeout(done, ms)), patienceMs: 1500 };

/** Presses Shift-Tab until Codex is in Plan mode; at once when it is. */
export async function enterCodexPlanMode(term: ModelTerminal, timing: PlanModeTiming = DEFAULT_TIMING): Promise<void> {
  let lines = await term.lines();
  if (codexInPlanMode(lines)) return;
  if (!codexComposerIn(lines)) throw new PlanModeError("Codex is not at its prompt. Wait for it, then ask again.");
  for (let press = 0; !codexInPlanMode(lines); press++) {
    if (press >= MOST_PRESSES) throw new PlanModeError("Codex did not go into Plan mode.");
    await term.type(SHIFT_TAB);
    for (let waited = 0; waited < timing.patienceMs; waited += LOOK_EVERY_MS) {
      await timing.wait(LOOK_EVERY_MS);
      lines = await term.lines();
      if (codexInPlanMode(lines)) break;
    }
  }
}
