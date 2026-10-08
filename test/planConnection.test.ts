/** A Connection with a real PlanTracker and PromptStore: following, editing and building a plan (PROTOCOL.md "Plans"). */
import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import type { DaemonFrame, Session } from "@grenade/protocol";
import { Connection } from "../src/daemon/wsHandler.js";
import { silentLogger } from "../src/log.js";
import { PromptStore } from "../src/prompts/promptStore.js";
import { PlanTracker, type PlanFiles } from "../src/plans/planTracker.js";

const hello = JSON.stringify({ type: "hello", protocol: 1, token: "grt_t", client: { name: "Mac", platform: "macos", version: "1.0.140" } });
const home = "/Users/adam";
const planPath = `${home}/.claude/plans/velvety-knitting-shell.md`;
const session = (id: string, agent: string): Session => ({ id, name: id, agent, cwd: "/w", status: "idle", statusSince: "2026-10-08T16:00:00.000Z", lastLine: "", createdAt: "2026-10-08T16:00:00.000Z" });

class FakeRegistry extends EventEmitter {
  readonly sessions = [session("gr-a", "claude"), session("gr-s", "shell")];
  list() { return this.sessions; }
  get(id: string) { return this.sessions.find((s) => s.id === id); }
  unsubscribe() {}
}

const flush = () => new Promise((r) => setTimeout(r, 0));

function setup() {
  const files = new Map<string, string>([[planPath, "# Plan\n"]]);
  const disk: PlanFiles = {
    async read(path) {
      const text = files.get(path);
      return text === undefined ? null : { text, modified: new Date("2026-10-08T16:20:00.000Z"), bytes: text.length };
    },
    async write(path, text) {
      files.set(path, text);
    },
  };
  const plans = new PlanTracker(disk, `${home}/.claude`, home, () => () => {});
  const prompts = new PromptStore({ newId: () => "p-1", now: () => Date.parse("2026-10-08T16:30:00.000Z") });
  const out: DaemonFrame[] = [];
  const conn = new Connection({
    registry: new FakeRegistry() as never,
    attachments: { save: async () => ({ path: "", bytes: 0 }) },
    isValidToken: () => true,
    sealed: true,
    route: "lan",
    prompts,
    plans,
    daemon: { id: "d_1", name: "Mac", version: "0.1.0" },
    log: silentLogger,
    out: (f) => out.push(f),
    close: () => {},
    setTimer: () => 0,
    clearTimer: () => {},
  });
  const replies: unknown[] = [];
  const planHook = { hook_event_name: "PermissionRequest", permission_mode: "plan", tool_name: "ExitPlanMode", tool_input: { plan: "# Plan\n", planFilePath: planPath } };
  const ask = () => {
    plans.hook("gr-a", planHook);
    prompts.open("gr-a", planHook, (r) => replies.push(r));
  };
  const send = (frame: object) => conn.handleMessage(JSON.stringify(frame));
  const of = (type: string) => out.filter((f) => f.type === type);
  return { plans, files, conn, out, replies, ask, send, of };
}

describe("plans on a connection", () => {
  it("follows a plan, takes an edit and answers it with its id", async () => {
    const { plans, files, send, of } = setup();
    await send(JSON.parse(hello));
    plans.hook("gr-a", { hook_event_name: "PreToolUse", permission_mode: "plan", tool_name: "Write", tool_input: { file_path: planPath } });
    await send({ type: "plan.subscribe", sessionId: "gr-a" });
    await flush();
    expect(of("plan")).toMatchObject([{ sessionId: "gr-a", text: "# Plan\n", writing: true, by: "agent" }]);
    await send({ type: "plan.write", sessionId: "gr-a", id: "w-1", text: "# Mine\n" });
    expect(of("error")).toMatchObject([{ code: "bad_frame", ref: "plan.write", id: "w-1", message: "Claude is writing the plan. Edit it once it's done." }]);
    plans.hook("gr-a", { hook_event_name: "Stop", permission_mode: "plan" });
    await send({ type: "plan.write", sessionId: "gr-a", id: "w-2", text: "# Mine\n" });
    expect(files.get(planPath)).toBe("# Mine\n");
    expect(of("plan").at(-1)).toMatchObject({ id: "w-2", text: "# Mine\n", by: "user", writing: false });
  });

  it("refuses the plan frames for an agent without plans", async () => {
    const { send, of } = setup();
    await send(JSON.parse(hello));
    await send({ type: "plan.subscribe", sessionId: "gr-s" });
    expect(of("error")).toMatchObject([{ code: "bad_frame", ref: "plan.subscribe" }]);
  });

  it("builds the plan with the user's edits, accepting edits", async () => {
    const { files, replies, ask, send } = setup();
    await send(JSON.parse(hello));
    ask();
    files.set(planPath, "# Plan\n\n- Mine too\n");
    await send({ type: "prompt.answer", sessionId: "gr-a", promptId: "p-1", allow: true, build: "acceptEdits" });
    expect(replies).toEqual([
      {
        hookSpecificOutput: {
          hookEventName: "PermissionRequest",
          decision: {
            behavior: "allow",
            updatedInput: { plan: "# Plan\n\n- Mine too\n", planFilePath: planPath },
            updatedPermissions: [{ type: "setMode", mode: "acceptEdits", destination: "session" }],
          },
        },
      },
    ]);
  });

  it("sends a plan back saying the user edited it", async () => {
    const { plans, replies, ask, send } = setup();
    await send(JSON.parse(hello));
    ask();
    await plans.write("gr-a", "# Mine\n");
    await send({ type: "prompt.answer", sessionId: "gr-a", promptId: "p-1", allow: false, feedback: "Shorter" });
    expect(replies).toMatchObject([{ hookSpecificOutput: { decision: { behavior: "deny", message: expect.stringContaining("(I edited the plan in ~/.claude/plans/velvety-knitting-shell.md myself") } } }]);
    // Told once: the next prompt carries nothing.
    expect(plans.takeEditedNote("gr-a")).toBeUndefined();
  });
});
