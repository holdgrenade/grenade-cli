import { describe, expect, it } from "vitest";
import { claudeModeIn, enterClaudePlanMode, PlanModeError } from "../src/plans/claudePlanMode.js";

const footer = (mode: string) => ["╭──────╮", "│ > ", "╰──────╯", mode ? `  ${mode} (shift+tab to cycle)` : "  ? for shortcuts"];

/** A Claude Code whose Shift-Tab steps through `cycle`, starting at its first. */
function claude(cycle: string[]) {
  let at = 0;
  const typed: string[] = [];
  return {
    typed,
    term: {
      lines: async () => footer(cycle[at % cycle.length]!),
      type: async (text: string) => {
        typed.push(text);
        if (text === "\x1b[Z") at++;
      },
      key: async () => {},
    },
  };
}
const quick = { wait: async () => {}, patienceMs: 360 };

describe("Claude Code's plan mode", () => {
  it("reads the mode from the footer", () => {
    expect(claudeModeIn(footer("⏸ plan mode on"))).toBe("plan");
    expect(claudeModeIn(footer("⏵⏵ accept edits on"))).toBe("acceptEdits");
    expect(claudeModeIn(footer("⏵⏵ bypass permissions on"))).toBe("bypass");
    expect(claudeModeIn(footer(""))).toBe("default");
  });

  it("presses Shift-Tab until plan mode is on, and not at all when it is", async () => {
    const fromDefault = claude(["", "⏵⏵ accept edits on", "⏸ plan mode on"]);
    await enterClaudePlanMode(fromDefault.term, quick);
    expect(fromDefault.typed).toEqual(["\x1b[Z", "\x1b[Z"]);
    const already = claude(["⏸ plan mode on"]);
    await enterClaudePlanMode(already.term, quick);
    expect(already.typed).toEqual([]);
  });

  it("gives up when the footer never says plan mode", async () => {
    const stuck = claude([""]);
    await expect(enterClaudePlanMode(stuck.term, quick)).rejects.toBeInstanceOf(PlanModeError);
    expect(stuck.typed.length).toBe(5);
  });
});
