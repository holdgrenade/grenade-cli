import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { activityEntriesIn } from "@grenade/protocol";
import { TranscriptReader } from "../src/activity/transcriptReader.js";

const said = (text: string, at = "2026-09-30T14:02:14.000Z") =>
  JSON.stringify({ type: "assistant", timestamp: at, message: { model: "claude-opus-5-5", content: [{ type: "text", text }] } });

/** What the reader's lines say, as the daemon reads them. */
const texts = (jsonl: string) => activityEntriesIn(jsonl).map((e) => e.text);

function transcript(): string {
  return join(mkdtempSync(join(tmpdir(), "gr-activity-")), "t.jsonl");
}

describe("TranscriptReader", () => {
  it("returns only what was written since the last read", async () => {
    const path = transcript();
    writeFileSync(path, said("one") + "\n");
    const reader = new TranscriptReader();
    expect(texts(await reader.read(path))).toEqual(["one"]);
    expect(await reader.read(path)).toBe("");
    appendFileSync(path, said("two") + "\n" + said("three") + "\n");
    expect(texts(await reader.read(path))).toEqual(["two", "three"]);
  });

  it("waits for a line still being written", async () => {
    const path = transcript();
    const line = said("héllo");
    writeFileSync(path, line.slice(0, 20));
    const reader = new TranscriptReader();
    expect(await reader.read(path)).toBe("");
    appendFileSync(path, line.slice(20) + "\n");
    expect(texts(await reader.read(path))).toEqual(["héllo"]);
  });

  it("starts over when the file shrank, and after forget", async () => {
    const path = transcript();
    writeFileSync(path, said("one") + "\n" + said("two") + "\n");
    const reader = new TranscriptReader();
    expect(texts(await reader.read(path))).toHaveLength(2);
    writeFileSync(path, said("new") + "\n");
    expect(texts(await reader.read(path))).toEqual(["new"]);
    reader.forget(path);
    expect(texts(await reader.read(path))).toEqual(["new"]);
  });

  it("keeps reads of one file in order", async () => {
    const path = transcript();
    writeFileSync(path, said("one") + "\n");
    const reader = new TranscriptReader();
    const [a, b] = await Promise.all([reader.read(path), reader.read(path)]);
    expect(texts(a)).toEqual(["one"]);
    expect(b).toBe("");
  });

  it("rejects for a missing file and reads again afterwards", async () => {
    const path = transcript();
    const reader = new TranscriptReader();
    await expect(reader.read(path)).rejects.toThrow();
    writeFileSync(path, said("late") + "\n");
    expect(texts(await reader.read(path))).toEqual(["late"]);
  });
});
