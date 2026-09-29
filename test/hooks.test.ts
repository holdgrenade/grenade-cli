import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { handleClaudeHook } from "../src/daemon/hooks.js";
import { silentLogger } from "../src/log.js";

const body = readFileSync(join(import.meta.dirname, "..", "..", "grenade-protocol", "fixtures", "http.hook.claude.json"), "utf8");

describe("handleClaudeHook", () => {
  const registry = (known: boolean) => {
    const applied: string[] = [];
    return { applied, applyHook: (id: string, s: string) => (known ? (applied.push(`${id}:${s}`), true) : false) };
  };
  it("applies a Notification as waiting", () => {
    const r = registry(true);
    expect(handleClaudeHook(r, "gr-a", body, silentLogger)).toEqual({ status: 200, body: { ok: true, applied: "waiting" } });
    expect(r.applied).toEqual(["gr-a:waiting"]);
  });
  it("ignores hooks without a session param", () => {
    expect(handleClaudeHook(registry(true), null, body, silentLogger).status).toBe(202);
  });
  it("404s unknown sessions and 400s bad bodies", () => {
    expect(handleClaudeHook(registry(false), "gr-a", body, silentLogger).status).toBe(404);
    expect(handleClaudeHook(registry(true), "gr-a", "{", silentLogger).status).toBe(400);
  });
  it("202s events that carry no status", () => {
    expect(handleClaudeHook(registry(true), "gr-a", JSON.stringify({ hook_event_name: "SubagentStop" }), silentLogger).status).toBe(202);
  });
});

describe("handleClaudeHook prompts", () => {
  it("passes a UserPromptSubmit prompt on for the summary", () => {
    const prompts: string[] = [];
    const r = { applyHook: () => true };
    const body = JSON.stringify({ hook_event_name: "UserPromptSubmit", prompt: "fix the tests" });
    expect(handleClaudeHook(r, "gr-a", body, silentLogger, (id, p) => prompts.push(`${id}:${p}`)).status).toBe(200);
    expect(prompts).toEqual(["gr-a:fix the tests"]);
  });
});

describe("handleClaudeHook transcripts", () => {
  it("passes the transcript path of an applied hook on for the model", () => {
    const paths: string[] = [];
    const r = { applyHook: () => true };
    expect(handleClaudeHook(r, "gr-a", body, silentLogger, undefined, (id, p) => paths.push(`${id}:${p}`)).status).toBe(200);
    expect(paths).toEqual(["gr-a:/Users/adam/.claude/projects/-Users-adam-workspace-grenade/3a1c.jsonl"]);
  });
});

describe("handleClaudeHook: why the session waits", () => {
  const registry = () => {
    const applied: string[] = [];
    return { applied, applyHook: (id: string, s: string, waitingFor?: string) => (applied.push(`${id}:${s}:${waitingFor ?? "-"}`), true) };
  };
  const hook = (payload: Record<string, unknown>) => JSON.stringify(payload);

  it("a permission prompt is a question, and its message is what was asked", () => {
    const r = registry();
    const asked: string[] = [];
    handleClaudeHook(r, "gr-a", body, silentLogger, undefined, undefined, (id, m) => asked.push(`${id}:${m}`));
    expect(r.applied).toEqual(["gr-a:waiting:answer"]);
    expect(asked).toEqual(["gr-a:Claude needs your permission to use Bash"]);
  });

  it("Stop is a finished turn", () => {
    const r = registry();
    handleClaudeHook(r, "gr-a", hook({ hook_event_name: "Stop" }), silentLogger);
    expect(r.applied).toEqual(["gr-a:waiting:done"]);
  });

  it("PermissionRequest is a question", () => {
    const r = registry();
    handleClaudeHook(r, "gr-a", hook({ hook_event_name: "PermissionRequest", tool_name: "Bash" }), silentLogger);
    expect(r.applied).toEqual(["gr-a:waiting:answer"]);
  });

  it("idle_prompt changes nothing", () => {
    const r = registry();
    const asked: string[] = [];
    const result = handleClaudeHook(r, "gr-a", hook({ hook_event_name: "Notification", notification_type: "idle_prompt", message: "Claude is waiting for your input" }), silentLogger, undefined, undefined, (_, m) => asked.push(m));
    expect(result.status).toBe(202);
    expect(r.applied).toEqual([]);
    expect(asked).toEqual([]);
  });

  it("working hooks carry no reason", () => {
    const r = registry();
    handleClaudeHook(r, "gr-a", hook({ hook_event_name: "PreToolUse" }), silentLogger);
    expect(r.applied).toEqual(["gr-a:working:-"]);
  });
});
