import { mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ActivityStore } from "../src/activity/activityStore.js";
import { clip, conversationInfoIn } from "../src/conversations/conversationInfo.js";
import { ConversationIndex } from "../src/conversations/conversationIndex.js";
import { ConversationMarks } from "../src/conversations/conversationMarks.js";
import { heldConversations } from "../src/conversations/heldConversations.js";
import { parseClaudeProcess, runningConversationIds } from "../src/conversations/runningClaude.js";
import { silentLogger } from "../src/log.js";

const user = (text: string, at: string, cwd = "/work/app") => JSON.stringify({ type: "user", cwd, timestamp: at, message: { role: "user", content: text } });
const said = (text: string, at: string) => JSON.stringify({ type: "assistant", cwd: "/work/app/sub", timestamp: at, message: { model: "claude-opus-5-5", content: [{ type: "text", text }] } });
const title = (text: string) => JSON.stringify({ type: "ai-title", aiTitle: text, sessionId: "x" });

describe("conversationInfoIn", () => {
  it("takes the first folder, the newest title and the last prompt", () => {
    const jsonl = [user("Make the buttons glass", "2026-10-02T14:00:00.000Z"), title("Glass"), said("On it.", "2026-10-02T14:00:05.000Z"), title("Glass buttons and badges"), user("And the badges", "2026-10-02T14:10:00.000Z")].join("\n");
    expect(conversationInfoIn(jsonl, jsonl)).toEqual({ cwd: "/work/app", title: "Glass buttons and badges", lastPrompt: "And the badges" });
  });
  it("falls back to the first prompt for a title, and skips a tail that starts mid-line", () => {
    const head = user("Fix the relay\nplease", "2026-10-02T14:00:00.000Z");
    const tail = '":"cut"}\n' + user("Ship it", "2026-10-02T15:00:00.000Z");
    expect(conversationInfoIn(head, tail)).toEqual({ cwd: "/work/app", title: "Fix the relay please", lastPrompt: "Ship it" });
  });
  it("is null without a typed prompt", () => {
    const jsonl = [said("Hello", "2026-10-02T14:00:05.000Z"), JSON.stringify({ type: "user", cwd: "/w", timestamp: "2026-10-02T14:00:00.000Z", message: { content: "<command-name>/clear</command-name>" } })].join("\n");
    expect(conversationInfoIn(jsonl, jsonl)).toBeNull();
  });
  it("clips to one line of 200 characters", () => {
    expect(clip("a".repeat(250))).toHaveLength(200);
    expect(clip("a".repeat(250)).endsWith("…")).toBe(true);
  });
});

describe("running Claude processes", () => {
  it("parses a sessions file and ignores anything else", () => {
    expect(parseClaudeProcess('{"pid":34419,"sessionId":"5b3e","cwd":"/w","status":"busy"}')).toEqual({ pid: 34419, sessionId: "5b3e" });
    expect(parseClaudeProcess('{"pid":"1","sessionId":"x"}')).toBeNull();
    expect(parseClaudeProcess("nope")).toBeNull();
  });
  it("keeps the conversations of live processes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gr-sessions-"));
    writeFileSync(join(dir, "11.json"), '{"pid":11,"sessionId":"alive"}');
    writeFileSync(join(dir, "12.json"), '{"pid":12,"sessionId":"dead"}');
    writeFileSync(join(dir, "11.abc.key"), "secret");
    expect([...(await runningConversationIds(dir, (pid) => pid === 11))]).toEqual(["alive"]);
    expect([...(await runningConversationIds(join(dir, "missing")))]).toEqual([]);
  });
});

describe("heldConversations", () => {
  it("maps a live session's transcript to the session", () => {
    const held = heldConversations([{ id: "gr-a", path: "/c/projects/x/abc.jsonl" }, { id: "gr-gone", path: "/c/projects/x/old.jsonl" }], (id) => id === "gr-a");
    expect([...held]).toEqual([["abc", "gr-a"]]);
  });
});

