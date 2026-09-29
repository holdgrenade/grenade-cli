import { describe, expect, it } from "vitest";
import { nextHistoryMark } from "../src/sessions/historyEpoch.js";

const pane = { cols: 46, historySize: 100, alternate: false };

describe("nextHistoryMark", () => {
  it("starts at epoch 0", () => {
    expect(nextHistoryMark(null, pane).epoch).toBe(0);
  });
  it("keeps the epoch while history only grows", () => {
    const a = nextHistoryMark(null, pane);
    expect(nextHistoryMark(a, { ...pane, historySize: 180 }).epoch).toBe(0);
  });
  it("bumps on a width change, a shrinking history, or the alternate screen", () => {
    const a = nextHistoryMark(null, pane);
    expect(nextHistoryMark(a, { ...pane, cols: 60 }).epoch).toBe(1);
    expect(nextHistoryMark(a, { ...pane, historySize: 40 }).epoch).toBe(1);
    expect(nextHistoryMark(a, { ...pane, alternate: true }).epoch).toBe(1);
  });
});
