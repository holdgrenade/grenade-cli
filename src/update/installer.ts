/**
 * Runs the install of the latest release for the daemon (`UpdateChecker`), with the installer of this copy
 * (`installerFor`): `brew update` + `brew upgrade grenade`, `npm install -g @holdgrenade/cli@latest`, or the script of
 * `tarballInstall.ts` for a copy unpacked from the release's tarball. Asynchronous,
 * so the daemon keeps serving phones meanwhile, with a time limit. It does not install when the user has pinned the
 * formula (`brew pin grenade`) or when npm's global folder is not writable (it would need sudo).
 */
import { spawn } from "node:child_process";
import { accessSync, constants, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { installCommands, type Installer } from "./versions.js";

export type InstallOutcome = { kind: "done" } | { kind: "failed"; error: string } | { kind: "needsAdmin" } | { kind: "pinned" };

const TIMEOUT_MS = 10 * 60 * 1000;
/** After SIGTERM at the time limit, how long the installer's processes get to end before SIGKILL. */
const KILL_GRACE_MS = 10_000;
const MAX_OUTPUT = 8 * 1024 * 1024;

export async function runInstall(i: Installer): Promise<InstallOutcome> {
  if (i.method === "brew") {
    if (!existsSync(i.brew)) return { kind: "failed", error: `no Homebrew at ${i.brew}` };
    const pinned = await runInstallCommand([i.brew, "list", "--pinned"]);
    if (pinned.ok && pinned.stdout.split(/\s+/).includes("grenade")) return { kind: "pinned" };
  }
  const npm = i.method === "npm" ? i.npm.find((p) => existsSync(p)) : undefined;
  if (i.method === "npm") {
    if (!npm) return { kind: "failed", error: "could not find npm" };
    if (!i.writes.every(writable)) return { kind: "needsAdmin" };
  }
  if (i.method === "tarball" && !writable(i.root)) return { kind: "failed", error: `cannot write ${i.root}` };
  for (const command of installCommands(i, npm ?? "")) {
    const r = await runInstallCommand(command);
    if (!r.ok) return { kind: "failed", error: installError(command, r.stderr) };
  }
  // An upgrade cut short (the time limit, a lost network) can leave the new keg poured and `bin/grenade` unlinked, and
  // `brew upgrade` then says "already installed" without linking it, while launchd has nothing to start the daemon from.
  if (i.method === "brew" && !existsSync(join(dirname(i.brew), "grenade"))) {
    const link = [i.brew, "link", "grenade"];
    const r = await runInstallCommand(link);
    if (!r.ok) return { kind: "failed", error: installError(link, r.stderr) };
  }
  return { kind: "done" };
}

/** A short reason for the sidebar and `grenade status`, from what the installer printed. Pure. */
export function installError(command: string[], stderr: string): string {
  const tool = command[0]?.endsWith("/brew") ? "Homebrew" : command[0]?.endsWith("/sh") ? "The download" : "npm";
  if (/already locked|another active homebrew|process has already locked/i.test(stderr)) return "Homebrew was busy";
  if (/ENOTFOUND|EAI_AGAIN|Could not resolve host|Failed to connect|Couldn't connect|network/i.test(stderr)) return `${tool} could not reach the internet`;
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

export interface CommandResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

export interface CommandLimits {
  timeoutMs: number;
  killGraceMs: number;
}

/**
 * Runs one installer command in a process group of its own, and at the time limit ends the whole group. A timeout
 * that killed only brew left the curl it had started running with brew's lock on grenade (a child inherits the lock's
 * descriptor), so every retry for hours after, and a `grenade update` by hand, was "Homebrew was busy".
 */
export function runInstallCommand(command: string[], limits: CommandLimits = { timeoutMs: TIMEOUT_MS, killGraceMs: KILL_GRACE_MS }): Promise<CommandResult> {
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
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const settle = (r: CommandResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    const child = spawn(bin!, args, { env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    const killGroup = (signal: NodeJS.Signals): void => {
      if (!child.pid) return;
      try {
        process.kill(-child.pid, signal);
      } catch {
        // gone already
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup("SIGTERM");
      setTimeout(() => {
        killGroup("SIGKILL");
        // `close` waits for every holder of the pipes; a process that left the group would hold them for good.
        setTimeout(() => settle({ ok: false, stdout, stderr: "timed out" }), 1000).unref();
      }, limits.killGraceMs).unref();
    }, limits.timeoutMs);
    child.stdout.on("data", (d: Buffer) => {
      if (stdout.length < MAX_OUTPUT) stdout += d.toString();
    });
    child.stderr.on("data", (d: Buffer) => {
      if (stderr.length < MAX_OUTPUT) stderr += d.toString();
    });
    child.on("error", (e) => settle({ ok: false, stdout, stderr: e.message }));
    child.on("close", (code) => {
      if (timedOut) return settle({ ok: false, stdout, stderr: "timed out" });
      settle({ ok: code === 0, stdout, stderr: stderr || (code === 0 ? "" : `exit ${code ?? "?"}`) });
    });
  });
}
