/**
 * Renders a day's showreel to a video file (Canvas 2, R1B; `grenade showreel render`): the day's boards are rendered
 * to pictures, the motion page is written beside the clips, headless Chrome steps it frame by frame, and ffmpeg
 * encodes the frames into an H.264 MP4 in the owner's Movies folder. Nothing leaves the computer. Needs a Chrome and
 * an ffmpeg on this computer; says so in a sentence when one is missing.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, platform, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { CANVAS_SHARED, boardNameOf, type Clip, type ShowreelFrame } from "@grenade/protocol";
import { findOnPath } from "../../platform/findOnPath.js";
import { groupCanvasFolderOf } from "../../canvas/canvasAccess.js";
import type { DayBoard } from "../showreelCut.js";
import { ChromeError, ChromePage, resolveChrome } from "./chromePage.js";
import { videoPageHtml } from "./videoPage.js";
import { clipAssets, videoDay, videoTimeline, type VideoAsset } from "./videoTimeline.js";

export class RenderError extends Error {}

export interface RenderOptions {
  /** Portrait (1080 × 1920) for a phone; else 1920 × 1080. */
  portrait?: boolean;
  fps?: number;
  /** Where the file goes; the Movies folder when absent. */
  out?: string;
  /** The mark's picture, when the daemon ships one. */
  markPath?: string;
  /** How many of the day's boards the wall may show. */
  boardsMax?: number;
}

export interface RenderInput {
  frame: ShowreelFrame;
  /** Each clip's file on disk. */
  clipPath: (clip: Clip) => string;
  /** The boards saved that day. */
  boards: readonly DayBoard[];
  log?: (line: string) => void;
}

export interface Rendered {
  path: string;
  seconds: number;
  width: number;
  height: number;
  frames: number;
}

export function ffmpegBin(): string | null {
  return findOnPath("ffmpeg") ?? ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg"].find((c) => existsSync(c)) ?? null;
}

/** Where a rendered showreel goes: the Movies folder on a Mac, Videos on Linux. */
export function renderFolder(): string {
  return join(homedir(), platform() === "darwin" ? "Movies" : "Videos", "Grenade Showreels");
}

