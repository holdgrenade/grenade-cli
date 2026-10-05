/**
 * Reads a canvas folder (PROTOCOL.md "Canvas"): the boards it holds and one board's file. Never writes, never follows a
 * symbolic link: `.grenade` and `.grenade/canvas` must be real folders, a board a regular file opened with O_NOFOLLOW.
 */
import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { CANVAS_BOARD_MAX_BYTES, type CanvasBoard } from "@grenade/protocol";
import { boardsFrom, boardTooLarge, isBoardFile, type BoardFile } from "./boardListing.js";

/** How much of a board is read for the size it asks for, as the Mac app does. */
const HEAD_BYTES = 8192;

/** Why a canvas or a board cannot be served; `message` is a sentence for the user. */
export class CanvasError extends Error {}

export interface CanvasListing {
  boards: CanvasBoard[];
  missing?: true;
  truncated?: true;
}

/** What a board's first bytes said, kept while its save time and size stay the same, so a watcher reads each file once. */
export type HeadCache = Map<string, string>;

/** Is `path` a real folder? Null when it is not there; an error when it is something else (a link, a file). */
async function realFolder(path: string): Promise<boolean> {
  const st = await lstat(path).catch((e: NodeJS.ErrnoException) => {
    if (e.code === "ENOENT" || e.code === "ENOTDIR") return null;
    throw e;
  });
  if (!st) return false;
  if (st.isSymbolicLink() || !st.isDirectory()) throw new CanvasError(`${path} is not a folder of its own, so it is not served as a canvas.`);
  return true;
}

/** The canvas folder and the `.grenade` above it are real folders (false: not there yet). */
async function canvasThere(folder: string): Promise<boolean> {
  return (await realFolder(dirname(folder))) && (await realFolder(folder));
}

/** Reads up to `max` bytes of a regular file without following a link; null when it is not one. */
async function openBoard(path: string): Promise<{ read(max: number): Promise<Buffer>; size: number; mtimeMs: number; close(): Promise<void> } | null> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(() => null);
  if (!handle) return null;
  const st = await handle.stat();
  if (!st.isFile()) {
    await handle.close();
    return null;
  }
  return {
    size: st.size,
    mtimeMs: st.mtimeMs,
    async read(max) {
      const buffer = Buffer.alloc(Math.min(max, st.size));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      return buffer.subarray(0, bytesRead);
    },
    close: () => handle.close(),
  };
}

/** The boards in `folder`, in Finder's order. A folder that is not there is `missing`, not an error. */
export async function listCanvas(folder: string, heads: HeadCache = new Map()): Promise<CanvasListing> {
  if (!(await canvasThere(folder))) return { boards: [], missing: true };
  const entries = await readdir(folder, { withFileTypes: true });
  const files: BoardFile[] = [];
  const seen = new Set<string>();
  for (const e of entries) {
    // `isFile()` is false for a link, so a link is never a board.
    if (!e.isFile() || !isBoardFile(e.name)) continue;
    const st = await lstat(join(folder, e.name)).catch(() => null);
    if (!st?.isFile()) continue;
    const key = `${e.name}\n${st.mtimeMs}\n${st.size}`;
    seen.add(key);
    let head = heads.get(key);
    if (head === undefined) {
      const board = await openBoard(join(folder, e.name));
      if (!board) continue;
      try {
        head = (await board.read(HEAD_BYTES)).toString("utf8");
      } finally {
        await board.close();
      }
      heads.set(key, head);
    }
    files.push({ file: e.name, mtimeMs: st.mtimeMs, bytes: st.size, head });
  }
  for (const key of heads.keys()) if (!seen.has(key)) heads.delete(key);
  const { boards, truncated } = boardsFrom(files);
  return { boards, ...(truncated ? { truncated: true as const } : {}) };
}

/** One board's file as UTF-8 text. `CanvasError` when it is not a board here, or too large. */
export async function readBoard(folder: string, file: string, computer = "Mac"): Promise<{ html: string; modified: string; bytes: number }> {
  const notHere = new CanvasError(`"${file}" is not on this canvas.`);
  if (!isBoardFile(file) || !(await canvasThere(folder))) throw notHere;
  const board = await openBoard(join(folder, file));
  if (!board) throw notHere;
  try {
    const tooLarge = boardTooLarge(file, board.size, 0, computer);
    if (tooLarge) throw new CanvasError(tooLarge);
    // No more than the size it had when opened, so a board still being written never reads past the cap.
    const data = await board.read(CANVAS_BOARD_MAX_BYTES);
    return { html: data.toString("utf8"), modified: new Date(board.mtimeMs).toISOString(), bytes: data.length };
  } finally {
    await board.close();
  }
}
