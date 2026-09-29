/** A Connection with a real PromptStore: what a phone is told about prompts, and what its answers do. */
import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import type { DaemonFrame } from "@grenade/protocol";
import { Connection } from "../src/daemon/wsHandler.js";
import { silentLogger } from "../src/log.js";
import { PromptStore } from "../src/prompts/promptStore.js";

const hello = JSON.stringify({ type: "hello", protocol: 1, token: "grt_t", client: { name: "Phone", platform: "test", version: "0.1.0" } });
const bash = { hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command: "ls" } };
const question = {
  hook_event_name: "PermissionRequest",
  tool_name: "AskUserQuestion",
  tool_input: { questions: [{ question: "Which?", options: [{ label: "A" }, { label: "B" }], multiSelect: false }] },
};

class FakeRegistry extends EventEmitter {
  list() { return []; }
  get() { return undefined; }
  unsubscribe() {}
}

function setup() {
  let n = 0;
  const prompts = new PromptStore({ newId: () => `p-${++n}`, now: () => Date.parse("2026-09-29T12:00:00.000Z") });
  const connect = () => {
    const out: DaemonFrame[] = [];
    const conn = new Connection({
      registry: new FakeRegistry() as never,
      attachments: { save: async () => ({ path: "", bytes: 0 }) },
      isValidToken: () => true,
      sealed: true,
      route: "lan",
      prompts,
      daemon: { id: "d_1", name: "Mac", version: "0.1.0" },
      log: silentLogger,
      out: (f) => out.push(f),
      close: () => {},
      setTimer: () => 0,
      clearTimer: () => {},
    });
    const prompted = () => out.filter((f) => f.type === "prompt" || f.type === "prompt.closed" || f.type === "error");
    return { conn, out, prompted };
  };
  const replies: unknown[] = [];
  const open = (sessionId: string, payload: unknown) => prompts.open(sessionId, payload, (r) => replies.push(r));
  return { prompts, connect, open, replies };
}

describe("prompts on a connection", () => {
  it("a phone that says hello gets the prompts that are open, after the sessions", async () => {
    const { connect, open } = setup();
    open("gr-a", bash);
    const { conn, out } = connect();
    await conn.handleMessage(hello);
    expect(out.map((f) => f.type)).toEqual(["welcome", "sessions", "prompt"]);
    expect(out[2]).toEqual({ type: "prompt", sessionId: "gr-a", promptId: "p-1", since: "2026-09-29T12:00:00.000Z", kind: "permission", tool: "Bash", detail: "ls" });
  });

  it("hears nothing about prompts before hello or after it closed", async () => {
    const { connect, open, prompts } = setup();
    const { conn, prompted } = connect();
    open("gr-a", bash);
    expect(prompted()).toEqual([]);
    await conn.handleMessage(hello);
    expect(prompted()).toHaveLength(1);
    conn.handleClose();
    open("gr-a", bash);
    prompts.closeAll();
    expect(prompted()).toHaveLength(1);
    expect(prompts.listenerCount("opened") + prompts.listenerCount("closed")).toBe(0);
  });

  it("an answer closes the prompt for every phone and answers the hook", async () => {
    const { connect, open, replies } = setup();
    const one = connect();
    const two = connect();
    await one.conn.handleMessage(hello);
    await two.conn.handleMessage(hello);
    open("gr-a", bash);
    await one.conn.handleMessage(JSON.stringify({ type: "prompt.answer", sessionId: "gr-a", promptId: "p-1", allow: true }));
    const closed = { type: "prompt.closed", sessionId: "gr-a", promptId: "p-1", reason: "answered" };
    expect(one.prompted().at(-1)).toEqual(closed);
    expect(two.prompted().at(-1)).toEqual(closed);
    expect(one.prompted()).toHaveLength(2); // the prompt and one close, not two
    expect(replies).toEqual([{ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } } }]);
  });

  it("an answer that comes too late is told so, and only the phone that sent it", async () => {
    const { connect, open, prompts } = setup();
    const one = connect();
    const two = connect();
    await one.conn.handleMessage(hello);
    await two.conn.handleMessage(hello);
    open("gr-a", bash);
    prompts.closeByHook("gr-a", "PostToolUse", "Bash");
    await one.conn.handleMessage(JSON.stringify({ type: "prompt.answer", sessionId: "gr-a", promptId: "p-1", allow: true }));
    expect(one.prompted().map((f) => (f as { reason?: string }).reason)).toEqual([undefined, "elsewhere", "elsewhere"]);
    expect(two.prompted()).toHaveLength(2);
  });

  it("an answer that does not fit is a bad_frame and leaves the prompt open", async () => {
    const { connect, open, prompts, replies } = setup();
    const { conn, prompted } = connect();
    await conn.handleMessage(hello);
    open("gr-a", question);
    await conn.handleMessage(JSON.stringify({ type: "prompt.answer", sessionId: "gr-a", promptId: "p-1", allow: true, answers: [["A", "B"]] }));
    expect(prompted().at(-1)).toEqual({ type: "error", code: "bad_frame", message: "question 1 takes one answer", ref: "prompt.answer" });
    expect(prompts.list()).toHaveLength(1);
    expect(replies).toEqual([]);
  });
});
