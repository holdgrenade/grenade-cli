/**
 * The other files of a canvas folder that may go up beside its boards (PROTOCOL.md "Publishing"): pictures, fonts,
 * stylesheets a board names, directly in the folder or in a subfolder (`fonts/icons.woff2`). Never follows a symbolic
 * link, never reads anything that is not a regular file under the folder, never a file over the host's cap.
 */
import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { join } from "node:path";
import { SHARE_ASSET_DEPTH_MAX, SHARE_ASSET_MAX_BYTES } from "@grenade/protocol";
import { isAssetName } from "./publishPlan.js";

export interface AssetFile {
  /** Its path in the folder, folders joined by `/`. */
  name: string;
  bytes: number;
  mtimeMs: number;
}

/** How many entries a walk looks at, so a folder with a big tree under it costs no more than this. */
const WALK_MAX = 2000;

/** The files under `folder` that may go up: regular, none hidden, not a page, at most 5 MiB. None when it is not there. */
export async function assetFiles(folder: string): Promise<AssetFile[]> {
  const files: AssetFile[] = [];
  let seen = 0;
  const walk = async (dir: string, prefix: string, depth: number): Promise<void> => {
    const entries = await readdir(join(folder, dir), { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (++seen > WALK_MAX) return;
      const name = prefix + e.name;
      if (e.isDirectory()) {
        if (depth < SHARE_ASSET_DEPTH_MAX && !e.name.startsWith(".")) await walk(name, name + "/", depth + 1);
        continue;
      }
      if (!e.isFile() || !isAssetName(name)) continue;
      const st = await lstat(join(folder, name)).catch(() => null);
      if (!st?.isFile() || st.size > SHARE_ASSET_MAX_BYTES) continue;
      files.push({ name, bytes: st.size, mtimeMs: st.mtimeMs });
    }
  };
  await walk("", "", 0);
  return files;
}

/** One such file's bytes, at most 5 MiB, or null when it is no longer a regular file there under real folders. */
export async function readAsset(folder: string, name: string): Promise<Buffer | null> {
  if (!isAssetName(name)) return null;
  // O_NOFOLLOW guards the file itself; each folder on the way is checked to be a folder, not a link out of the canvas.
  const dirs = name.split("/").slice(0, -1);
  for (let i = 1; i <= dirs.length; i++) {
    const st = await lstat(join(folder, ...dirs.slice(0, i))).catch(() => null);
    if (!st?.isDirectory()) return null;
  }
  const handle = await open(join(folder, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(() => null);
  if (!handle) return null;
  try {
    const st = await handle.stat();
    if (!st.isFile() || st.size > SHARE_ASSET_MAX_BYTES) return null;
    const buffer = Buffer.alloc(st.size);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}
