import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { pairCheck, spacedCode, typedCode } from "../src/daemon/pairCheck.js";

const v = JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "grenade-protocol", "fixtures", "e2e.vectors.json"), "utf8")).pairCheck;
const key = Buffer.from(v.daemonKey, "base64");

describe("pairCheck", () => {
  it("reproduces the shared vector", () => {
    expect(pairCheck(v.code, key)).toBe(v.check);
    expect(typedCode(v.code, key)).toBe(v.typed);
  });

  it("changes with the key and with the code", () => {
    const other = Buffer.from(key);
    other[0] = (other[0] ?? 0) ^ 1;
    expect(pairCheck(v.code, other)).not.toBe(v.check);
    expect(pairCheck("482914", key)).not.toBe(v.check);
  });

  it("is always four digits", () => {
    for (let i = 0; i < 200; i++) expect(pairCheck(String(i).padStart(6, "0"), key)).toMatch(/^\d{4}$/);
  });

  it("spaces the typed code for reading aloud", () => {
    expect(spacedCode("4829137343")).toBe("482 913 7343");
  });
});
