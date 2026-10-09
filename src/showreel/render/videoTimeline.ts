/**
 * Pure: the cut of a showreel as a video (Canvas 2, R1A): what is on screen from millisecond to millisecond. Every
 * move lands on a half-second grid. The scenes: the open (the mark, the wordmark, the day), the opening sentence, a
 * wall of everything the day made, a chapter per piece (the sketches fan out, the clip comes forward, the title lands,
 * the done chip stamps), a montage of what is left, and the close. No count of anything is written on screen.
 * No I/O, no clock.
 */
import type { Clip, ShowreelFrame } from "@grenade/protocol";

/** A picture the video shows: a clip's file, or a board rendered to a picture. */
export interface VideoAsset {
  /** The id a scene names it by. */
  id: string;
  /** Where the page loads it from (a file URL). */
  url: string;
  kind: "video" | "still" | "board";
  /** A video's length in seconds, when known. */
  seconds?: number;
  /** A board's title, shown under its picture. */
  title?: string;
}

export type VideoScene =
  | { kind: "open"; from: number; to: number; day: string }
  | { kind: "sentence"; from: number; to: number; text: string }
  | { kind: "wall"; from: number; to: number; assets: string[]; word: string }
  | { kind: "chapter"; from: number; to: number; title: string; line?: string; boards: string[]; chosen?: string; before?: string; clip?: string; done?: string }
  | { kind: "montage"; from: number; to: number; assets: string[] }
  | { kind: "close"; from: number; to: number; day: string; assets: string[] };

/** A scene as `videoTimeline` adds it: its fields and its length, placed on the grid. */
type SceneSpec = { [K in VideoScene["kind"]]: Omit<Extract<VideoScene, { kind: K }>, "from" | "to"> & { ms: number } }[VideoScene["kind"]];

export interface VideoTimeline {
  /** The whole video, in milliseconds, a multiple of the grid. */
  duration: number;
  scenes: VideoScene[];
}

/** The grid every cut lands on. */
export const GRID_MS = 500;
export const OPEN_MS = 2000;
export const SENTENCE_MS = 2000;
export const WALL_MS = 2000;
export const CHAPTER_MS = 2500;
/** With more pieces than this, chapters tighten. */
export const CHAPTERS_LONG_MAX = 6;
export const CHAPTER_SHORT_MS = 1500;
export const MONTAGE_MS = 1500;
export const CLOSE_MS = 1500;
/** The wall and the montage show at most this many pictures. */
export const WALL_MAX = 24;
export const MONTAGE_MAX = 12;

export interface TimelineInput {
  frame: Pick<ShowreelFrame, "date" | "opening" | "pieces" | "clips">;
  /** Every asset the page may show, by id: the frame's clips and the day's boards (as pictures). */
  assets: readonly VideoAsset[];
  /** Each part's board picture: the asset id for a board file name. */
  boardAsset: (file: string) => string | undefined;
  /** The boards drawn beside a chosen one, by file name: its revision's siblings, oldest first. */
  siblingsOf: (file: string) => string[];
  /** The day as the video writes it: "Friday 9 October". */
  day: string;
}

/** The cut. Pure. */
export function videoTimeline(input: TimelineInput): VideoTimeline {
  const assetIds = new Set(input.assets.map((a) => a.id));
  const has = (id: string | undefined): id is string => !!id && assetIds.has(id);
  const scenes: VideoScene[] = [];
  let t = 0;
  const add = (scene: SceneSpec): void => {
    const { ms, ...rest } = scene;
    scenes.push({ ...rest, from: t, to: t + ms } as VideoScene);
    t += ms;
  };

  add({ kind: "open", ms: OPEN_MS, day: input.day });
  if (input.frame.opening) add({ kind: "sentence", ms: SENTENCE_MS, text: input.frame.opening });

  // The wall: every clip and board of the day, dimmed, so nothing is chosen for it.
  const wall = input.assets.map((a) => a.id).slice(0, WALL_MAX);
  if (wall.length > 0) add({ kind: "wall", ms: WALL_MS, assets: wall, word: "Today." });

  const chapterMs = input.frame.pieces.length > CHAPTERS_LONG_MAX ? CHAPTER_SHORT_MS : CHAPTER_MS;
  const shown = new Set<string>();
  for (const piece of input.frame.pieces) {
    for (const part of piece.parts) {
      const clip = part.clips.find(has);
      const chosen = part.board ? input.boardAsset(part.board.file) : undefined;
      const siblings = part.board ? input.siblingsOf(part.board.file).map(input.boardAsset).filter(has) : [];
      const boards = [...new Set([...siblings, ...(has(chosen) ? [chosen] : [])])];
      if (!clip && boards.length === 0) continue;
      for (const id of [clip, part.before, ...boards]) if (has(id)) shown.add(id);
      add({
        kind: "chapter",
        ms: chapterMs,
        title: piece.parts.length > 1 && part.title ? part.title : piece.title,
        ...(piece.line ? { line: piece.line } : {}),
        boards,
        ...(has(chosen) ? { chosen } : {}),
        ...(has(part.before) ? { before: part.before } : {}),
        ...(clip ? { clip } : {}),
        ...(part.done ? { done: part.done.text } : {}),
      });
    }
  }

  const left = input.assets.map((a) => a.id).filter((id) => !shown.has(id)).slice(0, MONTAGE_MAX);
  if (left.length >= 4) add({ kind: "montage", ms: MONTAGE_MS, assets: left });
  add({ kind: "close", ms: CLOSE_MS, day: input.day, assets: wall });

  return { duration: Math.ceil(t / GRID_MS) * GRID_MS, scenes };
}

/** The day as the video writes it, in the computer's own words: "Friday 9 October". Pure. */
export function videoDay(date: string, locale = "en-GB"): string {
  const [y, m, d] = date.split("-").map(Number);
  const at = new Date(y!, m! - 1, d!);
  return new Intl.DateTimeFormat(locale, { weekday: "long", day: "numeric", month: "long" }).format(at);
}

/** The clips of a frame as assets, each at the path given. Pure. */
export function clipAssets(clips: readonly Clip[], urlOf: (clip: Clip) => string): VideoAsset[] {
  return clips.map((c) => ({ id: c.id, url: urlOf(c), kind: c.kind === "video" ? "video" : "still", ...(c.seconds !== undefined ? { seconds: c.seconds } : {}) }));
}
