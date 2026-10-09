/**
 * The media tools a clip goes through (PROTOCOL.md "Showreel"): a recording is re-encoded to an MP4 of at most
 * `CLIP_SECONDS_MAX` seconds at 720p with ffmpeg when it is on PATH, else with the Mac's own `avconvert`; its length
 * and size are read with ffprobe, else the Mac's `mdls`. Without any of them a video is kept as it came when it is an
 * MP4 already, and its length and size stay unknown. Every call is `execFile` with a timeout.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { platform } from "node:os";
import { CLIP_SECONDS_MAX } from "@grenade/protocol";
import { findOnPath } from "../platform/findOnPath.js";
import { parseFfprobe, parseMdls, type MediaProbe } from "./clipFile.js";

const ENCODE_TIMEOUT_MS = 120_000;
const PROBE_TIMEOUT_MS = 15_000;

export interface MediaTools {
  /** Writes `src` as an MP4 at `dst`, cut to `CLIP_SECONDS_MAX`; false when no encoder is on this computer. */
  encode(src: string, dst: string): Promise<boolean>;
  probe(path: string): Promise<MediaProbe>;
}

function run(file: string, args: string[], timeout: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => (error ? reject(error) : resolve(stdout)));
  });
}

function ffmpegBin(): string | null {
  return findOnPath("ffmpeg") ?? ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg"].find((c) => existsSync(c)) ?? null;
}

function ffprobeBin(): string | null {
  return findOnPath("ffprobe") ?? ["/opt/homebrew/bin/ffprobe", "/usr/local/bin/ffprobe"].find((c) => existsSync(c)) ?? null;
}

const AVCONVERT = "/usr/bin/avconvert";
const MDLS = "/usr/bin/mdls";

/** The tools this computer has. */
export const systemMediaTools: MediaTools = {
  async encode(src, dst) {
    const ffmpeg = ffmpegBin();
    if (ffmpeg) {
      await run(ffmpeg, ["-y", "-loglevel", "error", "-i", src, "-t", String(CLIP_SECONDS_MAX), "-vf", "scale='min(1280,iw)':-2", "-c:v", "libx264", "-preset", "fast", "-crf", "23", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-c:a", "aac", "-b:a", "96k", dst], ENCODE_TIMEOUT_MS);
      return true;
    }
    if (platform() === "darwin" && existsSync(AVCONVERT)) {
      await run(AVCONVERT, ["--source", src, "--output", dst, "--preset", "Preset1280x720", "--duration", String(CLIP_SECONDS_MAX), "--replace"], ENCODE_TIMEOUT_MS);
      return true;
    }
    return false;
  },
  async probe(path) {
    const ffprobe = ffprobeBin();
    try {
      if (ffprobe) return parseFfprobe(await run(ffprobe, ["-v", "error", "-show_streams", "-show_format", "-of", "json", path], PROBE_TIMEOUT_MS));
      if (platform() === "darwin" && existsSync(MDLS)) return parseMdls(await run(MDLS, ["-name", "kMediaDurationSeconds", "-name", "kMediaPixelWidth", "-name", "kMediaPixelHeight", path], PROBE_TIMEOUT_MS));
    } catch {
      // a tool that failed leaves the clip without a length or size
    }
    return {};
  },
};
