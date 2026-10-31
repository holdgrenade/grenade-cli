/**
 * Moves a group's canvas folder to another project (PROTOCOL.md "Canvas", "Moving a group's canvases";
 * `group.canvasCwd`): `<from>/.grenade/canvas/<group>/`, every canvas in it, to `<to>/.grenade/canvas/<group>/`. The only
 * place the daemon writes in a canvas folder. It follows no symbolic link at either end and never moves over what is
 * there. The `shared` boards, directly in `.grenade/canvas`, stay: they are the folder's, not the group's.
 */
import { cp, lstat, mkdir, rename, rm, stat } from "node:fs/promises";
import { posix } from "node:path";
import { CANVAS_FOLDER } from "@grenade/protocol";
import { groupFolderOf } from "./canvasAccess.js";

/** Why a group's canvases cannot move; `message` is a sentence for the user. */
export class CanvasMoveError extends Error {}

/** What a folder is: not there, a real folder, or something else (a link, a file). */
async function kindOf(path: string): Promise<"none" | "folder" | "other"> {
  const st = await lstat(path).catch((e: NodeJS.ErrnoException) => {
    if (e.code === "ENOENT" || e.code === "ENOTDIR") return null;
    throw e;
  });
  if (!st) return "none";
  return st.isDirectory() && !st.isSymbolicLink() ? "folder" : "other";
}

/** `.grenade`, `.grenade/canvas` and the group's folder under `cwd`, outermost first. */
export function canvasFoldersOf(cwd: string, group: string): string[] {
  const grenade = posix.join(cwd, posix.dirname(CANVAS_FOLDER));
  return [grenade, posix.join(cwd, CANVAS_FOLDER), groupFolderOf(cwd, group)];
}

/**
 * Moves `group`'s folder from the project `from` to the project `to` (both normalized, absolute). Returns whether a
 * folder moved (false: the group had none yet, and only its `canvasCwd` changes). Throws `CanvasMoveError`.
 */
export async function moveGroupCanvases(from: string, to: string, group: string): Promise<boolean> {
  const project = await stat(to).catch(() => null);
  if (!project?.isDirectory()) throw new CanvasMoveError(`${to} is not a folder on this computer.`);
  const source = canvasFoldersOf(from, group);
  const target = canvasFoldersOf(to, group);
  let moves = true;
  for (const folder of source) {
    const kind = await kindOf(folder);
    if (kind === "other") throw new CanvasMoveError(`${folder} is not a folder of its own, so its canvases are not moved.`);
    if (kind === "none") moves = false;
    if (!moves) break;
  }
  for (const folder of target.slice(0, 2)) {
    if ((await kindOf(folder)) === "other") throw new CanvasMoveError(`${folder} is not a folder of its own, so canvases are not moved into it.`);
  }
  const [, canvasFolder, groupFolder] = target as [string, string, string];
  if ((await kindOf(groupFolder)) !== "none") throw new CanvasMoveError(`${to} already has canvases of this group's, so nothing was moved.`);
  if (!moves) return false;
  await mkdir(canvasFolder, { recursive: true });
  const old = source[2] as string;
  try {
    await rename(old, groupFolder);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EXDEV") throw e;
    // Another disk: copy, then remove the old folder once the copy is whole.
    await cp(old, groupFolder, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true });
    await rm(old, { recursive: true });
  }
  return true;
}
