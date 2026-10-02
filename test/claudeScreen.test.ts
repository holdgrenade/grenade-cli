import { describe, expect, it } from "vitest";
import { claudeIsWorking } from "../src/activity/claudeScreen.js";

const box = ["───────────────", "❯ ", "───────────────"];

describe("claudeIsWorking", () => {
  it("sees the spinner line, even cut short on a phone-wide pane", () => {
    expect(claudeIsWorking(["✻ Elucidating… (1m 28s · thought for 11s)", "", ...box, "  ⏵⏵ auto mode on · esc…"])).toBe(true);
    expect(claudeIsWorking(["· Thinking… (3s · ↓ 120 tokens)", ...box])).toBe(true);
    expect(claudeIsWorking(["✶ Pondering…(2s", ...box])).toBe(true);
  });
  it("sees the footer's esc to interrupt", () => {
    expect(claudeIsWorking([...box, "  esc to interrupt"])).toBe(true);
  });
  it("is quiet at the prompt, after an interrupt or a finished turn", () => {
    expect(claudeIsWorking(["  ⎿  Interrupted · What should Claude do instead?", "", ...box, "  ⏵⏵ auto mode on (shift+tab to cycle)"])).toBe(false);
    expect(claudeIsWorking(["✻ Worked for 1m 3s", "", ...box])).toBe(false);
    expect(claudeIsWorking(["⏺ Done. The tests pass… mostly (see below)", ...box])).toBe(false);
  });
});
