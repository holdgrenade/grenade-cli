/**
 * Pure: what a clip's file is (PROTOCOL.md "Showreel"). The kind and media type a file's name says, a picture's size
 * from its first bytes, what the media tools print, and the names a clip gets on disk. No I/O, no clock.
 */
import { CLIP_KIND_STILL, CLIP_KIND_VIDEO } from "@grenade/protocol";

/** A clip as the owner's `grenade clip` sends it to the daemon, with the file still where the agent wrote it. */
export interface ClipInput {
  path: string;
  title: string;
  line?: string | undefined;
  before?: boolean | undefined;
  session?: string | undefined;
}

export interface ClipMedia {
  kind: typeof CLIP_KIND_VIDEO | typeof CLIP_KIND_STILL;
  /** What the daemon keeps it as: a video is re-encoded to MP4, a picture stays what it is. */
  mime: "video/mp4" | "image/png" | "image/jpeg";
  extension: ".mp4" | ".png" | ".jpg";
  /** A recording to encode, as against a picture to copy. */
  video: boolean;
}

const VIDEO_EXTENSIONS = new Set([".mov", ".mp4", ".m4v", ".webm", ".mkv", ".avi", ".gif"]);

/** What a file is by its extension, or null for one the daemon does not keep. The reason is a sentence for the owner. */
export function clipMediaOf(path: string): ClipMedia | { refused: string } {
  const ext = extensionOf(path);
  if (ext === ".png") return { kind: CLIP_KIND_STILL, mime: "image/png", extension: ".png", video: false };
  if (ext === ".jpg" || ext === ".jpeg") return { kind: CLIP_KIND_STILL, mime: "image/jpeg", extension: ".jpg", video: false };
  if (VIDEO_EXTENSIONS.has(ext)) return { kind: CLIP_KIND_VIDEO, mime: "video/mp4", extension: ".mp4", video: true };
  return { refused: `A clip is a recording (.mov, .mp4, .m4v, .webm, .gif) or a picture (.png, .jpg)${ext ? `, not ${ext}` : ""}.` };
}

export function extensionOf(path: string): string {
  const base = path.split("/").pop() ?? "";
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot).toLowerCase() : "";
}

/** The size of a PNG or JPEG from its first bytes, or null when they are not one. */
export function imageSizeOf(head: Uint8Array): { width: number; height: number } | null {
  return pngSize(head) ?? jpegSize(head);
}

function pngSize(b: Uint8Array): { width: number; height: number } | null {
  if (b.length < 24) return null;
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (!sig.every((v, i) => b[i] === v)) return null;
  // The IHDR chunk follows the signature: length, "IHDR", width, height.
  if (String.fromCharCode(b[12]!, b[13]!, b[14]!, b[15]!) !== "IHDR") return null;
  const width = readUint32(b, 16);
  const height = readUint32(b, 20);
  return width > 0 && height > 0 ? { width, height } : null;
}

function jpegSize(b: Uint8Array): { width: number; height: number } | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) {
      i++;
      continue;
    }
    const marker = b[i + 1]!;
    // A start-of-frame marker (baseline, progressive and the rest) carries the height and width.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      const height = (b[i + 5]! << 8) | b[i + 6]!;
      const width = (b[i + 7]! << 8) | b[i + 8]!;
      return width > 0 && height > 0 ? { width, height } : null;
    }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01 || marker === 0xff) {
      i += marker === 0xff ? 1 : 2;
      continue;
    }
    const length = (b[i + 2]! << 8) | b[i + 3]!;
    if (length < 2) return null;
    i += 2 + length;
  }
  return null;
}

function readUint32(b: Uint8Array, at: number): number {
  return ((b[at]! << 24) >>> 0) + (b[at + 1]! << 16) + (b[at + 2]! << 8) + b[at + 3]!;
}

export interface MediaProbe {
  seconds?: number;
  width?: number;
  height?: number;
}

/** What `mdls -name kMediaDurationSeconds -name kMediaPixelWidth -name kMediaPixelHeight` printed (a Mac), as numbers. */
export function parseMdls(output: string): MediaProbe {
  const probe: MediaProbe = {};
  for (const line of output.split("\n")) {
    const m = /^(\w+)\s*=\s*(.+)$/.exec(line.trim());
    if (!m) continue;
    const value = Number(m[2]);
    if (!Number.isFinite(value) || value <= 0) continue;
    if (m[1] === "kMediaDurationSeconds") probe.seconds = round1(value);
    if (m[1] === "kMediaPixelWidth") probe.width = Math.round(value);
    if (m[1] === "kMediaPixelHeight") probe.height = Math.round(value);
  }
  return probe;
}

