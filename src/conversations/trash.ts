/**
 * Moves files to the macOS Trash with the system's `/usr/bin/trash` (macOS 15+), so they can be put back from
 * Finder until the Trash is emptied. Used for a conversation the user deletes (PROTOCOL.md "Conversations").
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const TRASH = "/usr/bin/trash";

/** Moves `paths` to the Trash; throws when any could not be moved. */
export async function moveToTrash(paths: string[]): Promise<void> {
  if (paths.length === 0) return;
  await run(TRASH, ["--stopOnError", ...paths], { timeout: 15_000 });
}
