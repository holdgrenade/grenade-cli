import type { TalkEntry } from "@grenade/protocol";
import { describe, expect, it } from "vitest";
import { historyPage, talkDays } from "../src/talk/talkHistory.js";

const row = (id: string, day: string): TalkEntry => ({ id, at: `${day}T09:00:00.000Z`, kind: "it", text: id });
const rowsOf = (day: string, n: number) => Array.from({ length: n }, (_, i) => row(`${day}-${i + 1}`, day));

describe("talkDays", () => {
  it("reads the days from the day files' names, oldest first, and skips anything else", () => {
    expect(talkDays(["2026-10-11.jsonl", "work", "2026-10-06.jsonl", "2026-10-07.jsonl.tmp", "x.jsonl"])).toEqual(["2026-10-06", "2026-10-11"]);
  });
});

describe("historyPage", () => {
  const files: Record<string, TalkEntry[]> = {
    "2026-10-08": rowsOf("2026-10-08", 3),
    "2026-10-09": [],
    "2026-10-10": rowsOf("2026-10-10", 5),
    "2026-10-12": rowsOf("2026-10-12", 2),
  };
  const days = Object.keys(files);
  const read = (day: string) => files[day] ?? [];

  it("gives a day's rows before a row, and the same day as the cursor while it has more", () => {
    expect(historyPage(days, read, "2026-10-10", "2026-10-10-5", 3)).toEqual({
      date: "2026-10-10",
      entries: files["2026-10-10"]!.slice(1, 4),
      earlier: { date: "2026-10-10", before: "2026-10-10-2" },
    });
  });

  it("points at the latest earlier day with rows once the day is done, skipping empty and missing days", () => {
    expect(historyPage(days, read, "2026-10-10", "2026-10-10-2", 3)).toEqual({ date: "2026-10-10", entries: [files["2026-10-10"]![0]], earlier: { date: "2026-10-08" } });
  });

  it("walks back to the latest earlier day with rows when the asked day has none left", () => {
    expect(historyPage(days, read, "2026-10-12", "2026-10-12-1", 3)).toEqual({
      date: "2026-10-10",
      entries: files["2026-10-10"]!.slice(2),
      earlier: { date: "2026-10-10", before: "2026-10-10-3" },
    });
    expect(historyPage(days, read, "2026-10-11", undefined, 3)?.date).toBe("2026-10-10");
  });

  it("is empty with no cursor at the start of the history", () => {
    expect(historyPage(days, read, "2026-10-08", "2026-10-08-1", 3)).toEqual({ date: "2026-10-08", entries: [] });
    expect(historyPage(days, read, "2026-10-08", undefined, 3)).toEqual({ date: "2026-10-08", entries: files["2026-10-08"] });
  });

  it("is null for a row that is not in the day", () => {
    expect(historyPage(days, read, "2026-10-10", "2026-10-12-1", 3)).toBeNull();
  });
});
