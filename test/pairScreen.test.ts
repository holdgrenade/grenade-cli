import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { pairScreen } from "../src/pairing/pairScreen.js";
import { qrRows, qrWidth } from "../src/pairing/qrText.js";

const { url } = JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "grenade-protocol", "fixtures", "pair.offer.json"), "utf8")) as { url: string };
const input = { offer: url, typed: "4829130457", relayOnline: true, columns: 120, color: false };

describe("qrRows", () => {
  it("draws a square of half blocks that fits an 80-column terminal", () => {
    const rows = qrRows(url, false);
    expect(new Set(rows.map((r) => r.length)).size).toBe(1);
    expect(qrWidth(url)).toBeLessThanOrEqual(78);
    // Two modules per row of text.
    expect(rows.length).toBe(Math.ceil(qrWidth(url) / 2));
    expect(rows.join("")).toMatch(/^[ █▀▄]+$/);
  });

  it("forces white on black when it may use color", () => {
    for (const row of qrRows(url, true)) expect(row).toMatch(/^\u001b\[97;40m[ █▀▄]+\u001b\[0m$/);
  });

  it("draws different codes for different offers", () => {
    expect(qrRows(url, false)).not.toEqual(qrRows(url.replace("Zq3v", "Zq3w"), false));
  });
});

describe("pairScreen", () => {
  it("shows the QR code, then the typed code with its check digits", () => {
    const text = pairScreen(input).join("\n");
    for (const row of qrRows(url, false)) expect(text).toContain(row);
    expect(text).toContain("482 913 0457");
    expect(text.indexOf("█")).toBeLessThan(text.indexOf("482 913 0457"));
  });

  it("names the two ways option 1 and option 2, each with where it works", () => {
    const lines = pairScreen(input);
    const at = (text: string) => lines.findIndex((l) => l.includes(text));
    expect(at("OPTION 1 · SCAN THE QR CODE")).toBeGreaterThan(-1);
    expect(at("OPTION 1")).toBeLessThan(at("█"));
    expect(at("█")).toBeLessThan(at("OPTION 2 · TYPE THE CODE"));
    expect(at("OPTION 2")).toBeLessThan(at("482 913 0457"));
    expect(lines[at("OPTION 2") + 1]).toContain("Same Wi‑Fi only");
  });

  it("ends with the typed code, alone on its line", () => {
    const lines = pairScreen(input).filter((l) => l !== "");
    expect(lines.at(-1)?.trim()).toBe("482 913 0457");
  });

  it("makes the headings and the code bold only when it may use color", () => {
    expect(pairScreen(input).join("\n")).not.toContain("\u001b[1m");
    const text = pairScreen({ ...input, color: true }).join("\n");
    expect(text).toContain("\u001b[1mOPTION 1 · SCAN THE QR CODE\u001b[0m");
    expect(text).toContain("\u001b[1m482 913 0457\u001b[0m");
  });

  it("says where the QR code works", () => {
    expect(pairScreen(input).join("\n")).toContain("any network");
    expect(pairScreen({ ...input, relayOnline: false }).join("\n")).toContain("grenade relay on");
  });

  it("leaves the QR code out of a window it does not fit, and says how wide to make it", () => {
    const text = pairScreen({ ...input, columns: 40 }).join("\n");
    expect(text).not.toContain("█");
    expect(text).toContain(`${qrWidth(url) + 2} columns`);
    expect(text).toContain("OPTION 1");
    expect(text).toContain("OPTION 2");
    expect(text).toContain("482 913 0457");
  });

  it("draws it when the width is unknown (output piped to a file)", () => {
    expect(pairScreen({ ...input, columns: undefined }).join("\n")).toContain("█");
  });
});
