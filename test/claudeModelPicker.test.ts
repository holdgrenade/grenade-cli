import { describe, expect, it } from "vitest";
import { modelPickerIn, promptText, rowsDownTo, selectedModel, switchedModelIn } from "../src/models/claudeModelPicker.js";

/** Claude Code 2.1.289's picker as tmux captured it, the cursor on `cursor` and that row's effort line. */
export function pickerScreen(cursor: number, effortLine = "  ◐ Medium effort (default) ←/→ to adjust", footer = "  Enter to set as default · s to use this session only · Esc to cancel"): string[] {
  const rows = [
    "1.  Default (recommended)  Fable 5.1",
    "2.  Opus 5.5               For complex work and everyday tasks",
    "3.  Fable 5.1 ✔            For your toughest challenges",
    "4.  Sonnet 5.5             Most efficient for simpler tasks",
    "5.  Haiku 4.5              Fastest for quick answers",
    "6.  Sonnet 5               Efficient for routine tasks",
    "7.  Opus 5                 Best for everyday, complex tasks",
    "8.  Fable 5                Most capable for your hardest and longest-running tasks",
    "9.  Opus 4.8               Best for everyday, complex tasks",
  ].map((row, i) => `${i + 1 === cursor ? "  ❯ " : "    "}${row}`);
  return [
    " ▐▛███▛█   Claude Code v2.1.289",
    "▝▜██████▀  Fable 5.1 with high effort · Claude Max",
    "",
    "❯ /model",
    "──────────────────────────────────────────",
    "  Select model",
    "  Switch between Claude models. Your pick becomes the default for new sessions. For other/previous model",
    "  names, specify with --model.",
    "",
    ...rows,
    "  ↓ 10. Opus 4.7               Best for everyday, complex tasks",
    "     … +2 models",
    "",
    effortLine,
    "",
    footer,
  ];
}

describe("modelPickerIn", () => {
  it("reads the rows, the cursor, the effort level and the session-only key", () => {
    const picker = modelPickerIn(pickerScreen(2))!;
    expect(picker.rows.map((r) => r.name)).toEqual(["Default (recommended)", "Opus 5.5", "Fable 5.1", "Sonnet 5.5", "Haiku 4.5", "Sonnet 5", "Opus 5", "Fable 5", "Opus 4.8", "Opus 4.7"]);
    expect(selectedModel(picker)).toBe("Opus 5.5");
    expect(picker.effort).toBe("medium");
    expect(picker.sessionOnly).toBe(true);
  });
  it("names the current model without its check mark", () => {
    expect(selectedModel(modelPickerIn(pickerScreen(3, "  ● High effort (default) ←/→ to adjust"))!)).toBe("Fable 5.1");
  });
  it.each([
    ["  ○ Low effort ←/→ to adjust", "low"],
    ["  ● High effort ←/→ to adjust", "high"],
    ["  ◉ xHigh effort ←/→ to adjust", "xhigh"],
    ["  ◈ Max effort ←/→ to adjust", "max"],
  ])("reads %s as %s", (line, level) => expect(modelPickerIn(pickerScreen(2, line))?.effort).toBe(level));
  it("reads no effort level for a model that takes none", () => {
    expect(modelPickerIn(pickerScreen(5, "  ○ Effort not supported for Haiku 4.5"))?.effort).toBeNull();
  });
  it("says when the picker has no session-only key", () => {
    expect(modelPickerIn(pickerScreen(2, undefined, "  Enter to confirm · Esc to cancel"))?.sessionOnly).toBe(false);
  });
  it("is null on a screen without the picker", () => {
    expect(modelPickerIn(["❯ /model", "  ⎿  Set model to Opus 5.5 for this session only with low effort", "❯ "])).toBeNull();
    expect(modelPickerIn([])).toBeNull();
  });
});

describe("rowsDownTo", () => {
  it("counts rows from the cursor, down or up", () => {
    const picker = modelPickerIn(pickerScreen(3))!;
    expect(rowsDownTo(picker, "Haiku 4.5")).toBe(2);
    expect(rowsDownTo(picker, "Opus 5.5")).toBe(-1);
    expect(rowsDownTo(picker, "Fable 5.1")).toBe(0);
    expect(rowsDownTo(picker, "Opus 3")).toBeNull();
  });
});

describe("promptText", () => {
  it("is what the last prompt line holds, no-break spaces and all", () => {
    expect(promptText(["❯ /model", "  ⎿  Kept model as Fable 5.1", "────", "❯ /model", "────"])).toBe("/model");
    expect(promptText(["────", "❯ ", "────"])).toBe("");
    expect(promptText(["❯ fix the tests/model"])).toBe("fix the tests/model");
    expect(promptText(["$ ls"])).toBeNull();
  });
});

describe("switchedModelIn", () => {
  it("names the model of the last switch on the screen", () => {
    expect(switchedModelIn(["  ⎿  Kept model as Fable 5.1", "❯ /model", "  ⎿  Set model to Opus 5.5 for this session only with low effort", "❯ "])).toBe("Opus 5.5");
    expect(switchedModelIn(["  ⎿  Set model to Opus 5.5 for this session only", "❯ /model", "  ⎿  Kept model as Fable 5.1"])).toBe("Fable 5.1");
    expect(switchedModelIn(["❯ "])).toBeNull();
  });
});
