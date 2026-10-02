/** Pure: a session's `title` (PROTOCOL.md "Session"): Claude Code's own title in transcript JSONL, and the length cap. */
import { SESSION_TITLE_MAX } from "@grenade/protocol";

/** Claude Code writes `{"type":"ai-title","aiTitle":…}` and repeats it as the title changes; the last one wins. */
export function aiTitleIn(jsonl: string): string | null {
  let title: string | null = null;
  for (const line of jsonl.split("\n")) {
    if (!line.includes('"ai-title"')) continue;
    const entry = parse(line);
    const text = entry?.["aiTitle"];
    if (entry?.["type"] === "ai-title" && typeof text === "string" && text.trim()) title = text;
  }
  return title;
}

/** One line of at most SESSION_TITLE_MAX characters, cut at a word with `…`; undefined when nothing is left. */
export function clipTitle(text: string): string | undefined {
  const line = text.replace(/\s+/g, " ").trim().replace(/\.$/, "");
  if (line === "") return undefined;
  if (line.length <= SESSION_TITLE_MAX) return line;
  const cut = line.slice(0, SESSION_TITLE_MAX - 1);
  const space = cut.lastIndexOf(" ");
  return (space > SESSION_TITLE_MAX / 2 ? cut.slice(0, space) : cut).trimEnd() + "…";
}

function parse(line: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(line);
    return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
