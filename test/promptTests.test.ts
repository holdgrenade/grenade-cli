import { describe, expect, it } from "vitest";
import { promptFromClaudeHook, type PromptClosedFrame } from "@grenade/protocol";
import { answerLines, messageToAgent } from "../src/cli/promptAnswer.js";
import { resultLines, waitForAnswer } from "../src/cli/promptCommand.js";
import { PromptStore } from "../src/prompts/promptStore.js";
import { PROMPT_TEST_KINDS, PromptTests, testPayload } from "../src/prompts/promptTests.js";

function setup() {
  let n = 0;
  const store = new PromptStore({ newId: () => `p-${++n}`, now: () => Date.parse("2026-09-29T12:00:00.000Z") });
  const timers: { fn: () => void; ms: number; cleared: boolean }[] = [];
  const tests = new PromptTests(store, {
    setTimer: (fn, ms) => {
      const t = { fn, ms, cleared: false };
      timers.push(t);
      return t;
    },
    clearTimer: (t) => ((t as { cleared: boolean }).cleared = true),
  });
  const closed: PromptClosedFrame[] = [];
  store.on("closed", (f) => closed.push(f));
  return { store, tests, timers, closed };
}

describe("test cards", () => {
  for (const kind of PROMPT_TEST_KINDS) {
    it(`${kind}: the payload makes a card of that kind and says it is a test`, () => {
      const prompt = promptFromClaudeHook(testPayload(kind));
      expect(prompt?.kind).toBe(kind);
      expect(JSON.stringify(prompt).toLowerCase()).toContain("test");
    });
  }

  it("the phone's answer is the result, with the reply Claude Code would have received", async () => {
    const { store, tests, timers } = setup();
    const frame = tests.start("gr-a", "permission", 120_000);
    expect(store.list()).toEqual([frame]);
    expect(store.answer("gr-a", frame.promptId, { allow: true })).toBe("answered");
    expect(await tests.result(frame.promptId)).toEqual({
      promptId: "p-1",
      sessionId: "gr-a",
      kind: "permission",
      outcome: "answered",
      reply: { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } } },
    });
    expect(timers[0]).toMatchObject({ ms: 120_000, cleared: true });
  });

  it("is unanswered when the wait runs out, and the card is closed as expired", async () => {
    const { tests, timers, closed } = setup();
    const frame = tests.start("gr-a", "plan", 5000);
    timers[0]?.fn();
    expect(await tests.result(frame.promptId)).toEqual({ promptId: "p-1", sessionId: "gr-a", kind: "plan", outcome: "unanswered" });
    expect(closed).toEqual([{ type: "prompt.closed", sessionId: "gr-a", promptId: "p-1", reason: "expired" }]);
  });

  it("stays open while the session's agent works, stops and is prompted: none of that is about the card", () => {
    const { store, tests } = setup();
    tests.start("gr-a", "permission", 5000);
    store.open("gr-a", testPayload("permission"), () => {});
    store.closeByHook("gr-a", "PostToolUse", "Bash");
    expect(store.list().map((p) => p.promptId)).toEqual(["p-1"]);
    store.closeByHook("gr-a", "Stop");
    store.closeByHook("gr-a", "UserPromptSubmit");
    expect(store.list().map((p) => p.promptId)).toEqual(["p-1"]);
  });

  it("is unanswered when its session ends", async () => {
    const { store, tests } = setup();
    const frame = tests.start("gr-a", "question", 5000);
    store.closeSession("gr-a");
    expect((await tests.result(frame.promptId))?.outcome).toBe("unanswered");
  });

  it("knows nothing about a card that is not a test's, and forgets a result after a while", () => {
    const { store, tests, timers } = setup();
    store.open("gr-a", testPayload("permission"), () => {});
    expect(tests.result("p-1")).toBeUndefined();
    const frame = tests.start("gr-a", "permission", 5000);
    expect(tests.result(frame.promptId)).toBeDefined();
    timers[1]?.fn();
    expect(tests.result(frame.promptId)).toBeUndefined();
  });
});

describe("what the CLI prints", () => {
  const reply = (decision: Record<string, unknown>) => ({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision } });

  it("names the button that was tapped", () => {
    expect(answerLines("permission", reply({ behavior: "allow" }))).toEqual(["Allow once"]);
    expect(answerLines("permission", reply({ behavior: "deny", message: "x" }))).toEqual(["Deny"]);
    expect(answerLines("plan", reply({ behavior: "allow", updatedInput: {} }))).toEqual(["Approve"]);
    expect(answerLines("plan", reply({ behavior: "deny", message: "x" }))).toEqual(["Send back"]);
    expect(answerLines("question", reply({ behavior: "deny", message: "x" }))).toEqual(["Dismiss"]);
  });

  it("lists the answer to every question", () => {
    const answered = reply({ behavior: "allow", updatedInput: { questions: [], answers: { "Reached you?": "Yes", "Looks?": "The text, The buttons" } } });
    expect(answerLines("question", answered)).toEqual(["Reached you?  →  Yes", "Looks?  →  The text, The buttons"]);
  });

  it("shows the note the agent would have been told", () => {
    const denied = reply({ behavior: "deny", message: "The user answered from their phone: not now" });
    expect(messageToAgent(denied)).toBe("The user answered from their phone: not now");
    expect(messageToAgent(reply({ behavior: "allow" }))).toBeUndefined();
    expect(resultLines({ promptId: "p", sessionId: "s", kind: "permission", outcome: "answered", reply: denied })).toEqual([
      "The phone answered:",
      "  Deny",
      "The agent would have been told:",
      "  The user answered from their phone: not now",
      "Claude Code would have received:",
      `  ${JSON.stringify(denied)}`,
    ]);
  });

  it("says so when nobody answered", () => {
    expect(resultLines({ promptId: "p", sessionId: "s", kind: "plan", outcome: "unanswered" })).toEqual(["No answer. The card is gone from the phone."]);
  });
});

describe("waiting for the phone", () => {
  const answered = { promptId: "p-1", sessionId: "gr-a", kind: "permission" as const, outcome: "unanswered" as const };

  it("asks again when a request ends without an answer and the daemon is still there", async () => {
    const calls: string[] = [];
    let tries = 0;
    const control = async <T>(_method: string, path: string): Promise<T> => {
      calls.push(path);
      if (path === "/status") return {} as T;
      if (++tries < 3) throw new Error("the request timed out");
      return answered as T;
    };
    expect(await waitForAnswer(control, "p-1", 1800, () => 0)).toEqual(answered);
    expect(calls).toEqual(["/prompts/test/p-1", "/status", "/prompts/test/p-1", "/status", "/prompts/test/p-1"]);
  });

  it("stops with the reason when the daemon is gone", async () => {
    const control = async <T>(): Promise<T> => {
      throw new Error("grenaded is not running");
    };
    await expect(waitForAnswer(control, "p-1", 1800, () => 0)).rejects.toThrow("grenaded is not running");
  });

  it("gives up once the wait is well over", async () => {
    let at = 0;
    const control = async <T>(_method: string, path: string): Promise<T> => {
      if (path === "/status") return {} as T;
      at += 400_000;
      throw new Error("the request timed out");
    };
    await expect(waitForAnswer(control, "p-1", 600, () => at)).rejects.toThrow("the request timed out");
  });
});
