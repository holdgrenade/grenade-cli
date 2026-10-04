import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { lastModelIn, lastReplyModelIn, modelLabel } from "../src/transcript/modelLabel.js";
import { readTranscriptModel } from "../src/transcript/readModel.js";

const reply = (model: string) => JSON.stringify({ type: "assistant", message: { model, content: [] } });

describe("modelLabel", () => {
  it.each([
    ["claude-opus-5-5", "Opus 5.5"],
    ["claude-fable-5-1", "Fable 5.1"],
    ["claude-sonnet-5", "Sonnet 5"],
    ["claude-haiku-4-5-20251001", "Haiku 4.5"],
    ["claude-3-5-sonnet-20241022", "Sonnet 3.5"],
    ["claude-opus-4-1-20250805", "Opus 4.1"],
    ["claude-sonnet-5[1m]", "Sonnet 5"],
    ["gpt-5-codex", "gpt-5-codex"],
    ["claude-weird-name-x", "claude-weird-name-x"],
  ])("%s → %s", (id, label) => expect(modelLabel(id)).toBe(label));
});

describe("lastModelIn", () => {
  it("finds the last assistant reply, skipping synthetic ones and partial lines", () => {
    const text = ['el":"claude-cut', reply("claude-opus-5-5"), reply("claude-fable-5-1"), reply("<synthetic>"), JSON.stringify({ type: "user", message: {} })].join("\n");
    expect(lastModelIn(text)).toBe("claude-fable-5-1");
  });
  it("is null without a reply", () => {
    expect(lastModelIn(JSON.stringify({ type: "user", message: { content: "hi" } }))).toBeNull();
  });
});

describe("readTranscriptModel", () => {
  it("reads the label from the end of a transcript file", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "gr-transcript-")), "t.jsonl");
    writeFileSync(path, [reply("claude-sonnet-5"), "x".repeat(300_000), reply("claude-opus-5-5"), ""].join("\n"));
    expect(await readTranscriptModel(path)).toEqual({ model: "Opus 5.5" });
  });
});

const replyWith = (extra: object) => JSON.stringify({ type: "assistant", message: { model: "claude-opus-5-5", content: [] }, ...extra });

describe("lastReplyModelIn", () => {
  it("reads the model, the effort level and the time of the last reply", () => {
    const text = [replyWith({ effort: "low", timestamp: "2026-10-03T10:00:00.000Z" }), replyWith({ effort: "xhigh", timestamp: "2026-10-03T11:00:00.000Z" }), JSON.stringify({ type: "user", message: { content: "hi" } })].join("\n");
    expect(lastReplyModelIn(text)).toEqual({ id: "claude-opus-5-5", effort: "xhigh", at: "2026-10-03T11:00:00.000Z" });
  });
  it("leaves out an effort that is not a level, and a missing time", () => {
    expect(lastReplyModelIn(replyWith({ effort: "Very High" }))).toEqual({ id: "claude-opus-5-5" });
    expect(lastReplyModelIn(replyWith({}))).toEqual({ id: "claude-opus-5-5" });
  });
  it("skips replies Claude Code wrote itself", () => {
    expect(lastReplyModelIn(JSON.stringify({ type: "assistant", message: { model: "<synthetic>" } }))).toBeNull();
  });
});
