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

/** The command is `<package>/dist/cli.js` in every layout (release tarball and `tsc` build), so package.json is one up. */
export function installedVersion(program: string): string | null {
  const real = resolveProgram(program);
  if (!real) return null;
  try {
    const pkg = JSON.parse(readFileSync(join(dirname(dirname(real)), "package.json"), "utf8")) as { version?: unknown };
    return typeof pkg.version === "string" ? pkg.version : null;
  } catch {
    return null;
  }
}

export function installMethod(program: string): InstallMethod {
  return installMethodOf(resolveProgram(program) ?? program);
}