describe("ConversationIndex", () => {
  function setup() {
    const claudeDir = mkdtempSync(join(tmpdir(), "gr-claude-"));
    const project = join(claudeDir, "projects", "-work-app");
    mkdirSync(join(project, "abc", "subagents"), { recursive: true });
    const write = (id: string, lines: string[], mtime: number) => {
      const path = join(project, `${id}.jsonl`);
      writeFileSync(path, lines.join("\n") + "\n");
      utimesSync(path, mtime, mtime);
    };
    write("old", [user("First thing", "2026-09-28T09:00:00.000Z"), said("Done.", "2026-09-28T09:01:00.000Z")], 1_790_000_000);
    write("new", [user("Glass buttons", "2026-10-02T14:00:00.000Z"), title("Glass buttons and badges"), said("Done.", "2026-10-02T14:05:00.000Z")], 1_790_900_000);
    write("empty", [said("Nothing typed", "2026-10-02T14:00:00.000Z")], 1_790_950_000);
    write("elsewhere", [user("Somewhere gone", "2026-10-02T14:00:00.000Z", "/does/not/exist")], 1_790_960_000);
    writeFileSync(join(project, "abc", "subagents", "agent-1.jsonl"), user("sub", "2026-10-02T14:00:00.000Z") + "\n");
    const marks = new ConversationMarks(silentLogger);
    const index = new ConversationIndex({
      claudeDir,
      marks,
      held: () => new Map([["new", "gr-glass"]]),
      running: async () => new Set(["old", "new"]),
      isDirectory: (p) => p === "/work/app",
    });
    return { index, marks };
  }

  it("lists conversations newest first with Grenade's marks", async () => {
    const { index, marks } = setup();
    marks.noteCopy("new", "older-original");
    expect(await index.list()).toEqual([
      { id: "new", agent: "claude", cwd: "/work/app", title: "Glass buttons and badges", lastPrompt: "Glass buttons", updatedAt: new Date(1_790_900_000_000).toISOString(), sessionId: "gr-glass", copyOf: "older-original" },
      { id: "old", agent: "claude", cwd: "/work/app", title: "First thing", lastPrompt: "First thing", updatedAt: new Date(1_790_000_000_000).toISOString(), running: true },
    ]);
  });

  it("names the transcript and its folder for the Trash, and refuses one that is open", async () => {
    const { index } = setup();
    expect(await index.trashPaths("old")).toEqual({ refused: "it is open in another terminal; quit Claude Code there first" });
    expect(await index.trashPaths("new")).toEqual({ refused: "it is open in a Grenade session; end that session first" });
    expect(await index.trashPaths("nope")).toBeNull();
  });

  it("refuses one another Claude Code process has open, and takes the folder beside a transcript", async () => {
    const claudeDir = mkdtempSync(join(tmpdir(), "gr-claude-"));
    const project = join(claudeDir, "projects", "-work-app");
    mkdirSync(join(project, "abc", "subagents"), { recursive: true });
    writeFileSync(join(project, "abc.jsonl"), user("Hi", "2026-10-02T14:00:00.000Z") + "\n");
    writeFileSync(join(project, "run.jsonl"), user("Hi", "2026-10-02T14:00:00.000Z") + "\n");
    const index = new ConversationIndex({ claudeDir, marks: new ConversationMarks(silentLogger), held: () => new Map(), running: async () => new Set(["run"]) });
    const target = await index.trashPaths("abc");
    expect(target && "paths" in target && target.paths.map((p) => p.split("/-work-app/")[1])).toEqual(["abc.jsonl", "abc"]);
    expect(await index.trashPaths("run")).toEqual({ refused: "it is open in another terminal; quit Claude Code there first" });
  });

  it("finds a conversation's transcript and folder, and previews it", async () => {
    const { index } = setup();
    expect(await index.find("new")).toMatchObject({ cwd: "/work/app" });
    expect((await index.find("new"))?.path.endsWith("/projects/-work-app/new.jsonl")).toBe(true);
    expect(await index.find("nope")).toBeNull();
    expect((await index.preview("old"))?.map((e) => e.kind)).toEqual(["asked", "said"]);
    expect(await index.preview("nope")).toBeNull();
  });
});

describe("ConversationMarks", () => {
  it("saves and reads copies, and reads a 1.0.14 file with archived ids", () => {
    const path = join(mkdtempSync(join(tmpdir(), "gr-marks-")), "conversations.json");
    writeFileSync(path, JSON.stringify({ archived: ["x"], copies: { old: "x" } }));
    const a = new ConversationMarks(silentLogger, path);
    expect(a.copyOf("old")).toBe("x");
    a.noteCopy("copy", "x");
    const b = new ConversationMarks(silentLogger, path);
    expect(b.copyOf("copy")).toBe("x");
    expect(readFileSync(path, "utf8")).not.toContain("archived");
  });
});

describe("ActivityStore.replace", () => {
  it("takes the copy's whole history in one full frame and keeps a hook's prompt the copy lacks", () => {
    const store = new ActivityStore();
    const frames: unknown[] = [];
    store.on("activity", (f) => frames.push(f));
    const history = [{ kind: "asked" as const, text: "Make it glass", at: "2026-10-02T14:00:00.000Z" }, { kind: "said" as const, text: "Done.", at: "2026-10-02T14:05:00.000Z" }];
    store.replace("gr-a", history);
    store.noteAsked("gr-a", "Now the Mac", "2026-10-02T16:13:00.000Z");
    // The copy's first read: the history again, not yet the new prompt.
    store.replace("gr-a", history);
    expect(store.entriesOf("gr-a").map((e) => e.text)).toEqual(["Make it glass", "Done.", "Now the Mac"]);
    // The prompt lands in the copy: one entry, not two.
    store.append("gr-a", [{ kind: "asked", text: "Now the Mac", at: "2026-10-02T16:13:01.000Z" }]);
    expect(store.entriesOf("gr-a").map((e) => e.text)).toEqual(["Make it glass", "Done.", "Now the Mac"]);
    expect(frames[0]).toMatchObject({ full: true, entries: history });
  });
});
