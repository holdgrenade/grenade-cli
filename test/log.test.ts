import { describe, expect, it } from "vitest";
import { formatData, formatLine } from "../src/log.js";

describe("formatLine", () => {
  it("writes info without a level tag", () => {
    expect(formatLine({ level: "info", msg: "Grenade stopped", time: "12:00:00", color: false })).toBe("12:00:00  Grenade stopped");
  });

  it("tags warnings and errors and appends details", () => {
    expect(formatLine({ level: "warn", msg: "Bonjour error", data: { error: new Error("boom") }, time: "t", color: false })).toBe(
      "t  warning: Bonjour error  error=boom",
    );
    expect(formatLine({ level: "error", msg: "x", time: "t", color: false })).toBe("t  error: x");
  });

  it("colors only when asked", () => {
    expect(formatLine({ level: "error", msg: "x", time: "t", color: true })).toContain("\x1b[31m");
    expect(formatLine({ level: "error", msg: "x", time: "t", color: false })).not.toContain("\x1b");
  });
});

describe("formatData", () => {
  it("renders key=value, quotes spaced values, skips undefined", () => {
    expect(formatData({ cwd: "/Users/me/my repo", port: 7788, signal: undefined, ok: true })).toBe('cwd="/Users/me/my repo" port=7788 ok=true');
  });

  it("is empty with no data", () => {
    expect(formatData(undefined)).toBe("");
  });
});
