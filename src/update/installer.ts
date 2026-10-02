/**
 * Runs the install of the latest release for the daemon (`UpdateChecker`), with the installer of this copy
 * (`installerFor`): `brew update` + `brew upgrade grenade`, or `npm install -g @holdgrenade/cli@latest`. Asynchronous,
 * so the daemon keeps serving phones meanwhile, with a time limit. It does not install when the user has pinned the
 * formula (`brew pin grenade`) or when npm's global folder is not writable (it would need sudo).
 */
import { execFile } from "node:child_process";
import { accessSync, constants, existsSync } from "node:fs";
import { dirname } from "node:path";
import { installCommands, type Installer } from "./versions.js";

export type InstallOutcome = { kind: "done" } | { kind: "failed"; error: string } | { kind: "needsAdmin" } | { kind: "pinned" };

const TIMEOUT_MS = 10 * 60 * 1000;

export async function runInstall(i: Installer): Promise<InstallOutcome> {
  if (i.method === "brew") {
    if (!existsSync(i.brew)) return { kind: "failed", error: `no Homebrew at ${i.brew}` };
    const pinned = await run([i.brew, "list", "--pinned"]);
    if (pinned.ok && pinned.stdout.split(/\s+/).includes("grenade")) return { kind: "pinned" };
  }
  const npm = i.method === "npm" ? i.npm.find((p) => existsSync(p)) : undefined;
  if (i.method === "npm") {
    if (!npm) return { kind: "failed", error: "could not find npm" };
    if (!i.writes.every(writable)) return { kind: "needsAdmin" };
  }
  for (const command of installCommands(i, npm ?? "")) {
    const r = await run(command);
    if (!r.ok) return { kind: "failed", error: installError(command, r.stderr) };
  }
  return { kind: "done" };
}

/** A short reason for the sidebar and `grenade status`, from what the installer printed. Pure. */
export function installError(command: string[], stderr: string): string {
  const tool = command[0]?.endsWith("/brew") ? "Homebrew" : "npm";
  if (/already locked|another active homebrew|process has already locked/i.test(stderr)) return "Homebrew was busy";
  if (/ENOTFOUND|EAI_AGAIN|Could not resolve host|Failed to connect|network/i.test(stderr)) return `${tool} could not reach the internet`;
  if (/timed out|ETIMEDOUT|SIGTERM/i.test(stderr)) return `${tool} took too long`;
  if (/EACCES|Permission denied/i.test(stderr)) return `${tool} was not allowed to write its folder`;
  const last = stderr.trim().split("\n").filter((l) => l.trim()).pop()?.trim();
  return last ? `${tool}: ${last.replace(/^Error:\s*/, "").slice(0, 160)}` : `${tool} failed`;
}

/** Whether this user can write `dir` (npm's global folder). */
export function writable(dir: string): boolean {
  try {
    accessSync(dir, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function run(command: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const [bin, ...args] = command;
  const env = {
    ...process.env,
    // npm's own `#!/usr/bin/env node` must find the node beside it under launchd's bare PATH.
    PATH: `${dirname(bin!)}:${process.env["PATH"] ?? "/usr/bin:/bin"}`,
    HOMEBREW_NO_ENV_HINTS: "1",
    HOMEBREW_NO_INSTALL_CLEANUP: "1",
    HOMEBREW_NO_AUTO_UPDATE: "1", // `brew update` runs first, on its own
  };
  return new Promise((resolve) => {
    execFile(bin!, args, { env, timeout: TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      const timedOut = error && (error as NodeJS.ErrnoException & { killed?: boolean }).killed;
      resolve({ ok: !error, stdout: String(stdout), stderr: timedOut ? "timed out" : String(stderr || (error?.message ?? "")) });
    });
  });
}
