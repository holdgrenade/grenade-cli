/**
 * Pure: which model a Claude Code transcript last answered with (and at which effort level, and when), and the short
 * label the phone shows for it.
 */

/** The last assistant reply's model, as the transcript has it. */
export interface TranscriptModel {
  /** The model id ("claude-opus-5-5"). */
  id: string;
  /** The effort level of that reply ("high"), when Claude Code wrote one. */
  effort?: string;
  /** When the reply was written (ISO 8601), when the line says. */
  at?: string;
}

/** The model, effort and time of the last assistant reply in some transcript JSONL text, or null. */
export function lastReplyModelIn(jsonl: string): TranscriptModel | null {
  const lines = jsonl.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (!line.includes('"model"')) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const { type, message, effort, timestamp } = (entry ?? {}) as { type?: unknown; message?: { model?: unknown }; effort?: unknown; timestamp?: unknown };
    const model = message?.model;
    // "<synthetic>" marks replies Claude Code wrote itself (errors, interruptions), not a model.
    if (type !== "assistant" || typeof model !== "string" || !model || model.startsWith("<")) continue;
    return {
      id: model,
      ...(typeof effort === "string" && EFFORT.test(effort) ? { effort } : {}),
      ...(typeof timestamp === "string" ? { at: timestamp } : {}),
    };
  }
  return null;
}

/** An effort level as the protocol carries it (`EffortLevel`). */
const EFFORT = /^[a-z][a-z0-9-]{0,15}$/;

/** The model id of the last assistant reply in some transcript JSONL text, or null. Partial first lines are skipped. */
export function lastModelIn(jsonl: string): string | null {
  return lastReplyModelIn(jsonl)?.id ?? null;
}

/**
 * "claude-opus-5-5" → "Opus 5.5", "claude-haiku-4-5-20251001" → "Haiku 4.5", "claude-3-5-sonnet-20241022" → "Sonnet 3.5",
 * "claude-sonnet-5[1m]" → "Sonnet 5". Anything else comes back unchanged (cut to 60 characters).
 */
export function modelLabel(id: string): string {
  const parts = id
    .trim()
    .replace(/\[.*\]$/, "")
    .split("-");
  if (parts[0] !== "claude") return id.slice(0, 60);
  const rest = parts.slice(1).filter((p) => !/^\d{8}$/.test(p));
  const family = rest.find((p) => /^[a-z]+$/.test(p));
  const version = rest.filter((p) => /^\d+$/.test(p));
  if (!family || rest.length !== version.length + 1) return id.slice(0, 60);
  const name = family[0]!.toUpperCase() + family.slice(1);
  return version.length ? `${name} ${version.join(".")}` : name;
}
