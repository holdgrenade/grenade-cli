/**
 * Installs, removes and inspects the launchd agent that keeps grenaded running (`grenade service …`).
 * The one file written is the plist in ~/Library/LaunchAgents; everything else is `launchctl`.
 */
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { parseLaunchctlPrint } from "./launchctlOutput.js";
import { SERVICE_LABEL, domainTarget, plistPath, renderPlist, serviceTarget, stableProgram } from "./launchdPlist.js";
import { servicePath } from "./servicePath.js";
import type { ServiceOptions, ServiceStatus } from "./serviceTypes.js";

const run = promisify(execFile);
const LAUNCHCTL = "/bin/launchctl";
const TIMEOUT_MS = 10_000;

/** Writes the plist and starts the agent. An agent that is already loaded is replaced. */
export async function installService(o: ServiceOptions): Promise<ServiceStatus> {
  const label = o.label ?? SERVICE_LABEL;
  const plist = plistPath(homedir(), label);
  const text = renderPlist({
    label,
    program: stableProgram(o.program),
    args: o.args,
    path: servicePath(process.env["PATH"], homedir(), dirname(stableProgram(process.execPath))),
    env: { ...o.env, ...(process.env["SHELL"] ? { SHELL: process.env["SHELL"] } : {}) },
    logPath: join(o.logDir, "launchd.log"),
  });
  await unload(label);
  mkdirSync(dirname(plist), { recursive: true });
  mkdirSync(o.logDir, { recursive: true });
  writeFileSync(plist, text, { mode: 0o644 });
  // A job someone turned off with `launchctl disable` would refuse to load.
  await launchctl(["enable", serviceTarget(uid(), label)]).catch(() => undefined);
  await launchctl(["bootstrap", domainTarget(uid()), plist]);
  return serviceStatus(label);
}

/** Stops the agent and deletes the plist. Returns false when there was nothing to remove. */
export async function removeService(label: string = SERVICE_LABEL): Promise<boolean> {
  const plist = plistPath(homedir(), label);
  const before = await serviceStatus(label);
  await unload(label);
  rmSync(plist, { force: true });
  return before.installed || before.loaded;
}

export async function serviceStatus(label: string = SERVICE_LABEL): Promise<ServiceStatus> {
  const plist = plistPath(homedir(), label);
  const printed = await launchctl(["print", serviceTarget(uid(), label)]).catch(() => null);
  return { ...parseLaunchctlPrint(printed), installed: existsSync(plist), file: plist, label, manager: "launchd" };
}

/** Stops the running agent and starts it again at once (`kickstart -k`): the way to run a newly installed version. */
export async function restartService(label: string = SERVICE_LABEL): Promise<void> {
  await launchctl(["kickstart", "-k", serviceTarget(uid(), label)]);
}

/** `bootout` returns before the job is gone, and a `bootstrap` right after it fails, so wait until launchd forgot it. */
async function unload(label: string): Promise<void> {
  const target = serviceTarget(uid(), label);
  await launchctl(["bootout", target]).catch(() => undefined);
  for (let i = 0; i < 50; i++) {
    const still = await launchctl(["print", target]).catch(() => null);
    if (still === null) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`launchd did not stop ${label} within 5 s`);
}

async function launchctl(args: string[]): Promise<string> {
  const { stdout } = await run(LAUNCHCTL, args, { timeout: TIMEOUT_MS, encoding: "utf8" });
  return stdout;
}

function uid(): number {
  return userInfo().uid;
}
