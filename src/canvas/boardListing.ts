/**
 * The boards a canvas folder holds, as `canvas` lists them (PROTOCOL.md "Canvas"), and what a client is told when a
 * board is too large to send. Pure: `canvasFolder.ts` does the reading.
 */
import { boardNameOf, boardSizeOf, CANVAS_BOARD_FRAME_MAX_BYTES, CANVAS_BOARD_MAX_BYTES, CANVAS_BOARDS_MAX, CanvasFileName, type CanvasBoard } from "@grenade/protocol";

/** One file in the folder, as the disk has it. `head` is its first bytes, for the size it asks for. */
export interface BoardFile {
  file: string;
  mtimeMs: number;
  bytes: number;
  head: string;
}

const finderOrder = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

/** A name in the folder that is a board: a bare `.html`/`.htm` name that is not hidden. */
export function isBoardFile(name: string): boolean {
  return CanvasFileName.safeParse(name).success;
}

/** The boards, in Finder's order of their names, at most `max`. */
export function boardsFrom(files: BoardFile[], max = CANVAS_BOARDS_MAX): { boards: CanvasBoard[]; truncated: boolean } {
  const sorted = files.filter((f) => isBoardFile(f.file)).sort((a, b) => finderOrder.compare(a.file, b.file));
  const boards = sorted.slice(0, max).map((f): CanvasBoard => ({
    file: f.file,
    ...boardNameOf(f.file),
    ...boardSizeOf(f.head),
    modified: new Date(f.mtimeMs).toISOString(),
    bytes: f.bytes,
  }));
  return { boards, truncated: sorted.length > max };
}

/** What a watcher compares between two looks: every board's file, save time and size, and whether the folder is there. */
export function listingKey(listing: { boards: CanvasBoard[]; missing?: true }): string {
  if (listing.missing) return "missing";
  return listing.boards.map((b) => `${b.file}\n${b.modified}\n${b.bytes}`).join("\n\n");
}

/** Megabytes with one decimal, as a person reads them. */
function megabytes(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1);
}

/** The sentence for a board too large to send, or null when it fits: over 2 MiB on disk, or over the frame cap as JSON. */
export function boardTooLarge(file: string, fileBytes: number, frameBytes: number, computer = "Mac"): string | null {
  if (fileBytes <= CANVAS_BOARD_MAX_BYTES && frameBytes <= CANVAS_BOARD_FRAME_MAX_BYTES) return null;
  const name = file.replace(/\.html?$/i, "");
  return `"${name}" is too large to show here (${megabytes(Math.max(fileBytes, frameBytes))} MB; at most ${megabytes(CANVAS_BOARD_MAX_BYTES).replace(/\.0$/, "")} MB). Open it on the ${computer}.`;
}
