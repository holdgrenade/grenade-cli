import { describe, expect, it } from "vitest";
import { waitForSettle } from "../src/tmux/pasteSettle.js";

const opts = { intervalMs: 100, quietReads: 2, maxMs: 2000 };

/** Reads `screens` in turn (the last one again once they run out); counts the time slept. */
function pane(screens: string[]) {
  let i = 0;
  const clock = { slept: 0 };
  const read = async () => screens[Math.min(i++, screens.length - 1)]!;
  const sleep = async (ms: number) => { clock.slept += ms; };
  return { read, sleep, clock };
}

describe("waitForSettle", () => {
  it("returns once the pane changed and then held still", async () => {
    const p = pane(["pasted", "pasted", "pasted"]);
    await waitForSettle("empty", p.read, p.sleep, opts);
    expect(p.clock.slept).toBe(300);
  });
  it("waits through a second change (the picture path turning into [Image #1])", async () => {
    const p = pane(["pasted /a.png", "pasted /a.png", "[Image #1] pasted", "[Image #1] pasted", "[Image #1] pasted"]);
    await waitForSettle("empty", p.read, p.sleep, { ...opts, quietReads: 3 });
    expect(p.clock.slept).toBe(600);
  });
  it("does not take the screen from before the paste for a settled one", async () => {
    const p = pane(["empty", "empty", "empty", "pasted", "pasted", "pasted"]);
    await waitForSettle("empty", p.read, p.sleep, opts);
    expect(p.clock.slept).toBe(600);
  });
  it("gives up after maxMs on a pane that never holds still", async () => {
    let n = 0;
    const clock = { slept: 0 };
    await waitForSettle("empty", async () => `spinner ${n++}`, async (ms) => { clock.slept += ms; }, opts);
    expect(clock.slept).toBe(2000);
  });
  it("gives up after maxMs on a pane that never changes", async () => {
    const p = pane(["empty"]);
    await waitForSettle("empty", p.read, p.sleep, opts);
    expect(p.clock.slept).toBe(2000);
  });
});