export async function renderVideo(input: RenderInput, options: RenderOptions = {}): Promise<Rendered> {
  const chrome = resolveChrome();
  if (!chrome) throw new RenderError("No Chrome on this computer: install Google Chrome or Chromium (or set GRENADE_CHROME) to render a showreel.");
  const ffmpeg = ffmpegBin();
  if (!ffmpeg) throw new RenderError("No ffmpeg on this computer: install it (brew install ffmpeg) to render a showreel.");
  if (input.frame.pieces.length === 0) throw new RenderError(`Nothing to render for ${input.frame.date}: no clips yet.`);
  const width = options.portrait ? 1080 : 1920;
  const height = options.portrait ? 1920 : 1080;
  const fps = options.fps ?? 30;
  const log = input.log ?? (() => {});
  const work = mkdtempSync(join(tmpdir(), "showreel-render-"));
  const chrome1 = await ChromePage.open(chrome, 1280, 800, join(work, "profile"));
  try {
    // The boards as pictures: the part's own and its revision's siblings, then the rest of the day for the wall.
    const assets: VideoAsset[] = clipAssets(input.frame.clips, (c) => pathToFileURL(input.clipPath(c)).href);
    const wanted = boardsWanted(input.frame, input.boards, options.boardsMax ?? 24);
    const boardIds = new Map<string, string>();
    for (const [i, b] of wanted.entries()) {
      const folder = groupCanvasFolderOf(b.cwd, b.group ?? "", b.canvas ?? CANVAS_SHARED);
      const file = join(folder, b.file);
      if (!existsSync(file)) continue;
      const id = `b-${i}`;
      const png = join(work, `${id}.png`);
      try {
        await chrome1.navigate(pathToFileURL(file).href);
        await new Promise((r) => setTimeout(r, 400));
        writeFileSync(png, await chrome1.screenshot("png"));
        boardIds.set(b.file, id);
        assets.push({ id, url: pathToFileURL(png).href, kind: "board", title: boardNameOf(b.file).name });
        log(`rendered board ${b.file}`);
      } catch (e) {
        log(`could not render ${b.file}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    await chrome1.close();

    const timeline = videoTimeline({
      frame: input.frame,
      assets,
      boardAsset: (file) => boardIds.get(file),
      siblingsOf: (file) => siblingsOf(file, wanted.map((b) => b.file)),
      day: videoDay(input.frame.date),
    });
    const markUrl = options.markPath && existsSync(options.markPath) ? pathToFileURL(options.markPath).href : undefined;
    const page = join(work, "showreel.html");
    writeFileSync(page, videoPageHtml({ timeline, assets, width, height, markUrl }));

    const frames = Math.round((timeline.duration / 1000) * fps);
    const folder = options.out ? join(options.out, "..") : renderFolder();
    mkdirSync(folder, { recursive: true });
    const out = options.out ?? join(folder, `${input.frame.date}${options.portrait ? "-portrait" : ""}.mp4`);
    const encoder = spawn(ffmpeg, ["-y", "-loglevel", "error", "-f", "image2pipe", "-framerate", String(fps), "-i", "-", "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p", "-movflags", "+faststart", out], { stdio: ["pipe", "ignore", "pipe"] });
    let encoderError = "";
    encoder.stderr?.on("data", (d: Buffer) => (encoderError += d.toString()));
    const encoded = new Promise<void>((resolve, reject) => {
      encoder.on("close", (code) => (code === 0 ? resolve() : reject(new RenderError(`ffmpeg failed: ${encoderError.trim().slice(0, 300)}`))));
      encoder.on("error", (e) => reject(new RenderError(`ffmpeg could not start: ${e.message}`)));
    });

    const chrome2 = await ChromePage.open(chrome, width, height, join(work, "profile2"));
    try {
      await chrome2.navigate(pathToFileURL(page).href);
      await chrome2.evaluate<boolean>("window.__showreel.ready()");
      for (let i = 0; i < frames; i++) {
        const ms = Math.round((i / fps) * 1000);
        await chrome2.evaluate<number>(`window.__showreel.seek(${ms})`);
        const png = await chrome2.screenshot("png");
        if (!encoder.stdin.write(png)) await new Promise<void>((r) => encoder.stdin.once("drain", () => r()));
        if (i % fps === 0) log(`frame ${i} of ${frames}`);
      }
    } finally {
      await chrome2.close();
    }
    encoder.stdin.end();
    await encoded;
    return { path: out, seconds: timeline.duration / 1000, width, height, frames };
  } catch (e) {
    if (e instanceof ChromeError) throw new RenderError(e.message);
    throw e;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** The boards the video needs: each part's board and its revision's siblings first, then the rest of the day, at most `max`. Pure. */
export function boardsWanted(frame: Pick<ShowreelFrame, "pieces">, boards: readonly DayBoard[], max: number): DayBoard[] {
  const named = new Set(frame.pieces.flatMap((p) => p.parts.map((part) => part.board?.file)).filter((f): f is string => !!f));
  const revisions = new Set([...named].map((f) => boardNameOf(f).revision).filter((r): r is number => r !== undefined));
  const first = boards.filter((b) => named.has(b.file) || revisions.has(boardNameOf(b.file).revision ?? -1));
  const rest = boards.filter((b) => !first.includes(b));
  return [...first, ...rest].slice(0, max);
}

/** The other boards of a board's revision, as named: "R10A …", "R10B …" beside "R10C …". Pure. */
export function siblingsOf(file: string, files: readonly string[]): string[] {
  const revision = boardNameOf(file).revision;
  if (revision === undefined) return [];
  return files.filter((f) => f !== file && boardNameOf(f).revision === revision).sort();
}
