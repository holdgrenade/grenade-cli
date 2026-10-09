/**
 * The clips on disk (PROTOCOL.md "Showreel"): `<GRENADE_HOME>/clips/<date>/<id>.<mp4|png|jpg>` beside `<id>.json`, the
 * clip as the protocol's `Clip`, mode 0600 in folders of mode 0700, the day in this computer's own calendar. A clip
 * comes in as a file an agent wrote somewhere (`grenade clip`); a recording is re-encoded into the folder, a picture
 * copied. Clips older than `KEEP_DAYS` are removed. Nothing here is ever rewritten but the folder's listing.
 */
import { randomBytes } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, copyFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { CLIP_CHUNK_BYTES, CLIP_LINE_MAX, CLIP_MAX_BYTES, CLIP_TITLE_MAX, CLIPS_MAX, Clip } from "@grenade/protocol";
import { clipDate, clipIdFrom, clipMediaOf, foldText, imageSizeOf, mp4InfoOf, olderThan, type ClipInput } from "./clipFile.js";
import { systemMediaTools, type MediaTools } from "./media.js";

/** How long a clip is kept. */
export const KEEP_DAYS = 30;
/** A recording may be this large before it is re-encoded (512 MiB); the clip kept is at most `CLIP_MAX_BYTES`. */
export const SOURCE_MAX_BYTES = 512 * 1024 * 1024;

/** Why a file was not kept as a clip; `message` is a sentence for the owner. */
export class ClipError extends Error {}

export interface ClipChunk {
  data: Buffer;
  bytes: number;
  last: boolean;
}

export class ClipStore {
  constructor(
    private readonly dir: string,
    private readonly tools: MediaTools = systemMediaTools,
    private readonly now: () => Date = () => new Date(),
    private readonly random: (n: number) => Uint8Array = (n) => randomBytes(n),
  ) {}

  /** Keeps the file as a clip of today and returns it. Rejects with `ClipError`. */
  async add(input: ClipInput): Promise<Clip> {
    const media = clipMediaOf(input.path);
    if ("refused" in media) throw new ClipError(media.refused);
    const title = foldText(input.title, CLIP_TITLE_MAX);
    if (!title) throw new ClipError("A clip needs a title: what the feature is, in the product's words.");
    const st = existsSync(input.path) ? statSync(input.path) : null;
    if (!st?.isFile()) throw new ClipError(`${input.path} is not a file.`);
    if (st.size === 0) throw new ClipError(`${input.path} is empty.`);
    if (st.size > (media.video ? SOURCE_MAX_BYTES : CLIP_MAX_BYTES)) throw new ClipError(`${input.path} is too large for a clip.`);
    const at = this.now();
    const date = clipDate(at);
    const folder = this.folderOf(date);
    this.ensureFolder(folder);
    const id = this.newId(folder);
    const file = join(folder, `${id}${media.extension}`);
    let probe: { seconds?: number; width?: number; height?: number } = {};
    if (media.video) {
      const encoded = await this.tools.encode(input.path, file).catch((e: Error) => {
        throw new ClipError(`The recording could not be re-encoded: ${e.message.split("\n")[0]?.slice(0, 200)}`);
      });
      if (!encoded) {
        if (media.mime !== "video/mp4" || !/\.mp4$/i.test(input.path)) throw new ClipError("No video encoder on this computer: record as an .mp4, or install ffmpeg.");
        copyFileSync(input.path, file);
      }
      // The file's own header first (a fast-start MP4 says its size and length up front); the tools when it does not.
      probe = mp4InfoOf(headOf(file, 2 * 1024 * 1024));
      if (probe.width === undefined || probe.seconds === undefined) probe = { ...(await this.tools.probe(file)), ...probe };
    } else {
      copyFileSync(input.path, file);
      probe = imageSizeOf(headOf(file, 64 * 1024)) ?? {};
    }
    chmodSync(file, 0o600);
    const bytes = statSync(file).size;
    if (bytes > CLIP_MAX_BYTES) {
      rmSync(file, { force: true });
      throw new ClipError("The clip is too large even re-encoded: record a shorter one.");
    }
    const line = input.line ? foldText(input.line, CLIP_LINE_MAX) : "";
    const clip: Clip = {
      id,
      kind: media.kind,
      title,
      ...(line ? { line } : {}),
      ...(input.before ? { before: true as const } : {}),
      ...(input.session ? { session: input.session } : {}),
      at: at.toISOString(),
      mime: media.mime,
      bytes,
      ...(probe.seconds !== undefined && media.video ? { seconds: probe.seconds } : {}),
      ...(probe.width !== undefined ? { width: probe.width } : {}),
      ...(probe.height !== undefined ? { height: probe.height } : {}),
    };
    writeFileSync(join(folder, `${id}.json`), `${JSON.stringify(clip)}\n`, { mode: 0o600 });
    return clip;
  }

