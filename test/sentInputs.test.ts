import { describe, expect, it } from "vitest";
import { SENT_INPUTS_MAX, SENT_INPUTS_TTL_MS, SentInputs } from "../src/daemon/sentInputs.js";

describe("SentInputs", () => {
  it("types a key once, however often it comes", async () => {
    const inputs = new SentInputs();
    let typed = 0;
    const type = async () => { typed += 1; };
    await inputs.once("a", type);
    await inputs.once("a", type);
    await inputs.once("b", type);
    expect(typed).toBe(2);
  });

  it("makes a repeat that comes while the first is typing wait for it", async () => {
    const inputs = new SentInputs();
    let finish = () => {};
    let typed = 0;
    const first = inputs.once("a", () => { typed += 1; return new Promise<void>((r) => { finish = r; }); });
    let repeatDone = false;
    const repeat = inputs.once("a", async () => { typed += 1; }).then(() => { repeatDone = true; });
    await Promise.resolve();
    expect(repeatDone).toBe(false);
    finish();
    await Promise.all([first, repeat]);
    expect(repeatDone).toBe(true);
    expect(typed).toBe(1);
  });

  it("forgets a key whose typing failed, so the next try types it", async () => {
    const inputs = new SentInputs();
    await expect(inputs.once("a", async () => { throw new Error("tmux"); })).rejects.toThrow("tmux");
    let typed = 0;
    await inputs.once("a", async () => { typed += 1; });
    expect(typed).toBe(1);
  });

  it("forgets keys after ten minutes and beyond the last thousand", async () => {
    let now = 0;
    const inputs = new SentInputs(() => now);
    await inputs.once("old", async () => {});
    now = SENT_INPUTS_TTL_MS + 1;
    let typed = 0;
    await inputs.once("old", async () => { typed += 1; });
    expect(typed).toBe(1);
    for (let i = 0; i < SENT_INPUTS_MAX + 5; i++) await inputs.once(`k${i}`, async () => {});
    expect(inputs.size).toBeLessThanOrEqual(SENT_INPUTS_MAX);
  });
});
