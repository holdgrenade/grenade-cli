/**
 * Switches a Claude Code session into plan mode (PROTOCOL.md "Plans", `session.mode`), as the person would: Shift-Tab
 * cycles Claude Code's modes (as asked, accepting edits, plan, and bypassing permissions where that is on), and its
 * footer says which is on. This presses it and looks after each press, until the footer says plan mode is on.
 */
import type { ModelTerminal } from "../models/claudeModelSwitch.js";

/** Shift-Tab as a terminal sends it (back tab): `KeyName` has none. */
const SHIFT_TAB = "\x1b[Z";
/** The modes Claude Code cycles through, and one more: a footer that never says plan mode stops here. */
const MOST_PRESSES = 5;
const LOOK_EVERY_MS = 120;

export interface PlanModeTiming {
  wait(ms: number): Promise<void>;
  /** How long to look for the footer to change after a press. */
  patienceMs: number;
}

const DEFAULT_TIMING: PlanModeTiming = { wait: (ms) => new Promise((done) => setTimeout(done, ms)), patienceMs: 1500 };

/** The agent did not go into plan mode. The message is for the person who asked. */
export class PlanModeError extends Error {}

/** Which mode Claude Code's footer says is on, from the screen's last rows. Pure. */
export function claudeModeIn(lines: readonly string[]): "plan" | "acceptEdits" | "bypass" | "default" {
  const footer = lines.slice(-8).join("\n").toLowerCase();
  if (footer.includes("plan mode on")) return "plan";
  if (footer.includes("accept edits on")) return "acceptEdits";
  if (footer.includes("bypass permissions on")) return "bypass";
  return "default";
}

/** Presses Shift-Tab until plan mode is on; at once when it is. */
export async function enterClaudePlanMode(term: ModelTerminal, timing: PlanModeTiming = DEFAULT_TIMING): Promise<void> {
  let mode = claudeModeIn(await term.lines());
  for (let press = 0; mode !== "plan"; press++) {
    if (press >= MOST_PRESSES) throw new PlanModeError("Claude Code did not go into plan mode.");
    const before = mode;
    await term.type(SHIFT_TAB);
    // Look until the footer moves on from the mode it said before the press.
    for (let waited = 0; waited < timing.patienceMs; waited += LOOK_EVERY_MS) {
      await timing.wait(LOOK_EVERY_MS);
      mode = claudeModeIn(await term.lines());
      if (mode !== before) break;
    }
  }
}
