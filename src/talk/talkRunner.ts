/**
 * Runs one Talk turn of an agent: finds its program and spawns what `talkAgents.ts` builds, with the words on stdin,
 * in the private work folder, with the turn's id and secret in the environment (for Grenade's MCP server) and without
 * `GRENADE_SESSION`, so the run never reports as a session. Stopped after `TALK_TIMEOUT_MS`.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { findOnPath } from "../platform/findOnPath.js";
import { resolveClaudeBin } from "../summary/claudeCli.js";
import { claudeOutcome, claudeTalkArgs, codexOutcome, codexTalkArgs, type TalkAgentKind, type TalkOutcome, type TalkTurnSpec } from "./talkAgents.js";

/** How long a turn may take before it is stopped and the owner told. */
export const TALK_TIMEOUT_MS = 5 * 60 * 1000;

/** Absolute codex path: a daemon started by launchd or systemd may not have the user's PATH. `CODEX_BIN` overrides. */
export function resolveCodexBin(): string | undefined {
  const fromEnv = process.env["CODEX_BIN"];
  if (fromEnv) return fromEnv;
  const found = findOnPath("codex");
  if (found) return found;
  const candidates = ["/opt/homebrew/bin/codex", "/usr/local/bin/codex", join(homedir(), ".local", "bin", "codex"), join(homedir(), ".local", "share", "mise", "shims", "codex")];
  return candidates.find((c) => existsSync(c));
}

/** Where each agent's program is, or undefined when it is not installed. */
export function resolveTalkBin(agent: TalkAgentKind): string | undefined {
  return agent === "claude" ? resolveClaudeBin() : resolveCodexBin();
}

/** What runs a turn. Tests pass a fake. */
export type TalkRun = (agent: TalkAgentKind, spec: TalkTurnSpec, words: string, env: Record<string, string>) => Promise<TalkOutcome>;

/** Runs the real agent. */
export const runTalkAgent: TalkRun = async (agent, spec, words, extraEnv) => {
  const bin = resolveTalkBin(agent);
  if (!bin) return { failure: "notInstalled", detail: `${agent} was not found` };
  const args = agent === "claude" ? claudeTalkArgs(spec) : codexTalkArgs(spec);
  const env: NodeJS.ProcessEnv = { ...process.env, ...extraEnv };
  delete env["GRENADE_SESSION"];
  const run = await spawnTurn(bin, args, words, spec.workDir, env);
  if (run.spawnError) return { failure: run.spawnError === "ENOENT" ? "notInstalled" : "failed", detail: run.spawnError };
  if (run.timedOut) return { failure: "timeout", detail: "" };
  return agent === "claude" ? claudeOutcome(run.stdout, run.stderr, run.code) : codexOutcome(run.stdout, run.stderr, run.code);
};

interface SpawnResult {
  stdout: string;
  stderr: string;
  code: number | null;
  timedOut: boolean;
  spawnError?: string;
}

function spawnTurn(bin: string, args: string[], input: string, cwd: string, env: NodeJS.ProcessEnv): Promise<SpawnResult> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5000).unref();
    }, TALK_TIMEOUT_MS);
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    // Codex logs to stderr all the way through; keep its end only.
    child.stderr.on("data", (d: Buffer) => (stderr = (stderr + d.toString()).slice(-8000)));
    child.on("error", (e: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code: null, timedOut, spawnError: e.code ?? e.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code, timedOut });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}
