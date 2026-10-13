import { describe, expect, it } from "vitest";
import type { ReportedBackgroundTask, Session } from "@grenade/protocol";
import { handleCodexHook } from "../src/daemon/codexHooks.js";
import { editChangeOf, handleClaudeHook, stepChangeOf } from "../src/daemon/hooks.js";
import { silentLogger } from "../src/log.js";
import { SessionRegistry } from "../src/sessions/registry.js";
import type { Tmux } from "../src/tmux/tmux.js";

function fakeTmux(): Tmux {
  return {
    async listSessions() { return []; },
    async hasSession() { return false; },
    async newSession() {},
    async capture() { throw new Error("unused"); },
    async captureHistory() { throw new Error("unused"); },
    async applySessionOptions() {},
    async sendText() {},
    async sendKey() {},
    async resize() {},
    async releaseSize() {},
    async windowWidths() { return new Map(); },
    async killSession() {},
  };
}

const start = Date.parse("2026-10-10T14:00:00.000Z");
const make = async () => {
  let t = 0;
  const registry = new SessionRegistry({ tmux: fakeTmux(), log: silentLogger, home: "/Users/me", isDirectory: () => true, now: () => start + ++t * 1000 });
  const updates: Session[] = [];
  registry.on("updated", (s) => updates.push(s));
  await registry.create({ name: "api", cwd: "~/app", agent: "claude" });
  return { registry, updates };
};
const hook = (payload: Record<string, unknown>) => JSON.stringify(payload);
const edit = { hook_event_name: "PreToolUse", tool_name: "Edit", tool_input: { file_path: "/Users/me/app/src/status.ts" } };

describe("stepChangeOf", () => {
  it("a tool's start, its end, and a new turn", () => {
    expect(stepChangeOf("PreToolUse", "Read", { file_path: "/a/b.ts" })).toEqual({ start: "Reading b.ts" });
    expect(stepChangeOf("PostToolUse", "Read", {})).toBe("done");
    expect(stepChangeOf("PostToolUseFailure", "Read", {})).toBe("done");
    expect(stepChangeOf("UserPromptSubmit", undefined, undefined)).toBe("clear");
    expect(stepChangeOf("Stop", undefined, undefined)).toBeNull();
    expect(stepChangeOf("PreToolUse", "AskUserQuestion", {})).toBeNull();
  });
});

describe("Session.step from hooks", () => {
  it("a tool hook says what the agent does; its end marks it done; the turn's end drops it", async () => {
    const { registry, updates } = await make();
    handleClaudeHook(registry, "gr-api", hook(edit), silentLogger);
    expect(registry.get("gr-api")?.step).toEqual({ text: "Editing status.ts", at: expect.any(String) });
    handleClaudeHook(registry, "gr-api", hook({ ...edit, hook_event_name: "PostToolUse" }), silentLogger);
    expect(registry.get("gr-api")?.step?.done).toBe(true);
    updates.length = 0;
    handleClaudeHook(registry, "gr-api", hook({ hook_event_name: "Stop" }), silentLogger);
    expect(registry.get("gr-api")?.status).toBe("waiting");
    expect(registry.get("gr-api")?.step).toBeUndefined();
    expect(updates).toHaveLength(1);
  });

  it("the same tool again sends nothing; a new prompt clears it", async () => {
    const { registry, updates } = await make();
    handleClaudeHook(registry, "gr-api", hook(edit), silentLogger);
    updates.length = 0;
    handleClaudeHook(registry, "gr-api", hook(edit), silentLogger);
    expect(updates).toHaveLength(0);
    handleClaudeHook(registry, "gr-api", hook({ hook_event_name: "UserPromptSubmit", prompt: "now the tests" }), silentLogger);
    expect(registry.get("gr-api")?.step).toBeUndefined();
  });

  it("a subagent's tool calls leave the session's step alone", async () => {
    const { registry } = await make();
    handleClaudeHook(registry, "gr-api", hook({ hook_event_name: "PreToolUse", tool_name: "Task", tool_input: { description: "Find the reducer" } }), silentLogger);
    handleClaudeHook(registry, "gr-api", hook({ ...edit, agent_id: "a1" }), silentLogger);
    expect(registry.get("gr-api")?.step?.text).toBe("Asking an agent to find the reducer");
  });

  it("never while the session only waits for background tasks", async () => {
    const { registry } = await make();
    handleClaudeHook(registry, "gr-api", hook(edit), silentLogger);
    const task: ReportedBackgroundTask = { id: "b1", kind: "shell", command: "npm run deploy" };
    registry.holdForBackground("gr-api", [task]);
    expect(registry.get("gr-api")?.background).toHaveLength(1);
    expect(registry.get("gr-api")?.step).toBeUndefined();
  });

  it("Codex's tool hooks say it too", async () => {
    const { registry } = await make();
    handleCodexHook(registry, "gr-api", hook({ hook_event_name: "PreToolUse", tool_name: "shell", tool_input: { command: ["bash", "-lc", "cargo test"] } }), silentLogger);
    expect(registry.get("gr-api")?.step?.text).toBe("Running cargo test");
  });
});

