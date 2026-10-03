import { computerWord } from "../src/platform/computer.js";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Conversation } from "@grenade/protocol";
import { codexConversationIdOf, codexConversationInfoIn, codexTitlesIn } from "../src/conversations/codexConversationInfo.js";
import { CodexConversations } from "../src/conversations/codexConversations.js";
import { AllConversations, type ConversationSource } from "../src/conversations/conversationSource.js";
import { ConversationMarks } from "../src/conversations/conversationMarks.js";
import { conversationIdOf, heldConversations } from "../src/conversations/heldConversations.js";
import { silentLogger } from "../src/log.js";

const ID = "0190c0de-1111-7000-8000-00000000000a";
const OTHER = "0190c0de-2222-7000-8000-00000000000b";
const meta = (id: string, cwd: string) => JSON.stringify({ timestamp: "2026-10-02T14:00:00.000Z", type: "session_meta", payload: { id, cwd, base_instructions: { text: "You are Codex." } } });
const message = (role: string, type: string, text: string, at: string) => JSON.stringify({ timestamp: at, type: "response_item", payload: { type: "message", role, content: [{ type, text }] } });
const user = (text: string, at = "2026-10-02T14:00:01.000Z") => message("user", "input_text", text, at);
const said = (text: string, at = "2026-10-02T14:00:05.000Z") => message("assistant", "output_text", text, at);

describe("codexConversationInfoIn", () => {
  it("takes the folder from session_meta, Codex's thread name, and the last prompt; leaves out the context Codex writes", () => {
    const jsonl = [meta(ID, "/work/app"), user("<environment_context>…</environment_context>"), user("Paginate rooms"), said("Done."), user("And the tests")].join("\n");
    expect(codexConversationInfoIn(jsonl, jsonl, "Rooms pagination")).toEqual({ cwd: "/work/app", title: "Rooms pagination", lastPrompt: "And the tests" });
    expect(codexConversationInfoIn(jsonl, jsonl, undefined)?.title).toBe("Paginate rooms");
  });
  it("reads the folder of a first line the slice cut off", () => {
    const line = meta(ID, "/work/app");
    const cut = line.slice(0, line.indexOf("base_instructions") + 20);
    expect(codexConversationInfoIn(cut + "\n" + user("Hi"), user("Hi"), undefined)?.cwd).toBe("/work/app");
  });
  it("is null without a typed prompt or a session_meta", () => {
    expect(codexConversationInfoIn(meta(ID, "/w") + "\n" + said("Hi"), said("Hi"), "t")).toBeNull();
    expect(codexConversationInfoIn(user("Hi"), user("Hi"), "t")).toBeNull();
  });
});

describe("Codex ids and titles", () => {
  it("reads the id from a rollout's name, and only from a rollout", () => {
    expect(codexConversationIdOf(`/x/rollout-2026-10-02T21-04-29-${ID}.jsonl`)).toBe(ID);
    expect(codexConversationIdOf(`/x/${ID}.jsonl`)).toBeNull();
    expect(conversationIdOf(`/x/rollout-2026-10-02T21-04-29-${ID}.jsonl`)).toBe(ID);
    expect(conversationIdOf(`/x/${ID}.jsonl`)).toBe(ID);
  });
  it("holds a live Codex session's rollout", () => {
    expect(heldConversations([{ id: "gr-rooms", path: `/x/rollout-2026-10-02T21-04-29-${ID}.jsonl` }], () => true)).toEqual(new Map([[ID, "gr-rooms"]]));
  });
  it("keeps each thread's newest name", () => {
    const index = [JSON.stringify({ id: ID, thread_name: "First", updated_at: "x" }), "not json", JSON.stringify({ id: ID, thread_name: "Second" })].join("\n");
    expect(codexTitlesIn(index)).toEqual(new Map([[ID, "Second"]]));
  });
});

describe("CodexConversations", () => {
  function setup() {
    const codexDir = mkdtempSync(join(tmpdir(), "gr-codex-"));
    const day = join(codexDir, "sessions", "2026", "10", "02");
    mkdirSync(day, { recursive: true });
    const write = (id: string, lines: string[], mtime: number) => {
      const path = join(day, `rollout-2026-10-02T21-04-29-${id}.jsonl`);
      writeFileSync(path, lines.join("\n") + "\n");
      utimesSync(path, mtime, mtime);
    };
    write(ID, [meta(ID, "/work/app"), user("Paginate rooms"), said("Done.")], 1_790_900_000);
    write(OTHER, [meta(OTHER, "/work/app"), user("Hello")], 1_790_000_000);
    writeFileSync(join(day, "notes.jsonl"), user("not a rollout") + "\n");
    writeFileSync(join(codexDir, "session_index.jsonl"), JSON.stringify({ id: ID, thread_name: "Rooms pagination" }) + "\n");
    const marks = new ConversationMarks(silentLogger);
    const codex = new CodexConversations({ codexDir, marks, held: () => new Map([[OTHER, "gr-hello"]]), isDirectory: (p) => p === "/work/app" });
    return { codex, marks };
  }

  it("lists rollouts newest first, as Codex conversations", async () => {
    const { codex, marks } = setup();
    marks.noteCopy(ID, OTHER);
    expect(await codex.list()).toEqual([
      { id: ID, agent: "codex", cwd: "/work/app", title: "Rooms pagination", lastPrompt: "Paginate rooms", updatedAt: new Date(1_790_900_000_000).toISOString(), copyOf: OTHER },
      { id: OTHER, agent: "codex", cwd: "/work/app", title: "Hello", lastPrompt: "Hello", updatedAt: new Date(1_790_000_000_000).toISOString(), sessionId: "gr-hello" },
    ]);
  });

  it("finds, previews and names the rollout for the Trash; refuses one a session holds", async () => {
    const { codex } = setup();
    expect((await codex.find(ID))?.path.endsWith(`rollout-2026-10-02T21-04-29-${ID}.jsonl`)).toBe(true);
    expect((await codex.preview(ID))?.map((e) => e.kind)).toEqual(["asked", "said"]);
    const target = await codex.trashPaths(ID);
    expect(target && "paths" in target && target.paths.length).toBe(1);
    expect(await codex.trashPaths(OTHER)).toEqual({ refused: "it is open in a Grenade session; end that session first" });
    expect(await codex.find("nope")).toBeNull();
    expect(await codex.trashPaths("nope")).toBeNull();
  });
});

