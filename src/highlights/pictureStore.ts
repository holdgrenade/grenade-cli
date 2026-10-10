/**
 * The pictures the daemon keeps for highlights (PROTOCOL.md "Highlights"): a copy of each screenshot the agent took and
 * each picture the owner sent, as a JPEG of at most `HIGHLIGHT_IMAGE_MAX_SIDE` pixels on its longest side, under
 * `<GRENADE_HOME>/highlights/` (folder 0700, files 0600), beside a small `.json` with its size and when it was kept.
 * Resized with `sips` on a Mac and ImageMagick's `convert` where that is on PATH (Linux); with neither, no picture is
 * kept and the row has its boards and pushes only. Never overwrites: the same picture (same bytes) has the same id.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { HIGHLIGHT_IMAGE_MAX_BYTES, HIGHLIGHT_IMAGE_MAX_SIDE } from "@grenade/protocol";
import { findOnPath } from "../platform/findOnPath.js";

const run = promisify(execFile);

/** A source file larger than this is not copied: it is no screenshot. */
export const PICTURE_SOURCE_MAX_BYTES = 50 * 1024 * 1024;
/** JPEG quality of a kept copy. */
export const PICTURE_QUALITY = 80;
/** How long a kept picture stays before `prune` removes it. */
export const PICTURE_KEEP_DAYS = 30;

export interface KeptPicture {
  id: string;
  mime: string;
  width: number;
  height: number;
  bytes: number;
}

interface PictureMeta {
  mime: string;
  width: number;
  height: number;
  /** When it was made (the transcript's time), ISO. */
  at: string;
  /** When the copy was kept, ISO. */
  kept: string;
  session: string;
  bytes: number;
}

/** What resizes pictures on this computer, found once. */
export type Resizer = { kind: "sips" } | { kind: "convert"; bin: string } | null;

export function findResizer(platform: string = process.platform, onPath: (cmd: string) => string | null | undefined = findOnPath): Resizer {
  if (platform === "darwin") return { kind: "sips" };
  const convert = onPath("magick") ?? onPath("convert");
  return convert ? { kind: "convert", bin: convert } : null;
}

export class PictureStore {
  constructor(
    private readonly dir: string,
    private readonly resizer: Resizer = findResizer(),
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Whether this computer can keep pictures at all. */
  get canKeep(): boolean {
    return this.resizer !== null;
  }

  /** Keeps a copy of a picture file; null when it cannot (no resizer, not a readable picture, too large). */
  async keepFile(path: string, session: string, at: string): Promise<KeptPicture | null> {
    const st = await stat(path).catch(() => null);
    if (!st?.isFile() || st.size === 0 || st.size > PICTURE_SOURCE_MAX_BYTES) return null;
    const bytes = await readFile(path).catch(() => null);
    if (!bytes) return null;
    return this.keepBytes(bytes, session, at);
  }

  /** Keeps a copy of picture bytes (a base64 image a tool showed the agent, decoded); null when it cannot. */
  async keepBytes(bytes: Buffer, session: string, at: string): Promise<KeptPicture | null> {
    if (!this.resizer || bytes.length === 0 || bytes.length > PICTURE_SOURCE_MAX_BYTES) return null;
    const id = `h-${createHash("sha256").update(bytes).digest("hex").slice(0, 12)}`;
    const existing = await this.meta(id);
    if (existing) return { id, mime: existing.mime, width: existing.width, height: existing.height, bytes: existing.bytes };
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    await chmod(this.dir, 0o700).catch(() => {});
    const work = join(tmpdir(), `grenade-highlight-${process.pid}-${id}`);
    const source = `${work}.src`;
    const out = this.fileOf(id);
    try {
      await writeFile(source, bytes, { mode: 0o600 });
      const size = await this.resize(source, out);
      if (!size) return null;
      await chmod(out, 0o600).catch(() => {});
      const kept = await stat(out);
      if (kept.size > HIGHLIGHT_IMAGE_MAX_BYTES) {
        await rm(out, { force: true });
        return null;
      }
      const meta: PictureMeta = { mime: "image/jpeg", ...size, at, kept: this.now().toISOString(), session, bytes: kept.size };
      await writeFile(this.metaOf(id), JSON.stringify(meta), { mode: 0o600 });
      return { id, mime: meta.mime, width: meta.width, height: meta.height, bytes: meta.bytes };
    } catch {
      await rm(out, { force: true }).catch(() => {});
      return null;
    } finally {
      await rm(source, { force: true }).catch(() => {});
    }
  }

  /** A kept picture, for `highlight.image`; null when it is not here. */
  async read(id: string): Promise<(KeptPicture & { data: Buffer }) | null> {
    const meta = await this.meta(id);
    if (!meta) return null;
    const data = await readFile(this.fileOf(id)).catch(() => null);
    if (!data) return null;
    return { id, mime: meta.mime, width: meta.width, height: meta.height, bytes: data.length, data };
  }

  async remove(id: string): Promise<void> {
    await rm(this.fileOf(id), { force: true }).catch(() => {});
    await rm(this.metaOf(id), { force: true }).catch(() => {});
  }

  /** Removes copies kept longer than `days`. */
  async prune(days: number = PICTURE_KEEP_DAYS): Promise<number> {
    const names = await readdir(this.dir).catch(() => [] as string[]);
    const cutoff = this.now().getTime() - days * 86_400_000;
    let removed = 0;
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const id = name.slice(0, -5);
      const meta = await this.meta(id);
      if (meta && Date.parse(meta.kept) < cutoff) {
        await this.remove(id);
        removed++;
      }
    }
    return removed;
  }

