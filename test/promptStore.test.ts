import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PROMPT_HOOK_TIMEOUT_S, type PromptClosedFrame, type PromptDecision, type PromptFrame } from "@grenade/protocol";
import { PromptStore } from "../src/prompts/promptStore.js";
import { promptText } from "../src/prompts/promptText.js";

const fixtures = join(import.meta.dirname, "..", "..", "grenade-protocol", "fixtures");
const examples: { cases: { name: string; hook: unknown; prompt: object; answer: PromptDecision; reply: unknown }[] } = JSON.parse(
  readFileSync(join(fixtures, "prompt.examples.json"), "utf8"),
);

const bash = (command: string) => ({ hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command } });
const edit = (file_path: string) => ({ hook_event_name: "PermissionRequest", tool_name: "Edit", tool_input: { file_path } });

function store(start = Date.parse("2026-09-29T12:00:00.000Z")) {
  let at = start;
  let n = 0;
  const s = new PromptStore({ now: () => at, newId: () => `p-${++n}` });
  const opened: PromptFrame[] = [];
  const closed: PromptClosedFrame[] = [];
  const answered: string[] = [];
  s.on("opened", (f) => opened.push(f));
  s.on("closed", (f) => closed.push(f));
  s.on("answered", (id, allow) => answered.push(`${id}:${allow}`));
  /** Opens a prompt and collects what the held request is answered with. */
  const open = (sessionId: string, payload: unknown) => {
    const replies: (Record<string, unknown> | null)[] = [];
    const frame = s.open(sessionId, payload, (r) => replies.push(r));
    return { frame, replies };
  };
  return { s, open, opened, closed, answered, later: (ms: number) => (at += ms) };
}

