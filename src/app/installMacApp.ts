/** The I/O of the Mac app's install (`macApp.ts` decides and holds the script): the copy that is there, the newest release, the script, and opening the app. */
import { spawnSync } from "node:child_process";
import { accessSync, constants, existsSync } from "node:fs";
import { homedir } from "node:os";
import { MAC_APP_LATEST_URL, macAppDestination, macAppInstallCommand, macAppPlaces, macAppVersion, parseMacAppRelease, type MacAppRelease } from "./macApp.js";

export interface InstalledMacApp {
  path: string;
  version: string | null;
}

/** The copy in /Applications or in the home folder's Applications, if there is one, with its version. */
export function installedMacApp(home: string = homedir()): InstalledMacApp | null {
  for (const path of macAppPlaces(home)) {
    if (!existsSync(path)) continue;
    const r = spawnSync("/usr/bin/plutil", ["-extract", "CFBundleShortVersionString", "raw", "-o", "-", `${path}/Contents/Info.plist`], { encoding: "utf8" });
    return { path, version: r.status === 0 ? macAppVersion(r.stdout) : null };
  }
  return null;
}

/** The newest release, from latest.json. Throws with the reason when it cannot be read. */
export async function fetchMacAppRelease(): Promise<MacAppRelease> {
  const res = await fetch(MAC_APP_LATEST_URL, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`${MAC_APP_LATEST_URL} answered ${res.status}`);
  const release = parseMacAppRelease(await res.text());
  if (!release) throw new Error(`${MAC_APP_LATEST_URL} does not describe a release`);
  return release;
}

/** Where a new copy goes on this Mac: /Applications when this user can write there. */
export function macAppDestinationHere(home: string = homedir()): string {
  let writable = true;
  try {
    accessSync("/Applications", constants.W_OK);
  } catch {
    writable = false;
  }
  return macAppDestination(home, writable);
}

/** Downloads, checks and copies the release to `destination` (ten minutes at most), then opens it. Throws with the script's last words on a failure. */
export function installMacApp(release: MacAppRelease, destination: string): void {
  const [command, ...args] = macAppInstallCommand(release, destination);
  if (!command) throw new Error("no install command");
  const r = spawnSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 10 * 60_000 });
  if (r.status !== 0) {
    const words = `${r.stderr ?? ""}\n${r.stdout ?? ""}`.trim().split("\n").filter((l) => l.trim() !== "").pop();
    throw new Error(words ?? (r.error ? r.error.message : `exit status ${r.status}`));
  }
  spawnSync("/usr/bin/open", [destination], { stdio: "ignore" });
}
