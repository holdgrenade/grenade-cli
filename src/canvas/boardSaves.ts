/**
 * Whose boards they are (PROTOCOL.md "The canvas card", "Whose boards"): which board files a hook says the agent wrote,
 * which boards a turn saved, and the `canvas` activity entries a turn ends with. Pure: `canvasWork.ts` reads the
 * folders and keeps the record.
 *
 * - A hook names a board: Claude Code's `PostToolUse` of `Write`, `Edit` or `MultiEdit` (`file_path`), Codex's of
 *   `apply_patch` (the files its patch adds, updates or moves to, relative to the hook's `cwd`).
 * - A board is a `.html`/`.htm` file directly in `<folder>/.grenade/canvas/<group>/canvas-<n>/`, or directly in
 *   `<folder>/.grenade/canvas/` (the `shared` canvas).
 * - A board saved during the turn that no hook named (a script the agent ran) is the session's only when no other
 *   session of its group worked during the turn; else it is nobody's.
 */
import { posix } from "node:path";
import { CANVAS_CARD_BOARDS_MAX, CANVAS_FOLDER, CANVAS_SHARED, CanvasGroup, canvasCardText, canvasNumberOf, type ActivityEntry, type CanvasCardBoard } from "@grenade/protocol";
import { isBoardFile } from "./boardListing.js";

/** Save times on disk and the clocks of hooks may differ a little. */
export const SAVE_SLACK_MS = 3_000;

/** Where a board file is: the folder whose `.grenade/canvas` holds it, its group (null for `shared`), canvas and name. */
export interface BoardPlace {
  root: string;
  group: string | null;
  canvas: string;
  file: string;
}

/** A board's place, from an absolute path; null for any file that is not a board directly in a canvas. */
export function boardPlaceOf(path: string): BoardPlace | null {
  if (!path.startsWith("/")) return null;
  const parts = posix.normalize(path).split("/");
  const [dot, canvasDir] = CANVAS_FOLDER.split("/");
  for (let i = parts.length - 2; i >= 1; i--) {
    if (parts[i] !== dot || parts[i + 1] !== canvasDir) continue;
    const rest = parts.slice(i + 2);
    const root = parts.slice(0, i).join("/") || "/";
    if (rest.length === 1 && isBoardFile(rest[0]!)) return { root, group: null, canvas: CANVAS_SHARED, file: rest[0]! };
    if (rest.length === 3 && CanvasGroup.safeParse(rest[0]).success && canvasNumberOf(rest[1]!) !== null && isBoardFile(rest[2]!)) {
      return { root, group: rest[0]!, canvas: rest[1]!, file: rest[2]! };
    }
    return null;
  }
  return null;
}

/** The files a hook says the agent wrote, as absolute paths: only a `PostToolUse` of a tool that writes files. */
export function writtenPathsOf(event: unknown, toolName: unknown, toolInput: unknown, cwd: string | undefined): string[] {
  if (event !== "PostToolUse" || typeof toolName !== "string" || typeof toolInput !== "object" || toolInput === null) return [];
  const input = toolInput as Record<string, unknown>;
  const absolute = (p: string) => (p.startsWith("/") ? posix.normalize(p) : cwd?.startsWith("/") ? posix.resolve(cwd, p) : null);
  let paths: string[] = [];
  switch (toolName) {
    case "Write":
    case "Edit":
    case "MultiEdit":
      paths = typeof input.file_path === "string" ? [input.file_path] : [];
      break;
    case "apply_patch":
      paths = patchedFilesOf(textOf(input.input) ?? textOf(input.patch) ?? textOf(input.command) ?? "");
      break;
  }
  return paths.flatMap((p) => {
    const a = p.trim() ? absolute(p.trim()) : null;
    return a ? [a] : [];
  });
}

/** The files a Codex patch adds, updates or moves to, as written in it. */
export function patchedFilesOf(patch: string): string[] {
  const files: string[] = [];
  for (const line of patch.split("\n")) {
    const m = /^\*\*\* (?:Add File|Update File|Move to): (.+)$/.exec(line.trimEnd());
    if (m) files.push(m[1]!);
  }
  return files;
}

function textOf(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && value.every((v) => typeof v === "string")) return value.join("\n");
  return null;
}