  private fileOf(id: string): string {
    return join(this.dir, `${id}.jpg`);
  }

  private metaOf(id: string): string {
    return join(this.dir, `${id}.json`);
  }

  private async meta(id: string): Promise<PictureMeta | null> {
    if (!/^h-[a-f0-9]{12}$/.test(id)) return null;
    const text = await readFile(this.metaOf(id), "utf8").catch(() => null);
    if (!text) return null;
    try {
      const m = JSON.parse(text) as PictureMeta;
      return typeof m.width === "number" && typeof m.height === "number" && typeof m.mime === "string" ? m : null;
    } catch {
      return null;
    }
  }

  /** Writes `out` as a JPEG of at most the longest side; the size it came out at. */
  private async resize(source: string, out: string): Promise<{ width: number; height: number } | null> {
    if (!this.resizer) return null;
    if (this.resizer.kind === "sips") {
      // `-Z` scales up as well as down: only a picture larger than the longest side is shrunk.
      const before = await sipsSize(source);
      if (!before) return null;
      const shrink = Math.max(before.width, before.height) > HIGHLIGHT_IMAGE_MAX_SIDE ? ["-Z", String(HIGHLIGHT_IMAGE_MAX_SIDE)] : [];
      await run("/usr/bin/sips", ["-s", "format", "jpeg", "-s", "formatOptions", String(PICTURE_QUALITY), ...shrink, source, "--out", out], { timeout: 20_000 });
      return sipsSize(out);
    }
    const side = `${HIGHLIGHT_IMAGE_MAX_SIDE}x${HIGHLIGHT_IMAGE_MAX_SIDE}>`;
    await run(this.resizer.bin, [`${source}[0]`, "-auto-orient", "-resize", side, "-quality", String(PICTURE_QUALITY), `jpeg:${out}`], { timeout: 20_000 });
    const { stdout } = await run(this.resizer.bin, ["identify", "-format", "%w %h", out], { timeout: 10_000 }).catch(() => ({ stdout: "" }));
    const [w, h] = stdout.trim().split(/\s+/).map(Number);
    return w && h ? { width: w, height: h } : null;
  }
}

/** A picture's size as `sips` reads it, or null. */
async function sipsSize(path: string): Promise<{ width: number; height: number } | null> {
  const { stdout } = await run("/usr/bin/sips", ["-g", "pixelWidth", "-g", "pixelHeight", path], { timeout: 10_000 }).catch(() => ({ stdout: "" }));
  const width = Number(/pixelWidth:\s*(\d+)/.exec(stdout)?.[1]);
  const height = Number(/pixelHeight:\s*(\d+)/.exec(stdout)?.[1]);
  return width > 0 && height > 0 ? { width, height } : null;
}