/** What `ffprobe -show_streams -show_format -of json` printed: the first video stream's size and the format's duration. */
export function parseFfprobe(json: string): MediaProbe {
  const probe: MediaProbe = {};
  try {
    const parsed = JSON.parse(json) as { streams?: { codec_type?: string; width?: number; height?: number; duration?: string }[]; format?: { duration?: string } };
    const video = parsed.streams?.find((s) => s.codec_type === "video");
    if (video?.width && video.height) {
      probe.width = video.width;
      probe.height = video.height;
    }
    const seconds = Number(parsed.format?.duration ?? video?.duration);
    if (Number.isFinite(seconds) && seconds > 0) probe.seconds = round1(seconds);
  } catch {
    // not ffprobe's JSON: no probe
  }
  return probe;
}

/**
 * An MP4's length and picture size from its `moov` box, which a fast-start file (what the encoders write) puts first:
 * the video track's `tkhd` (width and height, 16.16 fixed) and `mdhd` (duration over its timescale), else the movie's
 * `mvhd`. Empty when the bytes are not an MP4 or hold no `moov`. Spotlight's `mdls` knows nothing of a file this new.
 */
export function mp4InfoOf(head: Uint8Array): MediaProbe {
  const probe: MediaProbe = {};
  const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
  const type = (at: number) => String.fromCharCode(head[at]!, head[at + 1]!, head[at + 2]!, head[at + 3]!);
  let movieSeconds: number | undefined;
  const walk = (from: number, to: number, depth: number): void => {
    let at = from;
    while (at + 8 <= to) {
      let size = view.getUint32(at);
      let header = 8;
      if (size === 1 && at + 16 <= to) {
        size = Number(view.getBigUint64(at + 8));
        header = 16;
      }
      if (size === 0) size = to - at;
      if (size < header || at + size > to) return;
      const box = type(at + 4);
      if ((box === "moov" || box === "trak" || box === "mdia") && depth < 3) walk(at + header, at + size, depth + 1);
      else if (box === "mvhd" && at + 28 <= to) {
        const version = head[at + 8];
        const [timescale, duration] = version === 1 && at + 40 <= to ? [view.getUint32(at + 28), Number(view.getBigUint64(at + 32))] : [view.getUint32(at + 20), view.getUint32(at + 24)];
        if (timescale > 0 && duration > 0) movieSeconds = duration / timescale;
      } else if (box === "tkhd" && at + size <= to && size >= 16) {
        const width = view.getUint32(at + size - 8) / 65536;
        const height = view.getUint32(at + size - 4) / 65536;
        if (width > 0 && height > 0 && probe.width === undefined) {
          probe.width = Math.round(width);
          probe.height = Math.round(height);
          delete probe.seconds;
          trackWanted = true;
        }
      } else if (box === "mdhd" && trackWanted && at + 24 <= to) {
        const version = head[at + 8];
        const [timescale, duration] = version === 1 && at + 36 <= to ? [view.getUint32(at + 28), Number(view.getBigUint64(at + 32))] : [view.getUint32(at + 20), view.getUint32(at + 24)];
        if (timescale > 0 && duration > 0) probe.seconds = round1(duration / timescale);
        trackWanted = false;
      }
      at += size;
    }
  };
  let trackWanted = false;
  walk(0, head.length, 0);
  if (probe.seconds === undefined && movieSeconds !== undefined) probe.seconds = round1(movieSeconds);
  if (probe.seconds === undefined) delete probe.seconds;
  return probe;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** A clip's id: `c-` and eight letters or digits from the random bytes given. */
export function clipIdFrom(random: Uint8Array): string {
  const alphabet = "abcdefghijkmnpqrstuvwxyz23456789";
  let id = "c-";
  for (let i = 0; i < 8; i++) id += alphabet[(random[i] ?? 0) % alphabet.length];
  return id;
}

/** The day a clip belongs to, in this computer's own calendar: "2026-10-09". */
export function clipDate(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** The day a clip's `at` belongs to, in this computer's calendar. */
export function dateOfAt(at: string): string {
  return clipDate(new Date(at));
}

/** Is `date` more than `days` days before `today`, so its clips may go? Both "YYYY-MM-DD". */
export function olderThan(date: string, today: string, days: number): boolean {
  const a = Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)));
  const b = Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)) - 1, Number(today.slice(8, 10)));
  return Number.isFinite(a) && Number.isFinite(b) && b - a > days * 86_400_000;
}

/** A title or a line as the daemon keeps it: one line, whitespace folded, cut with an ellipsis. */
export function foldText(text: string, max: number): string {
  const line = text.replace(/\s+/g, " ").trim();
  const chars = [...line];
  return chars.length <= max ? line : chars.slice(0, max - 1).join("") + "…";
}
