/**
 * Installs, removes and inspects the systemd user service that keeps grenaded running on Linux (`grenade service …`).
 * The one file written is the unit in ~/.config/systemd/user; everything else is `systemctl --user`, which needs no
 * admin rights. It runs while the user is logged in (`loginctl enable-linger` keeps it past that; Grenade never
 * sets it).
 */
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { servicePath } from "./servicePath.js";
import type { ServiceOptions, ServiceStatus } from "./serviceTypes.js";
import { parseSystemctlShow, SHOWN_PROPERTIES } from "./systemctlOutput.js";
import { UNIT_LABEL, renderUnit, unitName, unitPath } from "./systemdUnit.js";

const run = promisify(execFile);
const TIMEOUT_MS = 10_000;

/** Writes the unit and starts the service. One that is already running is replaced. */
export async function installService(o: ServiceOptions): Promise<ServiceStatus> {
  const label = o.label ?? UNIT_LABEL;
  const file = fileOf(label);
  const text = renderUnit({
    label,
    program: o.program,
    args: o.args,
    path: servicePath(process.env["PATH"], homedir(), dirname(process.execPath)),
    env: { ...o.env, ...(process.env["SHELL"] ? { SHELL: process.env["SHELL"] } : {}) },
    logPath: join(o.logDir, "systemd.log"),
  });
  mkdirSync(dirname(file), { recursive: true });
  mkdirSync(o.logDir, { recursive: true });
  writeFileSync(file, text, { mode: 0o644 });
  try {
    await systemctl(["daemon-reload"]);
    await systemctl(["enable", unitName(label)]);
    await systemctl(["restart", unitName(label)]);
  } catch (e) {
    // Nothing half-installed stays behind: a unit left on disk would start at some later login, unasked.
    await systemctl(["disable", unitName(label)]).catch(() => undefined);
    rmSync(file, { force: true });
    await systemctl(["daemon-reload"]).catch(() => undefined);
    throw new Error(`systemd could not start grenaded (${reason(e)}). Without systemd's user session, start it yourself with: grenade daemon`);
  }
  return serviceStatus(label);
}

/** Stops the service and deletes the unit. Returns false when there was nothing to remove. */
export async function removeService(label: string = UNIT_LABEL): Promise<boolean> {
  const before = await serviceStatus(label);
  await systemctl(["disable", "--now", unitName(label)]).catch(() => undefined);
  rmSync(fileOf(label), { force: true });
  await systemctl(["daemon-reload"]).catch(() => undefined);
  return before.installed || before.loaded;
}

export async function serviceStatus(label: string = UNIT_LABEL): Promise<ServiceStatus> {
  const file = fileOf(label);
  const shown = await systemctl(["show", unitName(label), `--property=${SHOWN_PROPERTIES.join(",")}`]).catch(() => null);
  return { ...parseSystemctlShow(shown), installed: existsSync(file), file, label, manager: "systemd" };
}

/** Stops the running service and starts it again at once: the way to run a newly installed version. */
export async function restartService(label: string = UNIT_LABEL): Promise<void> {
  await systemctl(["restart", unitName(label)]);
}

function fileOf(label: string): string {
  return unitPath(homedir(), label, process.env["XDG_CONFIG_HOME"]);
}

async function systemctl(args: string[]): Promise<string> {
  const { stdout } = await run("systemctl", ["--user", ...args], { timeout: TIMEOUT_MS, encoding: "utf8" });
  return stdout;
}

/** The last line systemctl printed, or why it could not be run. */
function reason(e: unknown): string {
  const stderr = (e as { stderr?: unknown }).stderr;
  const text = typeof stderr === "string" && stderr.trim() ? stderr : e instanceof Error ? e.message : String(e);
  return text.trim().split("\n").pop() ?? "unknown";
}
