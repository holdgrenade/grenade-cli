/** The day's thread on disk: one file per local day, 0600 in a 0700 folder, ids, rollover, and the protocol's fixture. */
import { describe, expect, it } from "vitest";
import { appendFileSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaemonFrame, TALK_TEXT_MAX } from "@grenade/protocol";
import { TalkThread, entriesIn, lastRowNumber, talkDate } from "../src/talk/talkThread.js";

const fixtures = join(import.meta.dirname, "..", "..", "grenade-protocol", "fixtures");

describe("talkThread", () => {
  it("names a day by the computer's own calendar", () => {
    expect(talkDate(new Date(2026, 9, 5, 23, 59))).toBe("2026-10-05");
    expect(talkDate(new Date(2026, 0, 1, 0, 0))).toBe("2026-01-01");
  });

  it("appends rows to the day's file, keeps it private, and reads it back", () => {
    const dir = join(mkdtempSync(join(tmpdir(), "talk-")), "talk");
    let now = new Date(2026, 9, 5, 9, 12);
    const thread = new TalkThread(dir, () => now);
    expect(thread.date).toBe("2026-10-05");
    const you = thread.append({ id: "6f1c", kind: "you", text: "Bump the relay" });
    const sent = thread.append({ kind: "sent", text: "Bump the version.", session: "gr-a1b2c3", title: "Relay version bump" });
    expect(you.id).toBe("6f1c");
    expect(sent.id).toBe("t-0001");
    expect(thread.append({ kind: "it", text: "Sent." }).id).toBe("t-0002");
    const file = join(dir, "2026-10-05.jsonl");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    // A line cut short is skipped; the rest is there after a restart, and ids go on from the last.
    appendFileSync(file, '{"id":"t-00\n');
    const again = new TalkThread(dir, () => now);
    expect(again.entries().map((e) => e.id)).toEqual(["6f1c", "t-0001", "t-0002"]);
    expect(again.has("6f1c")).toBe(true);
    expect(again.append({ kind: "finished", text: "", session: "gr-a1b2c3", title: "Relay version bump" }).id).toBe("t-0003");
    // A new day is a new, empty thread.
    now = new Date(2026, 9, 6, 0, 1);
    expect(again.rollover()).toBe(true);
    expect(again.date).toBe("2026-10-06");
    expect(again.entries()).toEqual([]);
    expect(again.rollover()).toBe(false);
    expect(readFileSync(file, "utf8").split("\n").filter(Boolean)).toHaveLength(5);
  });

  it("cuts a text that is too long and gives at most the newest 200 rows", () => {
    const thread = new TalkThread(join(mkdtempSync(join(tmpdir(), "talk-")), "talk"), () => new Date(2026, 9, 5));
    expect(thread.append({ kind: "it", text: "x".repeat(TALK_TEXT_MAX + 10) }).text).toHaveLength(TALK_TEXT_MAX);
    for (let i = 0; i < 210; i++) thread.append({ kind: "it", text: `${i}` });
    expect(thread.entries()).toHaveLength(200);
    expect(thread.entries().at(-1)?.text).toBe("209");
    expect(thread.all()).toHaveLength(211);
  });

  it("reads the rows of the protocol's thread fixture", () => {
    const frame = DaemonFrame.parse(JSON.parse(readFileSync(join(fixtures, "daemon.talk.thread.json"), "utf8")));
    if (frame.type !== "talk.thread") throw new Error("not a thread");
    const jsonl = frame.entries.map((e) => JSON.stringify(e)).join("\n");
    expect(entriesIn(jsonl)).toEqual(frame.entries);
    expect(lastRowNumber(frame.entries)).toBe(10);
  });
});