describe("Session.edited from hooks", () => {
  it("a tool that wrote marks the turn; it stays once the turn ends; a new prompt clears it", async () => {
    const { registry } = await make();
    handleClaudeHook(registry, "gr-api", hook({ hook_event_name: "UserPromptSubmit", prompt: "fix it" }), silentLogger);
    handleClaudeHook(registry, "gr-api", hook({ hook_event_name: "PostToolUse", tool_name: "Read", tool_input: {} }), silentLogger);
    expect(registry.get("gr-api")?.edited).toBeUndefined();
    handleClaudeHook(registry, "gr-api", hook({ ...edit, hook_event_name: "PostToolUse" }), silentLogger);
    expect(registry.get("gr-api")?.edited).toBe(true);
    handleClaudeHook(registry, "gr-api", hook({ hook_event_name: "Stop" }), silentLogger);
    expect(registry.get("gr-api")).toMatchObject({ status: "waiting", edited: true });
    handleClaudeHook(registry, "gr-api", hook({ hook_event_name: "UserPromptSubmit", prompt: "what changed?" }), silentLogger);
    expect(registry.get("gr-api")?.edited).toBeUndefined();
  });

  it("Codex's patch marks it too", async () => {
    const { registry } = await make();
    handleCodexHook(registry, "gr-api", hook({ hook_event_name: "PostToolUse", tool_name: "apply_patch", tool_input: { input: "*** Begin Patch" } }), silentLogger);
    expect(registry.get("gr-api")?.edited).toBe(true);
  });

  it("only writing tools count", () => {
    expect(["Write", "Edit", "MultiEdit", "NotebookEdit", "apply_patch"].map((t) => editChangeOf("PostToolUse", t))).toEqual([true, true, true, true, true]);
    expect(editChangeOf("PostToolUse", "Bash")).toBeNull();
    expect(editChangeOf("PreToolUse", "Edit")).toBeNull();
    expect(editChangeOf("UserPromptSubmit", undefined)).toBe(false);
  });
});

describe("Session.turn", () => {
  it("is sent when it changes, and taken away", async () => {
    const { registry, updates } = await make();
    updates.length = 0;
    registry.noteTurn("gr-api", "design");
    registry.noteTurn("gr-api", "design");
    expect(registry.get("gr-api")?.turn).toBe("design");
    expect(updates).toHaveLength(1);
    registry.noteTurn("gr-api", undefined);
    expect(registry.get("gr-api")?.turn).toBeUndefined();
  });
});

describe("Session.edited from git", () => {
  const changes = (files: number) => ({ branch: "main", ahead: 0, behind: 0, commits: 0, files, added: files, removed: 0 });

  it("a turn whose folder's work moved wrote files, whatever wrote them", async () => {
    const { registry } = await make();
    registry.setChanges("gr-api", changes(1));
    handleClaudeHook(registry, "gr-api", hook({ hook_event_name: "UserPromptSubmit", prompt: "rename it" }), silentLogger);
    registry.setChanges("gr-api", changes(1));
    expect(registry.get("gr-api")?.edited).toBeUndefined();
    // A sed in a Bash tool: no Write hook, but git sees a second file.
    registry.setChanges("gr-api", changes(2));
    expect(registry.get("gr-api")?.edited).toBe(true);
    // The next prompt counts from there.
    handleClaudeHook(registry, "gr-api", hook({ hook_event_name: "UserPromptSubmit", prompt: "what changed?" }), silentLogger);
    expect(registry.get("gr-api")?.edited).toBeUndefined();
  });

  it("not once the turn is long over", async () => {
    let clock = start;
    const registry = new SessionRegistry({ tmux: fakeTmux(), log: silentLogger, home: "/Users/me", isDirectory: () => true, now: () => clock });
    await registry.create({ name: "api", cwd: "~/app", agent: "claude" });
    handleClaudeHook(registry, "gr-api", hook({ hook_event_name: "UserPromptSubmit", prompt: "look" }), silentLogger);
    clock += 1000;
    handleClaudeHook(registry, "gr-api", hook({ hook_event_name: "Stop" }), silentLogger);
    // A minute later, an edit in the folder (someone else's) is not this turn's.
    clock += 60_000;
    registry.setChanges("gr-api", changes(3));
    expect(registry.get("gr-api")?.edited).toBeUndefined();
  });
});
