import { describe, expect, it } from "vitest";
import type { KeyName } from "@grenade/protocol";
import { ModelSwitchError, switchClaudeModel, type ModelTerminal } from "../src/models/claudeModelSwitch.js";
import { switchScreen } from "./claudeDialogs.test.js";
import { pickerScreen } from "./claudeModelPicker.test.js";

const NAMES = ["Default (recommended)", "Opus 5.5", "Fable 5.1", "Sonnet 5.5", "Haiku 4.5", "Sonnet 5", "Opus 5", "Fable 5", "Opus 4.8"];
const LEVELS = ["low", "medium", "high", "xhigh", "max"];
const SHOWN: Record<string, string> = { low: "○ Low", medium: "◐ Medium", high: "● High", xhigh: "◉ xHigh", max: "◈ Max" };
const timing = { wait: async () => {}, patienceMs: 600 };

/** A terminal that behaves like Claude Code's prompt and picker. `draft` is text someone left in the prompt box. */
function fakeClaude(opts: { draft?: string; opens?: boolean; sessionOnly?: boolean; asksFirst?: boolean; confirms?: boolean } = {}) {
  let typed = opts.draft ?? "";
  let open = false;
  let cursor = 3;
  let level = 2;
  let said: string | null = null;
  let confirming = false;
  const pressed: string[] = [];
  const term: ModelTerminal = {
    async lines() {
      if (confirming) return switchScreen(NAMES[cursor - 1]);
      if (!open) return [...(said ? ["❯ /model", `  ⎿  ${said}`] : []), "────", `❯ ${typed}`, "────"];
      const effort = NAMES[cursor - 1] === "Haiku 4.5" ? "  ○ Effort not supported for Haiku 4.5" : `  ${SHOWN[LEVELS[level]!]} effort ←/→ to adjust`;
      return pickerScreen(cursor, effort, opts.sessionOnly === false ? "  Enter to confirm · Esc to cancel" : undefined);
    },
    async type(text) {
      pressed.push(text === "\x1b[C" ? "right" : text);
      if (!open) typed += text;
      else if (text === "\x1b[C") level = (level + 1) % LEVELS.length;
      else if (text === "s") {
        open = false;
        typed = "";
        confirming = opts.confirms === true;
        said = opts.asksFirst || confirming ? null : `Set model to ${NAMES[cursor - 1]} for this session only`;
      }
    },
    async key(key: KeyName) {
      pressed.push(key);
      if (key === "backspace") typed = typed.slice(0, -1);
      else if (key === "enter" && !open) open = opts.opens !== false && typed === "/model";
      else if (key === "escape") { open = false; typed = ""; }
      // The list wraps, as Claude Code's does (nine rows here).
      else if (key === "up" && open) cursor = cursor === 1 ? NAMES.length : cursor - 1;
      else if (key === "down" && open) cursor = cursor === NAMES.length ? 1 : cursor + 1;
    },
  };
  return { term, pressed, typedNow: () => typed, isOpen: () => open };
}

describe("switchClaudeModel", () => {
  it("opens the picker, moves to the model, sets the effort and confirms for this session only", async () => {
    const claude = fakeClaude();
    await expect(switchClaudeModel(claude.term, "Opus 5.5", "max", timing)).resolves.toEqual({ effort: "max" });
    expect(claude.pressed).toEqual(["/model", "enter", "up", "right", "right", "s"]);
  });
  it("reaches a row below the cursor, and wraps the effort around to a lower level", async () => {
    const claude = fakeClaude();
    await expect(switchClaudeModel(claude.term, "Sonnet 5.5", "low", timing)).resolves.toEqual({ effort: "low" });
    expect(claude.pressed).toEqual(["/model", "enter", "down", "right", "right", "right", "s"]);
  });
  it("keeps the picker's level when none is asked for, and reports none for a model that takes none", async () => {
    await expect(switchClaudeModel(fakeClaude().term, "Fable 5.1", undefined, timing)).resolves.toEqual({ effort: "high" });
    await expect(switchClaudeModel(fakeClaude().term, "Haiku 4.5", undefined, timing)).resolves.toEqual({ effort: undefined });
  });
  it("never presses Enter over text someone left in the prompt, and takes its own text back out", async () => {
    const claude = fakeClaude({ draft: "fix the tests" });
    await expect(switchClaudeModel(claude.term, "Opus 5.5", "high", timing)).rejects.toThrow(/prompt is not empty/);
    expect(claude.pressed).not.toContain("enter");
    expect(claude.typedNow()).toBe("fix the tests");
  });
  it("closes a picker that cannot switch one session only, without choosing", async () => {
    const claude = fakeClaude({ sessionOnly: false });
    await expect(switchClaudeModel(claude.term, "Opus 5.5", "high", timing)).rejects.toThrow(/Update Claude Code/);
    expect(claude.pressed).toEqual(["/model", "enter", "escape"]);
  });
  it("gives up on a model the picker does not have, and closes it", async () => {
    const claude = fakeClaude();
    await expect(switchClaudeModel(claude.term, "Opus 9", undefined, timing)).rejects.toBeInstanceOf(ModelSwitchError);
    expect(claude.isOpen()).toBe(false);
    expect(claude.pressed).not.toContain("s");
  });
  it("gives up on an effort level the model does not have", async () => {
    const claude = fakeClaude();
    await expect(switchClaudeModel(claude.term, "Haiku 4.5", "high", timing)).rejects.toThrow(/no high effort/);
    expect(claude.pressed).not.toContain("s");
  });
  it("stops at Claude Code's \"Switch model?\" with the screen that asks, pressing nothing in it", async () => {
    const claude = fakeClaude({ confirms: true });
    await expect(switchClaudeModel(claude.term, "Opus 5.5", "max", timing)).resolves.toEqual({ effort: "max", asks: switchScreen("Opus 5.5") });
    expect(claude.pressed).toEqual(["/model", "enter", "up", "right", "right", "s"]);
  });
  it("says so when the picker never opens, or Claude Code asks something else first", async () => {
    await expect(switchClaudeModel(fakeClaude({ opens: false }).term, "Opus 5.5", undefined, timing)).rejects.toThrow(/did not open/);
    await expect(switchClaudeModel(fakeClaude({ asksFirst: true }).term, "Opus 5.5", undefined, timing)).rejects.toThrow(/asked something/);
  });
});
