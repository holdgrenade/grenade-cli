import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FORGET_AFTER_MS, PairingPause, pauseFor, pauseWords } from "../src/daemon/pairingPause.js";
import { pausedLines, remainingWords } from "../src/pairing/pausedLines.js";

const MIN = 60_000;

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

describe("PairingPause", () => {
  it("pauses on every fifth wrong try, for 1 min, 10 min, 1 h, then 24 h", () => {
    const c = clock();
    const p = new PairingPause(undefined, c.now);
    const lengths: number[] = [];
    for (let strike = 1; strike <= 5; strike++) {
      for (let i = 1; i < 5; i++) expect(p.wrong("lan")).toBeNull();
      const s = p.wrong("relay");
      expect(s?.strike).toBe(strike);
      expect(s?.route).toBe("relay");
      lengths.push(s!.pausedUntil - s!.at);
      c.advance(s!.pausedUntil - s!.at);
    }
    expect(lengths).toEqual([MIN, 10 * MIN, 60 * MIN, 24 * 60 * MIN, 24 * 60 * MIN]);
  });

  it("is paused until the end, then open again", () => {
    const c = clock();
    const p = new PairingPause(undefined, c.now);
    for (let i = 0; i < 5; i++) p.wrong("lan");
    expect(p.pausedUntil()).toBe(c.now() + MIN);
    c.advance(MIN - 1);
    expect(p.pausedUntil()).not.toBeNull();
    c.advance(1);
    expect(p.pausedUntil()).toBeNull();
  });

  it("starts again after a pairing", () => {
    const c = clock();
    const p = new PairingPause(undefined, c.now);
    for (let i = 0; i < 5; i++) p.wrong("lan");
    c.advance(MIN);
    p.succeeded();
    for (let i = 0; i < 4; i++) expect(p.wrong("lan")).toBeNull();
    expect(p.wrong("lan")?.strike).toBe(1);
  });

  it("forgets a day after the last wrong try", () => {
    const c = clock();
    const p = new PairingPause(undefined, c.now);
    for (let i = 0; i < 5; i++) p.wrong("lan");
    for (let i = 0; i < 4; i++) p.wrong("lan");
    c.advance(FORGET_AFTER_MS + 1);
    expect(p.wrong("lan")).toBeNull();
    for (let i = 0; i < 3; i++) p.wrong("lan");
    expect(p.wrong("lan")?.strike).toBe(1);
  });

  it("survives a restart", () => {
    const path = join(mkdtempSync(join(tmpdir(), "gr-pause-")), "pairing-pause.json");
    const c = clock();
    const a = new PairingPause(path, c.now);
    for (let i = 0; i < 5; i++) a.wrong("lan");
    const b = new PairingPause(path, c.now);
    expect(b.pausedUntil()).toBe(c.now() + MIN);
    expect(b.status().strikes).toBe(1);
    expect(b.status().lastStrike?.route).toBe("lan");
  });

  it("names the steps", () => {
    expect([1, 2, 3, 4, 9].map(pauseFor).map(pauseWords)).toEqual(["1 minute", "10 minutes", "1 hour", "24 hours", "24 hours"]);
  });
});

describe("pausedLines", () => {
  it("says how long is left and that nothing ends it early", () => {
    const text = pausedLines(1_000_000 + 581_000, 1_000_000, { at: 0, route: "relay" }).join("\n");
    expect(text).toContain("Pairing is paused for 9 min 41 s.");
    expect(text).toContain("through the relay");
    expect(text).toContain("Nothing can end a pause early.");
  });

  it("puts the time left in words", () => {
    expect(remainingWords(42_000)).toBe("42 s");
    expect(remainingWords(60_000)).toBe("1 min");
    expect(remainingWords(3_900_000)).toBe("1 h 5 min");
  });
});
