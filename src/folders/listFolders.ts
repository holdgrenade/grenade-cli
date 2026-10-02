import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { FOLDERS_MAX, type FoldersFrame } from "@grenade/protocol";

const finderOrder = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

/** `~` and `~/…` under `home`; anything else as it is. Pure. */
export function expandHome(path: string, home: string): string {
  if (path === "~") return home;
  return path.startsWith("~/") ? join(home, path.slice(2)) : path;
}

/** Folder names as a client shows them: hidden ones left out, sorted the way Finder sorts, at most `max`. Pure. */
export function shownFolders(names: string[], max = FOLDERS_MAX): { folders: string[]; truncated: boolean } {
  const sorted = names.filter((n) => !n.startsWith(".")).sort(finderOrder.compare);
  return { folders: sorted.slice(0, max), truncated: sorted.length > max };
}

/** The `folders` reply for `path` (PROTOCOL.md "Folders"): the folders directly inside it, links to folders included. */
export async function listFolders(path: string, home = homedir()): Promise<FoldersFrame> {
  const dir = expandHome(path, home);
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return { type: "folders", path, folders: [], missing: true };
  }
  const names: string[] = [];
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    if (e.isDirectory()) names.push(e.name);
    else if (e.isSymbolicLink()) {
      const target = await stat(join(dir, e.name)).catch(() => null);
      if (target?.isDirectory()) names.push(e.name);
    }
  }
  const { folders, truncated } = shownFolders(names);
  return { type: "folders", path, folders, ...(truncated ? { truncated: true as const } : {}) };
}