/** A board on the session's group's canvases at the turn's end. */
export interface BoardOnDisk {
  path: string;
  canvas: string;
  file: string;
  mtimeMs: number;
  /** When the file was made, where the system says (0 when it does not). */
  birthtimeMs: number;
}

/** What the daemon noted of one turn. */
export interface TurnNotes {
  start: number;
  end: number;
  /** Each board path a hook named, with when it first did. */
  hooked: ReadonlyMap<string, number>;
  /** The boards there when the turn started, path → save time; null when the daemon did not see the turn start. */
  before: ReadonlyMap<string, number> | null;
}

/** A board the turn saved: where, when first, last saved, and whether the turn made it. */
export interface SavedBoard {
  path: string;
  canvas: string;
  file: string;
  firstAt: number;
  mtimeMs: number;
  new: boolean;
}

/**
 * The boards a turn saved, in the order first saved: those a hook named that are still there, then (only when the
 * daemon saw the turn start and no other session of the group worked during it) those saved in the turn that none named.
 */
export function boardsOfTurn(turn: TurnNotes, onDisk: readonly BoardOnDisk[], othersWorked: boolean): SavedBoard[] {
  const out: SavedBoard[] = [];
  for (const board of onDisk) {
    const hookedAt = turn.hooked.get(board.path);
    const isNew = turn.before ? !turn.before.has(board.path) : board.birthtimeMs > 0 && board.birthtimeMs >= turn.start - SAVE_SLACK_MS;
    if (hookedAt !== undefined) {
      out.push({ ...board, firstAt: Math.min(hookedAt, board.mtimeMs), new: isNew });
      continue;
    }
    if (!turn.before || othersWorked) continue;
    const changed = turn.before.get(board.path) !== board.mtimeMs;
    const inTurn = board.mtimeMs >= turn.start - SAVE_SLACK_MS && board.mtimeMs <= turn.end + SAVE_SLACK_MS;
    if (changed && inTurn) out.push({ ...board, firstAt: board.mtimeMs, new: isNew });
  }
  return out.sort((a, b) => a.firstAt - b.firstAt || a.path.localeCompare(b.path));
}

/** Whether any of these working spans (`to` null: still working) overlaps `from`…`to`. */
export function workedDuring(spans: readonly { from: number; to: number | null }[], from: number, to: number): boolean {
  return spans.some((s) => s.from <= to && (s.to === null || s.to >= from));
}

/** What a turn's entries need to know of each canvas besides its boards. */
export interface CanvasEntryContext {
  cwd: string;
  group: string;
  at: string;
  /** The canvas's name (`canvasNameOf`), by canvas id. */
  nameOf(canvas: string): string;
  /** The caption under a board (`canvasCardTitleOf`), by path. */
  titleOf(path: string): string;
}

/**
 * The `canvas` entries of a turn: one per canvas, in the order of each canvas's first save; its boards new first,
 * then changed, each in the order first saved, at most `CANVAS_CARD_BOARDS_MAX` (the ones saved last); the sentence
 * counts them all.
 */
export function canvasEntriesOf(saved: readonly SavedBoard[], c: CanvasEntryContext): ActivityEntry[] {
  const byCanvas = new Map<string, SavedBoard[]>();
  for (const b of [...saved].sort((a, b) => a.firstAt - b.firstAt)) byCanvas.set(b.canvas, [...(byCanvas.get(b.canvas) ?? []), b]);
  const entries: ActivityEntry[] = [];
  for (const [canvas, boards] of byCanvas) {
    const drew = boards.filter((b) => b.new).length;
    const kept = boards.slice(-CANVAS_CARD_BOARDS_MAX);
    const ordered = [...kept.filter((b) => b.new), ...kept.filter((b) => !b.new)];
    const name = c.nameOf(canvas);
    entries.push({
      kind: "canvas",
      text: canvasCardText(drew, boards.length - drew, name),
      at: c.at,
      cwd: c.cwd,
      group: c.group,
      canvas,
      name,
      boards: ordered.map((b): CanvasCardBoard => ({ file: b.file, title: c.titleOf(b.path), new: b.new })),
    });
  }
  return entries;
}
