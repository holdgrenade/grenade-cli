/**
 * `grenade update`: install the latest release with the package manager that installed this copy (Homebrew or npm),
 * then run it. The daemon also does this by itself (`UpdateChecker`); `--auto off` stops that, `--auto on` brings it back.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import type { Command } from "commander";
import type { Session } from "@grenade/protocol";
import { VERSION } from "../config.js";
import { defaultLabel, restartService, serviceStatus } from "../service/service.js";
import { readAuto, writeAuto } from "../update/autoSetting.js";
import { writable } from "../update/installer.js";
import { installedVersion, installMethod, resolveProgram } from "../update/installedVersion.js";
import { fetchFormula, fetchNpm } from "../update/updateChecker.js";
import { installCommands, installerFor, isBusy, isNewer, latestFromFormula, latestFromNpm, NPM_ADMIN_COMMAND } from "../update/versions.js";
import type { Control } from "./controlClient.js";

const RESTART_WAIT_MS = 30_000;

export interface UpdateCommandDeps {
  control: Control;
}

export function registerUpdateCommand(program: Command, d: UpdateCommandDeps): void {
  program
    .command("update")
    .description("install the latest version of Grenade and restart grenaded into it")
    .option("--check", "only say whether a new version is out")
    .option("--now", "restart grenaded even while an agent is working")
    .option("--label <label>", "name of the service to restart (a launchd label, or a systemd unit)", defaultLabel())
    .option("--auto <on|off>", "whether grenaded installs new versions by itself (on unless turned off)")
    .action(async (o: { check?: boolean; now?: boolean; label: string; auto?: string }) => {
      if (o.auto !== undefined) return setAuto(o.auto);
      const command = process.argv[1];
      if (!command) throw new Error("cannot tell where the grenade command is installed");
      const before = installedVersion(command) ?? VERSION;
      const method = installMethod(command);
      // An npm copy asks npm: the tap may name a version npm does not have.
      const latest = await (method === "npm" ? fetchNpm().then(latestFromNpm) : fetchFormula().then(latestFromFormula)).catch((e: unknown) => {
        throw new Error(`could not check for a new version: ${e instanceof Error ? e.message : String(e)}`);
      });
      if (!latest) throw new Error(`could not read the latest version from ${method === "npm" ? "npm" : "the Homebrew tap"}`);
      d.control("POST", "/update/check").catch(() => undefined); // the daemon's notice follows at once

      if (!isNewer(latest, before)) {
        console.log(`Grenade ${before} is the latest version.`);
        if (!o.check) await runInstalled(d, o.label, before, o.now === true);
        return;
      }
      if (o.check) return console.log(`Grenade ${latest} is out (you have ${before}). Install it with: grenade update`);

      const installer = installerFor(resolveProgram(command) ?? command, process.execPath);
      if (!installer) {
        return fail(`Grenade ${latest} is out, but this copy (${before}) was built from source. Pull and rebuild it, or install it with: brew install holdgrenade/tap/grenade`);
      }
      const npm = installer.method === "npm" ? installer.npm.find((p) => existsSync(p)) ?? "npm" : "";
      if (installer.method === "npm" && !installer.writes.every(writable)) {
        return fail(`Grenade ${latest} is out. npm's global folder belongs to another user, so install it with: ${NPM_ADMIN_COMMAND}`);
      }
      const commands = installCommands(installer, npm);
      console.log(`Updating Grenade ${before} → ${latest} with ${method === "brew" ? "Homebrew" : "npm"}…`);
      for (const [bin, ...args] of commands) {
        console.log(`$ ${[bin, ...args].join(" ")}`);
        const r = spawnSync(bin!, args, { stdio: "inherit", env: { ...process.env, HOMEBREW_NO_ENV_HINTS: "1", HOMEBREW_NO_AUTO_UPDATE: "1" } });
        if (r.error) return fail(`could not run ${bin}: ${r.error.message}`);
        if (r.status !== 0) return fail(`${bin} failed (exit ${r.status ?? "?"}); Grenade is still ${before}`);
      }
      const after = installedVersion(command);
      if (!after || !isNewer(after, before)) return fail(`the update ran, but Grenade on disk is still ${after ?? "unreadable"}. Try: ${commands.map((c) => c.join(" ")).join(" && ")}`);
      console.log(`Grenade ${after} is installed.`);
      await runInstalled(d, o.label, after, o.now === true);
    });
}

/** Makes the running daemon the installed version: restarts the service, or says what to do. */
async function runInstalled(d: UpdateCommandDeps, label: string, installed: string, now: boolean): Promise<void> {
  const status = await d.control<{ version: string }>("GET", "/status").catch(() => null);
  if (!status) return console.log("grenaded is not running; it runs the new version when it starts.");
  if (!isNewer(installed, status.version)) return;
  const agent = await serviceStatus(label);
  if (!agent.running) return console.log(`grenaded ${status.version} was started by hand. Stop it and start it again to run ${installed}.`);
  const sessions = await d.control<Session[]>("GET", "/sessions").catch(() => []);
  const busy = sessions.filter(isBusy).length;
  if (busy > 0 && !now) {
    return console.log(`${busy} session(s) are busy, so grenaded restarts into ${installed} by itself once they are not (or now: grenade update --now).`);
  }
  await restartService(label);
  const deadline = Date.now() + RESTART_WAIT_MS;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
    const v = await d.control<{ version: string }>("GET", "/status").then((s) => s.version).catch(() => null);
    if (v === installed) return console.log(`grenaded ${installed} is running. Your sessions kept running in tmux; phones reconnect by themselves.`);
  }
  fail(`grenaded did not come back as ${installed} within ${RESTART_WAIT_MS / 1000} s. See: grenade service status`);
}

function setAuto(value: string): void {
  if (value !== "on" && value !== "off") return fail("--auto takes on or off");
  writeAuto(value === "on");
  console.log(readAuto()
    ? "grenaded installs new versions of Grenade by itself, then restarts into them once no session is working."
    : "grenaded no longer installs new versions by itself. It still says when one is out; install it with: grenade update");
}

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}
