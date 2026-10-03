/**
 * Where a command is on PATH, as `which` would say, without running `which`: it is not installed on every Linux.
 * The first entry of `pathEnv` that holds an executable file of that name wins.
 */
import { accessSync, constants, statSync } from "node:fs";
import { join } from "node:path";

export function findOnPath(command: string, pathEnv: string | undefined = process.env["PATH"], isExecutable: (file: string) => boolean = executableFile): string | null {
  for (const dir of (pathEnv ?? "").split(":")) {
    if (!dir.startsWith("/")) continue;
    const file = join(dir, command);
    if (isExecutable(file)) return file;
  }
  return null;
}

function executableFile(file: string): boolean {
  try {
    if (!statSync(file).isFile()) return false;
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
