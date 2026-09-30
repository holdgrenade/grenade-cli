import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TranscriptReader } from "../src/activity/transcriptReader.js";

const said = (text: string, at = "2026-09-30T14:02:14.000Z") =>
  JSON.stringify({ type: "assistant", timestamp: at, message: { model: "claude-opus-5-5", content: [{ type: "text", text }] } });

function transcript(): string {
  return join(mkdtempSync(join(tmpdir(), "gr-activity-")), "t.jsonl");
}

describe("TranscriptReader", () => {
  it("returns only what was written since the last read", async () => {
    const path = transcript();
    writeFileSync(path, said("one") + "\n");
    const reader = new TranscriptReader();
    expect((await reader.read(path)).map((e) => e.text)).toEqual(["one"]);
    expect(await reader.read(path)).toEqual([]);
    appendFileSync(path, said("two") + "\n" + said("three") + "\n");
    expect((await reader.read(path)).map((e) => e.text)).toEqual(["two", "three"]);
  });

  it("waits for a line still being written", async () => {
    const path = transcript();
    const line = said("héllo");
    writeFileSync(path, line.slice(0, 20));
    const reader = new TranscriptReader();
    expect(await reader.read(path)).toEqual([]);
    appendFileSync(path, line.slice(20) + "\n");
    expect((await reader.read(path)).map((e) => e.text)).toEqual(["héllo"]);
  });

  it("starts over when the file shrank, and after forget", async () => {
    const path = transcript();
    writeFileSync(path, said("one") + "\n" + said("two") + "\n");
    const reader = new TranscriptReader();
    expect(await reader.read(path)).toHaveLength(2);
    writeFileSync(path, said("new") + "\n");
    expect((await reader.read(path)).map((e) => e.text)).toEqual(["new"]);
    reader.forget(path);
    expect((await reader.read(path)).map((e) => e.text)).toEqual(["new"]);
  });

  it("keeps reads of one file in order", async () => {
    const path = transcript();
    writeFileSync(path, said("one") + "\n");
    const reader = new TranscriptReader();
    const [a, b] = await Promise.all([reader.read(path), reader.read(path)]);
    expect(a.map((e) => e.text)).toEqual(["one"]);
    expect(b).toEqual([]);
  });

  it("rejects for a missing file and reads again afterwards", async () => {
    const path = transcript();
    const reader = new TranscriptReader();
    await expect(reader.read(path)).rejects.toThrow();
    writeFileSync(path, said("late") + "\n");
    expect((await reader.read(path)).map((e) => e.text)).toEqual(["late"]);
  });
});
