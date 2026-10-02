/**
 * Whether the daemon installs a newer release by itself: `~/.grenade/update.json` `{ "auto": false }` turns it off
 * (`grenade update --auto off`); anything else, a missing file included, is on. Read at every check, so a change
 * needs no restart.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { ensureDir, paths } from "../config.js";

export function parseAuto(text: string | null): boolean {
  if (text === null) return true;
  try {
    return (JSON.parse(text) as { auto?: unknown }).auto !== false;
  } catch {
    return true;
  }
}

export function readAuto(file: string = paths.update): boolean {
  try {
    return parseAuto(readFileSync(file, "utf8"));
  } catch {
    return parseAuto(null);
  }
}

export function writeAuto(on: boolean, file: string = paths.update): void {
  ensureDir();
  writeFileSync(file, JSON.stringify({ auto: on }, null, 2) + "\n");
}
