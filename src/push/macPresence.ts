/**
 * Is someone at the Mac? Read from `ioreg`, which needs no permission: the time since the last keyboard or
 * mouse input, and whether the screen is locked. The parsers are pure; `readMacPresence` runs the commands.
 */
import { execFile } from "node:child_process";

export interface MacPresence {
  /** Milliseconds since the last keyboard or mouse input. */
  idleMs: number;
  locked: boolean;
}

/** `"HIDIdleTime" = 206985692250` (nanoseconds) → milliseconds. Null when the line is missing. */
export function parseHidIdle(ioreg: string): number | null {
  const m = /"HIDIdleTime"\s*=\s*(\d+)/.exec(ioreg);
  if (!m?.[1]) return null;
  return Math.floor(Number(m[1]) / 1_000_000);
}

/** The console user's entry carries `"CGSSessionScreenIsLocked"=Yes` while the screen is locked, and no such key otherwise. */
export function parseScreenLocked(ioreg: string): boolean {
  return /"CGSSessionScreenIsLocked"\s*=\s*(Yes|true|1)\b/i.test(ioreg);
}

/** Someone used the Mac within `atMacMs` and the screen is not locked. Unknown presence counts as away. */
export function isAtMac(presence: MacPresence | null, atMacMs: number): boolean {
  if (!presence || atMacMs <= 0) return false;
  return !presence.locked && presence.idleMs < atMacMs;
}

export type RunCommand = (file: string, args: string[]) => Promise<string>;

const runIoreg: RunCommand = (file, args) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 3000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => (error ? reject(error) : resolve(stdout)));
  });

/** Null when it cannot be read (not macOS, ioreg failed): the caller then treats the Mac as unattended. */
export async function readMacPresence(run: RunCommand = runIoreg, platform: string = process.platform): Promise<MacPresence | null> {
  if (platform !== "darwin") return null;
  try {
    const [hid, root] = await Promise.all([run("/usr/sbin/ioreg", ["-c", "IOHIDSystem", "-d", "4"]), run("/usr/sbin/ioreg", ["-n", "Root", "-d", "1"])]);
    const idleMs = parseHidIdle(hid);
    if (idleMs === null) return null;
    return { idleMs, locked: parseScreenLocked(root) };
  } catch {
    return null;
  }
}
