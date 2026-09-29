/** Runs one summary through `claude -p` with Haiku, using the Claude Code login already on this Mac. */
import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { SUMMARY_SYSTEM_PROMPT } from "./summaryPrompt.js";

const TIMEOUT_MS = 60_000;

/** Absolute claude path: a daemon started by launchd or iTerm may not have the user's PATH. `CLAUDE_BIN` overrides. */
export function resolveClaudeBin(): string | undefined {
  const fromEnv = process.env["CLAUDE_BIN"];
  if (fromEnv) return fromEnv;
  try {
    const found = execFileSync("/usr/bin/which", ["claude"], { encoding: "utf8" }).trim();
    if (found) return found;
  } catch {
    // fall through
  }
  const candidates = [join(homedir(), ".local", "bin", "claude"), join(homedir(), ".claude", "local", "claude"), "/opt/homebrew/bin/claude", "/usr/local/bin/claude"];
  return candidates.find((c) => existsSync(c));
}

/**
 * The flags keep the call small and side-effect free: no tools, no settings files (so no hooks,
 * including Grenade's own), no MCP servers, no saved session. It runs in the temp folder so no
 * project CLAUDE.md is picked up, and without GRENADE_SESSION so it can never report as a session.
 */
export function claudeSummaryArgs(): string[] {
  return ["-p", "--model", "haiku", "--tools", "", "--setting-sources", "", "--strict-mcp-config", "--no-session-persistence", "--system-prompt", SUMMARY_SYSTEM_PROMPT];
}

export function runClaudeSummary(bin: string, input: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    delete env["GRENADE_SESSION"];
    const child = spawn(bin, claudeSummaryArgs(), { cwd: tmpdir(), env, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), TIMEOUT_MS);
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    child.stderr.on("data", (d: Buffer) => (err += d.toString()));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(`claude exited with ${signal ?? code}: ${err.trim().slice(0, 300)}`));
    });
    child.stdin.end(input);
  });
}
