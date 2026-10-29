/**
 * The version of grenade on disk behind a command, read again each time: after `brew upgrade` or `npm install -g`
 * the same `<prefix>/bin/grenade` resolves to the new release, while the running daemon is still the old one.
 */
import { readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { installMethodOf, type InstallMethod } from "./versions.js";

/** The real path of the command, symlinks followed. Null when it is gone (mid-upgrade). */
export function resolveProgram(program: string): string | null {
  try {
    return realpathSync(program);
  } catch {
    return null;
  }
}

/**
 * The version the `dist/` folder at `distDir` was built as: its `version.json`, which `npm run build` writes, else the
 * package.json one up (a release, whose bundle and package.json ship together). A checkout's package.json moves on at
 * every pull (CI's version bump) while its dist/ waits for a build: read from package.json, a daemon running a
 * 12-day-old build said 1.0.124 and restarted "into" each new version without running any of it (2026-10-29).
 */
export function builtVersion(distDir: string): string | null {
  for (const file of [join(distDir, "version.json"), join(distDir, "..", "package.json")]) {
    try {
      const { version } = JSON.parse(readFileSync(file, "utf8")) as { version?: unknown };
      if (typeof version === "string") return version;
    } catch {
      // not there (a release has no version.json), or unreadable mid-build: try the next
    }
  }
  return null;
}

/** The command is `<package>/dist/cli.js` in every layout (release tarball and `tsc` build). */
export function installedVersion(program: string): string | null {
  const real = resolveProgram(program);
  return real ? builtVersion(dirname(real)) : null;
}

export function installMethod(program: string): InstallMethod {
  return installMethodOf(resolveProgram(program) ?? program);
}
