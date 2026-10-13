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
import { LEGACY_SERVICE_LABEL, SERVICE_LABEL, domainTarget, plistPath, renderPlist, serviceTarget, stableProgram } from "./launchdPlist.js";
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
  // Two agents would start two daemons: the one under the old label goes.
  if (label === SERVICE_LABEL) await removePlistAndJob(LEGACY_SERVICE_LABEL);
  mkdirSync(dirname(plist), { recursive: true });
  mkdirSync(o.logDir, { recursive: true });
  writeFileSync(plist, text, { mode: 0o644 });
  // A job someone turned off with `launchctl disable` would refuse to load.
  await launchctl(["enable", serviceTarget(uid(), label)]).catch(() => undefined);
  await launchctl(["bootstrap", domainTarget(uid()), plist]);
  return serviceStatus(label);
}

/** Stops the agent and deletes the plist, the one under the old label too. Returns false when there was nothing to remove. */
export async function removeService(label: string = SERVICE_LABEL): Promise<boolean> {
  const removed = await removePlistAndJob(label);
  const legacy = label === SERVICE_LABEL && (await removePlistAndJob(LEGACY_SERVICE_LABEL));
  return removed || legacy;
}

/** The agent's state. For the default label, an agent that has not yet moved off the old one answers in its place. */
export async function serviceStatus(label: string = SERVICE_LABEL): Promise<ServiceStatus> {
  const s = await statusOf(label);
  if (label !== SERVICE_LABEL || s.installed || s.loaded) return s;
  const legacy = await statusOf(LEGACY_SERVICE_LABEL);
  return legacy.installed || legacy.loaded ? legacy : s;
}

/** Stops the running agent and starts it again at once (`kickstart -k`): the way to run a newly installed version. */
export async function restartService(label: string = SERVICE_LABEL): Promise<void> {
  await launchctl(["kickstart", "-k", serviceTarget(uid(), (await serviceStatus(label)).label)]);
}

/** One label's agent, with no fallback to the old label. */
export async function statusOf(label: string): Promise<ServiceStatus> {
  const plist = plistPath(homedir(), label);
  const printed = await launchctl(["print", serviceTarget(uid(), label)]).catch(() => null);
  return { ...parseLaunchctlPrint(printed), installed: existsSync(plist), file: plist, label, manager: "launchd" };
}

/** Returns false when there was nothing to remove. */
async function removePlistAndJob(label: string): Promise<boolean> {
  const before = await statusOf(label);
  if (!before.installed && !before.loaded) return false;
  await unload(label);
  rmSync(before.file, { force: true });
  return true;
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

export async function launchctl(args: string[]): Promise<string> {
  const { stdout } = await run(LAUNCHCTL, args, { timeout: TIMEOUT_MS, encoding: "utf8" });
  return stdout;
}

export function uid(): number {
  return userInfo().uid;
}
