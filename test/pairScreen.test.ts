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

  it("says where the QR code works", () => {
    expect(pairScreen(input).join("\n")).toContain("any network");
    expect(pairScreen({ ...input, relayOnline: false }).join("\n")).toContain("grenade relay on");
  });

  it("leaves the QR code out of a window it does not fit, and says how wide to make it", () => {
    const text = pairScreen({ ...input, columns: 40 }).join("\n");
    expect(text).not.toContain("█");
    expect(text).toContain(`${qrWidth(url) + 2} columns`);
    expect(text).toContain("482 913 0457");
  });

  it("draws it when the width is unknown (output piped to a file)", () => {
    expect(pairScreen({ ...input, columns: undefined }).join("\n")).toContain("█");
  });
});