describe("AllConversations", () => {
  const row = (id: string, agent: string, updatedAt: string): Conversation => ({ id, agent, cwd: "/w", title: id, updatedAt });
  const source = (agent: string, rows: Conversation[]): ConversationSource => ({
    agent,
    list: async () => rows,
    find: async (id) => (rows.some((r) => r.id === id) ? { path: `/${agent}/${id}`, cwd: "/w" } : null),
    preview: async (id) => (rows.some((r) => r.id === id) ? [] : null),
    trashPaths: async (id) => (rows.some((r) => r.id === id) ? { paths: [`/${agent}/${id}`] } : null),
  });
  const all = new AllConversations([
    source("claude", [row("c1", "claude", "2026-10-02T12:00:00.000Z")]),
    source("codex", [row("x1", "codex", "2026-10-02T13:00:00.000Z")]),
  ]);

  it("merges every agent's newest first, or the legacy agent's only", async () => {
    expect((await all.list(true)).map((c) => c.id)).toEqual(["x1", "c1"]);
    expect((await all.list(false)).map((c) => c.id)).toEqual(["c1"]);
  });
  it("sends each id to the agent that has it", async () => {
    expect(await all.find("x1")).toEqual({ agent: "codex", path: "/codex/x1", cwd: "/w" });
    expect(await all.trashPaths("c1")).toEqual({ paths: ["/claude/c1"] });
    expect(await all.trashPaths("nope")).toEqual({ refused: `no conversation nope on this ${computerWord()}` });
    expect(await all.find("nope")).toBeNull();
  });
});

describe("Codex forks", () => {
  const FORK = "0190c0de-3333-7000-8000-00000000000c";
  const at = (o: number, line: string) => line.replace(/^\{"timestamp":("[^"]*"),/, `{"timestamp":$1,"ordinal":${o},`);
  const forkMeta = (id: string, from: string, before: number) =>
    JSON.stringify({ timestamp: "2026-10-02T15:00:00.000Z", ordinal: 0, type: "session_meta", payload: { id, forked_from_id: from, forked_from_ordinal_exclusive: before, cwd: "/work/app", history_mode: "paginated" } });

  it("reads where a fork came from, and the lines it took", async () => {
    const { codexForkOf, codexLinesBefore } = await import("../src/conversations/codexConversationInfo.js");
    expect(codexForkOf(forkMeta(FORK, ID, 3))).toEqual({ from: ID, before: 3 });
    expect(codexForkOf(meta(ID, "/w"))).toBeNull();
    const lines = [at(0, meta(ID, "/w")), at(1, user("one")), at(2, said("two")), at(3, user("after the fork"))].join("\n");
    expect(codexLinesBefore(lines, 3).split("\n")).toHaveLength(3);
  });

  it("previews a fork with the original's history before the fork, then its own", async () => {
    const codexDir = mkdtempSync(join(tmpdir(), "gr-codex-"));
    const day = join(codexDir, "sessions", "2026", "10", "02");
    mkdirSync(day, { recursive: true });
    writeFileSync(join(day, `rollout-2026-10-02T21-04-29-${ID}.jsonl`), [at(0, meta(ID, "/work/app")), at(1, user("Paginate rooms")), at(2, said("Done.")), at(3, user("Later, in the original"))].join("\n") + "\n");
    writeFileSync(join(day, `rollout-2026-10-02T22-05-07-${FORK}.jsonl`), [forkMeta(FORK, ID, 3), at(1, user("And the tests", "2026-10-02T15:01:00.000Z"))].join("\n") + "\n");
    const codex = new CodexConversations({ codexDir, marks: new ConversationMarks(silentLogger), held: () => new Map(), isDirectory: () => true });
    expect((await codex.preview(FORK))?.map((e) => e.text)).toEqual(["Paginate rooms", "Done.", "And the tests"]);
    expect((await codex.list()).find((c) => c.id === FORK)).toMatchObject({ cwd: "/work/app", lastPrompt: "And the tests" });
  });
});
