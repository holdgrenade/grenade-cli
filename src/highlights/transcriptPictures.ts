/**
 * The pictures an agent took or looked at, read from the lines of its Claude Code transcript (PROTOCOL.md
 * "Highlights", the `screen` tiles): a file it read that is a picture (`Read` of a .png, .jpg, .jpeg, .webp or .gif),
 * an image a tool result showed it (a screenshot from a browser tool, inline as base64), and a screenshot a command of
 * its wrote (`screencapture …/x.png`, `xcrun simctl io booted screenshot x.png`). Pure: no I/O, no clock; the caller
 * reads the files it names.
 */

/** A picture named or carried by a transcript line. */
export type TranscriptPicture =
  | { kind: "path"; path: string; at: string }
  | { kind: "inline"; mime: string; data: string; at: string };

/** The most pictures taken from one turn's transcript lines, oldest first. */
export const TRANSCRIPT_PICTURES_MAX = 40;

const PICTURE_EXT = /\.(png|jpe?g|webp|gif)$/i;
const PICTURE_MIMES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

interface Line {
  type?: unknown;
  timestamp?: unknown;
  message?: { content?: unknown };
}

interface Block {
  type?: unknown;
  id?: unknown;
  tool_use_id?: unknown;
  name?: unknown;
  input?: Record<string, unknown>;
  content?: unknown;
  source?: { type?: unknown; media_type?: unknown; data?: unknown };
}

/** Whether a path names a picture by its extension. */
export function isPicturePath(path: string): boolean {
  return PICTURE_EXT.test(path.trim());
}

/**
 * The picture a shell command writes, when it is a screenshot command: `screencapture` (its last argument that is a
 * picture path) or `simctl io … screenshot <path>`. Null for any other command.
 */
export function screenshotWrittenBy(command: string): string | null {
  const text = command.trim();
  if (!/(^|[\s;&|(])(screencapture|simctl)\b/.test(text)) return null;
  if (/\bsimctl\b/.test(text) && !/\bscreenshot\b/.test(text)) return null;
  // The last token that ends in a picture extension, with any quotes around it taken off.
  const tokens = text.match(/"[^"]+"|'[^']+'|\S+/g) ?? [];
  for (let i = tokens.length - 1; i >= 0; i--) {
    const t = tokens[i]!.replace(/^['"]|['"]$/g, "");
    if (isPicturePath(t) && !t.startsWith("-")) return t;
  }
  return null;
}

/**
 * The pictures in some transcript JSONL whose lines fall between `from` and `to` (ISO times, inclusive), in order,
 * each path once (the first time it was seen). A `Read` of a picture answers with the picture inline too: that result's
 * images are not counted again (the file is the picture). Lines that do not parse are skipped.
 */
export function picturesIn(jsonl: string, from: string, to: string): TranscriptPicture[] {
  const out: TranscriptPicture[] = [];
  const seen = new Set<string>();
  const pictureCalls = new Set<string>();
  const start = Date.parse(from);
  const end = Date.parse(to);
  for (const line of jsonl.split("\n")) {
    if (!line.includes('"tool_use"') && !line.includes('"image"')) continue;
    let entry: Line;
    try {
      entry = JSON.parse(line) as Line;
    } catch {
      continue;
    }
    if (!entry || typeof entry.timestamp !== "string") continue;
    const at = Date.parse(entry.timestamp);
    if (Number.isNaN(at) || at < start || at > end) continue;
    const content = entry.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content as Block[]) {
      if (!block || typeof block !== "object") continue;
      if (entry.type === "assistant" && block.type === "tool_use") {
        const path = pathOfToolUse(block);
        if (path && typeof block.id === "string") pictureCalls.add(block.id);
        if (path && !seen.has(path)) {
          seen.add(path);
          out.push({ kind: "path", path, at: entry.timestamp });
        }
      } else if (entry.type === "user" && block.type === "tool_result" && Array.isArray(block.content)) {
        if (typeof block.tool_use_id === "string" && pictureCalls.has(block.tool_use_id)) continue;
        for (const inner of block.content as Block[]) {
          const picture = inlinePicture(inner, entry.timestamp);
          if (picture) out.push(picture);
        }
      }
      if (out.length >= TRANSCRIPT_PICTURES_MAX) return out;
    }
  }
  return out;
}

/** The picture a tool call names: a `Read` of a picture file, or a screenshot command's output. */
function pathOfToolUse(block: Block): string | null {
  const input = block.input;
  if (!input || typeof input !== "object") return null;
  if (block.name === "Read") {
    const path = input["file_path"];
    return typeof path === "string" && isPicturePath(path) ? path : null;
  }
  if (block.name === "Bash") {
    const command = input["command"];
    return typeof command === "string" ? screenshotWrittenBy(command) : null;
  }
  return null;
}

/** An image block of a tool result, carried inline as base64. */
function inlinePicture(block: Block, at: string): TranscriptPicture | null {
  if (!block || block.type !== "image" || !block.source || block.source.type !== "base64") return null;
  const mime = block.source.media_type;
  const data = block.source.data;
  if (typeof mime !== "string" || !PICTURE_MIMES.has(mime) || typeof data !== "string" || data.length === 0) return null;
  return { kind: "inline", mime, data, at };
}
