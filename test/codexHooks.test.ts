import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { handleCodexHook } from "../src/daemon/codexHooks.js";
import { CODEX_HOOK_EVENTS, codexHookCommand, mergeCodexHooks, removeCodexHooks } from "../src/hooks/installCodexHooks.js";
import { mergeHooks } from "../src/hooks/installHooks.js";
import { silentLogger } from "../src/log.js";

const registry = () => {
  const applied: string[] = [];
  return { applied, applyHook: (id: string, s: string, w?: string) => (applied.push(`${id}:${s}${w ? `:${w}` : ""}`), true) };
};

describe("handleCodexHook", () => {
  it("applies Stop as done, Interrupt as idle, and passes on prompt, model and rollout", () => {
    const r = registry();
    const seen: string[] = [];
    const on = {
      onPrompt: (id: string, p: string) => seen.push(`prompt ${p}`),
      onModel: (id: string, m: string) => seen.push(`model ${m}`),
      onTranscript: (id: string, path: string, event: string) => seen.push(`${event} ${path}`),
    };
    const send = (b: object) => handleCodexHook(r, "gr-c", JSON.stringify(b), silentLogger, on);
    expect(send({ hook_event_name: "UserPromptSubmit", prompt: "fix it", transcript_path: "/r.jsonl", model: "gpt-6-luna" }).status).toBe(200);
    expect(send({ hook_event_name: "Stop", transcript_path: "/r.jsonl" }).body.applied).toBe("waiting");
    expect(send({ hook_event_name: "Interrupt", transcript_path: "/r.jsonl" }).body.applied).toBe("idle");
    expect(r.applied).toEqual(["gr-c:working", "gr-c:waiting:done", "gr-c:idle"]);
    expect(seen).toEqual(["model gpt-6-luna", "prompt fix it", "UserPromptSubmit /r.jsonl", "Stop /r.jsonl", "Interrupt /r.jsonl"]);
  });
  it("ignores hooks outside a Grenade session and events without a status", () => {
    expect(handleCodexHook(registry(), null, "{}", silentLogger).status).toBe(202);
    expect(handleCodexHook(registry(), "gr-c", JSON.stringify({ hook_event_name: "SessionStart", transcript_path: null }), silentLogger).status).toBe(202);
    expect(handleCodexHook(registry(), "gr-c", "{", silentLogger).status).toBe(400);
  });
});

describe("Codex hooks.json", () => {
  it("gets one Grenade command per event, once, beside the user's own hooks", () => {
    const mine = { hooks: { Stop: [{ matcher: "", hooks: [{ type: "command", command: "say done" }] }] } };
    const first = mergeCodexHooks(mine, 7788);
    expect(first.changed).toBe(true);
    expect(Object.keys(first.settings.hooks ?? {}).sort()).toEqual([...CODEX_HOOK_EVENTS].sort());
    expect(first.settings.hooks?.["Stop"]).toHaveLength(2);
    expect(mergeCodexHooks(first.settings, 7788).changed).toBe(false);
    const removed = removeCodexHooks(first.settings).settings.hooks ?? {};
    expect(removed["Stop"]).toEqual(mine.hooks.Stop);
    expect(Object.values(removed).flat()).toHaveLength(1);
  });
  it("is not touched by the Claude Code merge, and the other way round", () => {
    const codex = mergeCodexHooks({}, 7788).settings;
    const both = mergeHooks(codex, 7788).settings;
    expect(removeCodexHooks(both).settings.hooks?.["UserPromptSubmit"]?.[0]?.hooks?.[0]?.command).toContain("/hooks/claude");
  });
  it("runs a command that is silent and succeeds outside a session and with no daemon", () => {
    const run = (env: Record<string, string>) => execFileSync("/bin/sh", ["-c", codexHookCommand(1)], { input: "{}", env: { PATH: process.env["PATH"] ?? "", ...env }, encoding: "utf8" });
    expect(run({})).toBe("");
    expect(run({ GRENADE_SESSION: "gr-x" })).toBe("");
  });
});
