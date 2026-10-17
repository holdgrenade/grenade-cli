import { describe, expect, it } from "vitest";
import { WIDTH_FLOOR, onRelease, onSweep, parseWindowWidths } from "../src/sessions/widthFloor.js";

describe("width floor", () => {
  it("gives the width back to the terminals unless they are all narrower than the floor", () => {
    expect(onRelease({ width: 151, widest: WIDTH_FLOOR })).toBe("follow");
    expect(onRelease({ width: 151, widest: 11 })).toBe("floor");
  });

  it("keeps a wide window's width when no Mac terminal is attached, so the agent goes on writing at it", () => {
    expect(onRelease({ width: 151, widest: null })).toBe("keep");
    expect(onRelease({ width: WIDTH_FLOOR, widest: null })).toBe("keep");
    // A phone's width does not stay behind it.
    expect(onRelease({ width: 46, widest: null })).toBe("follow");
    expect(onRelease(undefined)).toBe("follow");
  });

  it("sweeps: floors a narrow window, fits the widest terminal, and lets a held window follow once one is wide", () => {
    expect(onSweep({ width: 11, widest: 11 }, false)).toBe("floor");
    expect(onSweep({ width: 11, widest: null }, false)).toBe("floor");
    expect(onSweep({ width: 11, widest: 120 }, false)).toBe("follow");
    expect(onSweep({ width: 80, widest: 11 }, false)).toBeNull();
    expect(onSweep({ width: WIDTH_FLOOR, widest: 11 }, true)).toBeNull();
    expect(onSweep({ width: WIDTH_FLOOR, widest: null }, true)).toBeNull();
    expect(onSweep({ width: WIDTH_FLOOR, widest: 90 }, true)).toBe("follow");
  });

  it("reads tmux's lists, leaving Grenade's own control-mode clients out", () => {
    const widths = parseWindowWidths(
      "gr-a 11\ngr-b 58\ngr-c 80\n",
      "gr-a 0 11\ngr-a 0 12\ngr-a 1 48\ngr-b 1 58\n",
    );
    expect(widths.get("gr-a")).toEqual({ width: 11, widest: 12 });
    expect(widths.get("gr-b")).toEqual({ width: 58, widest: null });
    expect(widths.get("gr-c")).toEqual({ width: 80, widest: null });
  });
});
