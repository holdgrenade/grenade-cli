/**
 * The other files of a canvas folder that may go up beside its boards (PROTOCOL.md "Publishing"): pictures, fonts,
 * stylesheets a board names. Never follows a symbolic link, never reads anything that is not a regular file directly
 * in the folder, never a file over the host's cap.
 */
import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { join } from "node:path";
import { SHARE_ASSET_MAX_BYTES } from "@grenade/protocol";
import { isAssetName } from "./publishPlan.js";

export interface AssetFile {
  name: string;
  bytes: number;
  mtimeMs: number;
}

/** The files in `folder` that may go up: regular, not hidden, not a page, at most 5 MiB. None when it is not there. */
export async function assetFiles(folder: string): Promise<AssetFile[]> {
  const entries = await readdir(folder, { withFileTypes: true }).catch(() => []);
  const files: AssetFile[] = [];
  for (const e of entries) {
    if (!e.isFile() || !isAssetName(e.name)) continue;
    const st = await lstat(join(folder, e.name)).catch(() => null);
    if (!st?.isFile() || st.size > SHARE_ASSET_MAX_BYTES) continue;
    files.push({ name: e.name, bytes: st.size, mtimeMs: st.mtimeMs });
  }
  return files;
}

/** One such file's bytes, at most 5 MiB, or null when it is no longer a regular file there. */
export async function readAsset(folder: string, name: string): Promise<Buffer | null> {
  if (!isAssetName(name)) return null;
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
