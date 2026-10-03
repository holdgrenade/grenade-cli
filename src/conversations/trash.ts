/**
 * Moves files to the Trash, so they can be put back until it is emptied. Used for a conversation the user deletes
 * (PROTOCOL.md "Conversations"). On macOS the system's `/usr/bin/trash` (macOS 15+) does it and Finder puts them
 * back; on Linux `linuxTrash.ts` does, into the trash the file manager shows.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { moveToLinuxTrash } from "./linuxTrash.js";

const run = promisify(execFile);
const TRASH = "/usr/bin/trash";

/** Moves `paths` to the Trash; throws when any could not be moved. */
export async function moveToTrash(paths: string[], platform: string = process.platform): Promise<void> {
  if (paths.length === 0) return;
  if (platform !== "darwin") return moveToLinuxTrash(paths);
  await run(TRASH, ["--stopOnError", ...paths], { timeout: 15_000 });
}
