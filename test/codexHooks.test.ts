import { execFileSync } from "node:child_process";
import { claudeStatusLine } from "../src/usage/claudeStatusLine.js";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { handleCodexHook } from "../src/daemon/codexHooks.js";
import { CODEX_HOOK_EVENTS, codexHookCommand, codexHookFlags, removeCodexHooks } from "../src/hooks/installCodexHooks.js";
import { claudeHookFlags, mergeHooks } from "../src/hooks/installHooks.js";
import { silentLogger } from "../src/log.js";
import { agentCommand } from "../src/tmux/parse.js";

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

describe("the hooks an agent starts with", () => {
  /** What the program would get: a stand-in on PATH prints each argument on its own line. */
  const argv = (command: string, program: string) => {
    const bin = mkdtempSync(join(tmpdir(), "grenade-argv-"));
    writeFileSync(join(bin, program), '#!/bin/sh\nfor a in "$@"; do printf "%s\\n" "$a"; done\n', { mode: 0o755 });
    return execFileSync("/bin/sh", ["-c", command], { env: { PATH: `${bin}:/usr/bin:/bin` }, encoding: "utf8" }).trimEnd().split("\n");
  };
  it("gives Codex one -c hooks.<Event> per event, each a TOML array Codex can read", () => {
    const args = argv(agentCommand("codex", undefined, undefined, { codex: codexHookFlags(7788) }), "codex");
    expect(args.filter((a) => a === "-c")).toHaveLength(CODEX_HOOK_EVENTS.length);
    const stop = args.find((a) => a.startsWith("hooks.Stop="));
    expect(stop).toBe(`hooks.Stop=[{matcher="",hooks=[{type="command",command="${codexHookCommand(7788).replace(/"/g, '\\"')}"}]}]`);
    // Inline, so tmux keeps its scrollback (the alternate screen keeps none).
    expect(args.at(-1)).toBe("--no-alt-screen");
  });
  it("gives Claude Code the same hooks install-hooks writes, and Grenade's status line, as --settings, also for a resumed copy", () => {
    const args = argv(agentCommand("claude", undefined, "9a76de47-6489-4620-8e10-4bf9c4d12b09", { claude: claudeHookFlags(7788) }), "claude");
    expect(args[0]).toBe("--settings");
    expect(JSON.parse(args[1]!)).toEqual({ ...mergeHooks({}, 7788).settings, statusLine: claudeStatusLine(7788) });
    expect(args.slice(2)).toEqual(["--resume", "9a76de47-6489-4620-8e10-4bf9c4d12b09", "--fork-session"]);
  });
  it("are the same for every session, so Codex asks to trust them once", () => {
    expect(codexHookFlags(7788)).toBe(codexHookFlags(7788));
    expect(codexHookFlags(7788)).toContain("$GRENADE_SESSION");
  });
  it("run a command that is silent and succeeds with no daemon", () => {
    const out = execFileSync("/bin/sh", ["-c", codexHookCommand(1)], { input: "{}", env: { PATH: process.env["PATH"] ?? "", GRENADE_SESSION: "gr-x" }, encoding: "utf8" });
    expect(out).toBe("");
  });
});

describe("the hooks.json entries of CLI 1.0.23", () => {
  it("come out, and the user's own stay", () => {
    const mine = { matcher: "", hooks: [{ type: "command", command: "say done" }] };
    const old = { matcher: "", hooks: [{ type: "command", command: `[ -z "$GRENADE_SESSION" ] || curl -s -m 1 -o /dev/null -X POST "http://127.0.0.1:7788/hooks/codex?session=$GRENADE_SESSION" || true` }] };
    const { settings, changed } = removeCodexHooks({ hooks: { Stop: [mine, old], Interrupt: [old] } });
    expect(changed).toBe(true);
    expect(settings.hooks?.["Stop"]).toEqual([mine]);
    expect(settings.hooks?.["Interrupt"]).toEqual([]);
  });
});
