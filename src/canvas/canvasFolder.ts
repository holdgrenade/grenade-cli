/**
 * Reads a canvas folder (PROTOCOL.md "Canvas"): the boards it holds and one board's file, and a group's canvases. Never
 * writes, never follows a symbolic link: every folder from `.grenade` down (`.grenade/canvas`, a group's folder, a
 * canvas's) must be a real folder, a board a regular file opened with O_NOFOLLOW.
 */
import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { CANVAS_BOARD_MAX_BYTES, CANVAS_SHARED, CANVASES_MAX, canvasNameOf, canvasNumberOf, type CanvasBoard, type CanvasInfo } from "@grenade/protocol";
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

/** The folder and each one above it up to `.grenade` are real folders (false: one is not there yet). */
async function canvasThere(folder: string): Promise<boolean> {
  const parts = folder.split("/");
  const at = parts.lastIndexOf(".grenade");
  // A folder with no `.grenade` in it: only it and the one above it, as for `.grenade/canvas`.
  const from = at > 0 ? at + 1 : parts.length - 1;
  for (let end = from; end <= parts.length; end++) {
    if (!(await realFolder(parts.slice(0, end).join("/") || dirname(folder)))) return false;
  }
  return true;
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

/** The first 8 KiB of a board, as UTF-8 (what its `<title>` and size are read from); "" when it cannot be read. */
export async function readHead(folder: string, file: string): Promise<string> {
  if (!isBoardFile(file)) return "";
  const board = await openBoard(join(folder, file));
  if (!board) return "";
  try {
    return (await board.read(HEAD_BYTES)).toString("utf8");
  } finally {
    await board.close();
  }
}

/** What `canvases` says of one canvas: its name (`canvasNameOf`), how many boards, when the newest was saved. */
export async function canvasInfoOf(folder: string, canvas: string): Promise<CanvasInfo> {
  const { boards } = await listCanvas(folder);
  const first = boards[0];
  const head = first ? await readHead(folder, first.file) : "";
  const modified = boards.reduce<string | undefined>((latest, b) => (!latest || b.modified > latest ? b.modified : latest), undefined);
  return {
    canvas,
    name: canvasNameOf(canvas, first ? { file: first.file, head } : undefined),
    boards: boards.length,
    ...(modified ? { modified } : {}),
  };
}

/**
 * A group's canvases (PROTOCOL.md "Canvas", "Several canvases"): each real folder `canvas-<n>` directly in `groupFolder`,
 * by number, then `shared` (the boards directly in `sharedFolder`, `.grenade/canvas`) while it has a board. A group's
 * folder that is not there yet has none.
 */
export async function listCanvases(groupFolder: string, sharedFolder: string): Promise<CanvasInfo[]> {
  const canvases: CanvasInfo[] = [];
  if (await canvasThere(groupFolder)) {
    const entries = await readdir(groupFolder, { withFileTypes: true });
    // `isDirectory()` is false for a link, so a link is never a canvas.
    const ids = entries
      .filter((e) => e.isDirectory() && canvasNumberOf(e.name) !== null)
      .map((e) => e.name)
      .sort((a, b) => canvasNumberOf(a)! - canvasNumberOf(b)!)
      .slice(0, CANVASES_MAX - 1);
    for (const id of ids) canvases.push(await canvasInfoOf(join(groupFolder, id), id));
  }
  const shared = await canvasInfoOf(sharedFolder, CANVAS_SHARED).catch(() => null);
  if (shared && shared.boards > 0) canvases.push(shared);
  return canvases;
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
