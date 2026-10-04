/** Reads the tail of a Claude Code transcript and returns what it last answered with: the model's label, the effort level, and when. */
import { open } from "node:fs/promises";
import { lastReplyModelIn, modelLabel } from "./modelLabel.js";

/** Replies with long text or big tool results can be large; this covers several of them. */
const TAIL_BYTES = 256 * 1024;

export interface ReadModel {
  /** The label a phone shows ("Opus 5.5"). */
  model: string;
  effort?: string;
  /** When that reply was written (ISO 8601), when the transcript says. */
  at?: string;
}

export async function readTranscriptModel(path: string): Promise<ReadModel | null> {
  const file = await open(path, "r");
  try {
    const { size } = await file.stat();
    const length = Math.min(size, TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    await file.read(buffer, 0, length, size - length);
    const last = lastReplyModelIn(buffer.toString("utf8"));
    if (!last) return null;
    return { model: modelLabel(last.id), ...(last.effort !== undefined ? { effort: last.effort } : {}), ...(last.at !== undefined ? { at: last.at } : {}) };
  } finally {
    await file.close();
  }
}