  /** A day's clips, oldest first, at most `CLIPS_MAX` (the newest). */
  list(date: string): Clip[] {
    const folder = this.folderOf(date);
    if (!existsSync(folder)) return [];
    const clips: Clip[] = [];
    for (const name of readdirSync(folder)) {
      if (!name.endsWith(".json")) continue;
      try {
        const parsed = Clip.safeParse(JSON.parse(readFileSync(join(folder, name), "utf8")));
        if (parsed.success && existsSync(this.fileOf(parsed.data))) clips.push(parsed.data);
      } catch {
        // a sidecar cut short: not a clip
      }
    }
    return clips.sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id)).slice(-CLIPS_MAX);
  }

  /** The days that have clips, oldest first. */
  dates(): string[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
  }

  /** A clip by id, whichever day it is of. */
  find(id: string): Clip | undefined {
    for (const date of this.dates().reverse()) {
      const file = join(this.folderOf(date), `${id}.json`);
      if (!existsSync(file)) continue;
      try {
        const parsed = Clip.safeParse(JSON.parse(readFileSync(file, "utf8")));
        if (parsed.success) return parsed.data;
      } catch {
        return undefined;
      }
    }
    return undefined;
  }

  /** The absolute path of a clip's file. */
  fileOf(clip: Clip): string {
    return join(this.folderOf(clipDate(new Date(clip.at))), `${clip.id}${extensionOf(clip.mime)}`);
  }

  /** Up to `CLIP_CHUNK_BYTES` of a clip's file from `from`; null for a clip not kept or a `from` past its end. */
  chunk(id: string, from: number): ClipChunk | null {
    const clip = this.find(id);
    if (!clip) return null;
    const path = this.fileOf(clip);
    if (!existsSync(path)) return null;
    const size = statSync(path).size;
    if (from >= size) return null;
    const length = Math.min(CLIP_CHUNK_BYTES, size - from);
    const data = Buffer.alloc(length);
    const fd = openSync(path, "r");
    try {
      let got = 0;
      while (got < length) {
        const n = readSync(fd, data, got, length - got, from + got);
        if (n === 0) break;
        got += n;
      }
      return { data: data.subarray(0, got), bytes: size, last: from + got >= size };
    } finally {
      closeSync(fd);
    }
  }

  /** Removes the days older than `KEEP_DAYS`. Returns the days removed. */
  prune(): string[] {
    const today = clipDate(this.now());
    const gone: string[] = [];
    for (const date of this.dates()) {
      if (!olderThan(date, today, KEEP_DAYS)) continue;
      rmSync(this.folderOf(date), { recursive: true, force: true });
      gone.push(date);
    }
    return gone;
  }

  private folderOf(date: string): string {
    return join(this.dir, date);
  }

  private ensureFolder(folder: string): void {
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    chmodSync(this.dir, 0o700);
    chmodSync(folder, 0o700);
  }

  private newId(folder: string): string {
    for (;;) {
      const id = clipIdFrom(this.random(8));
      if (!existsSync(join(folder, `${id}.json`))) return id;
    }
  }
}

/** The first `max` bytes of a file. */
function headOf(path: string, max: number): Buffer {
  const head = Buffer.alloc(max);
  const fd = openSync(path, "r");
  try {
    const read = readSync(fd, head, 0, head.length, 0);
    return head.subarray(0, read);
  } finally {
    closeSync(fd);
  }
}

function extensionOf(mime: string): string {
  return mime === "video/mp4" ? ".mp4" : mime === "image/jpeg" ? ".jpg" : ".png";
}