describe("PromptStore", () => {
  for (const c of examples.cases) {
    it(`${c.name}: answers the held request with the documented reply`, () => {
      const { s, open, closed, answered } = store();
      const { frame, replies } = open("gr-a", c.hook);
      expect(frame).toEqual({ type: "prompt", sessionId: "gr-a", promptId: "p-1", since: "2026-09-29T12:00:00.000Z", ...c.prompt });
      expect(s.answer("gr-a", "p-1", c.answer)).toBe("answered");
      expect(replies).toEqual([c.reply]);
      expect(closed).toEqual([{ type: "prompt.closed", sessionId: "gr-a", promptId: "p-1", reason: "answered" }]);
      expect(answered).toEqual([`gr-a:${c.answer.allow}`]);
      expect(s.list()).toEqual([]);
    });
  }

  it("opens nothing for a payload that is not a prompt", () => {
    const { s, open, opened } = store();
    const { frame, replies } = open("gr-a", { hook_event_name: "Stop" });
    expect(frame).toBeNull();
    expect(replies).toEqual([]);
    expect(opened).toEqual([]);
    expect(s.list()).toEqual([]);
  });

  it("lists open prompts oldest first", () => {
    const { s, open, later } = store();
    open("gr-a", bash("one"));
    later(1000);
    open("gr-b", bash("two"));
    expect(s.list().map((p) => [p.promptId, p.sessionId, p.since])).toEqual([
      ["p-1", "gr-a", "2026-09-29T12:00:00.000Z"],
      ["p-2", "gr-b", "2026-09-29T12:00:01.000Z"],
    ]);
  });

  it("an answer is used once: the second one is too late", () => {
    const { s, open } = store();
    const { replies } = open("gr-a", bash("ls"));
    expect(s.answer("gr-a", "p-1", { allow: true })).toBe("answered");
    expect(s.answer("gr-a", "p-1", { allow: false })).toBe("elsewhere");
    expect(replies).toHaveLength(1);
  });

  it("does not take an answer for another session's prompt", () => {
    const { s, open } = store();
    const { replies } = open("gr-a", bash("ls"));
    expect(s.answer("gr-b", "p-1", { allow: true })).toBe("elsewhere");
    expect(replies).toEqual([]);
    expect(s.list()).toHaveLength(1);
  });

  it("an answer that does not fit leaves the prompt open", () => {
    const { s, open, closed } = store();
    const question = examples.cases.find((c) => c.name.startsWith("question"))!;
    const { replies } = open("gr-a", question.hook);
    expect(s.answer("gr-a", "p-1", { allow: true, answers: [["Mustard"]] })).toEqual({ error: "expected 2 answers, got 1" });
    expect(replies).toEqual([]);
    expect(closed).toEqual([]);
    expect(s.list()).toHaveLength(1);
  });

  it("a dropped request means the prompt was answered on the Mac", () => {
    const { s, open, closed, later } = store();
    const { replies } = open("gr-a", bash("ls"));
    later(3000);
    s.dropped("p-1");
    expect(closed).toEqual([{ type: "prompt.closed", sessionId: "gr-a", promptId: "p-1", reason: "elsewhere" }]);
    expect(replies).toEqual([null]);
    s.dropped("p-1"); // twice is fine
    expect(closed).toHaveLength(1);
  });

  it("a request dropped at the hook's timeout expired", () => {
    const { s, open, closed, later } = store();
    open("gr-a", bash("ls"));
    later(PROMPT_HOOK_TIMEOUT_S * 1000);
    s.dropped("p-1");
    expect(closed[0]?.reason).toBe("expired");
  });

  it("PostToolUse closes the oldest prompt of that tool, and hands the request back without a decision", () => {
    const { s, open, closed } = store();
    const first = open("gr-a", bash("one"));
    open("gr-a", bash("two"));
    open("gr-a", edit("/tmp/a"));
    open("gr-b", bash("other session"));
    s.closeByHook("gr-a", "PostToolUse", "Bash");
    expect(closed).toEqual([{ type: "prompt.closed", sessionId: "gr-a", promptId: "p-1", reason: "elsewhere" }]);
    expect(first.replies).toEqual([null]);
    s.closeByHook("gr-a", "PostToolUseFailure", "Edit");
    expect(s.list().map((p) => p.promptId)).toEqual(["p-2", "p-4"]);
  });

  it("Stop and UserPromptSubmit close every prompt of the session; PreToolUse and Notification close none", () => {
    const { s, open } = store();
    open("gr-a", bash("one"));
    open("gr-a", edit("/tmp/a"));
    open("gr-b", bash("other session"));
    s.closeByHook("gr-a", "PreToolUse", "Bash");
    s.closeByHook("gr-a", "Notification");
    expect(s.list()).toHaveLength(3);
    s.closeByHook("gr-a", "Stop");
    expect(s.list().map((p) => p.sessionId)).toEqual(["gr-b"]);
  });

  it("closes a session's prompts when it ends, and all of them when the daemon stops", () => {
    const { s, open, closed } = store();
    const a = open("gr-a", bash("one"));
    const b = open("gr-b", bash("two"));
    s.closeSession("gr-a");
    expect(a.replies).toEqual([null]);
    expect(b.replies).toEqual([]);
    s.closeAll();
    expect(b.replies).toEqual([null]);
    expect(closed.map((c) => c.reason)).toEqual(["elsewhere", "elsewhere"]);
  });
});

describe("promptText", () => {
  it("says what is asked in one line", () => {
    expect(promptText({ kind: "permission", tool: "Bash", detail: "npm test\nnpm run build" })).toBe("Bash: npm test");
    expect(promptText({ kind: "permission", tool: "mcp__x__ping", detail: "" })).toBe("Wants to use mcp__x__ping");
    expect(promptText({ kind: "question", questions: [{ question: "Which color?", options: [], multiSelect: false }] })).toBe("Which color?");
    expect(promptText({ kind: "plan" })).toBe("Has a plan for you to approve");
    expect(promptText({ kind: "permission", tool: "Bash", detail: "x".repeat(500) })).toHaveLength(200);
  });
});
