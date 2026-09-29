/** Reads the tail of a Claude Code transcript and returns the label of the model it last answered with. */
import { open } from "node:fs/promises";
import { lastModelIn, modelLabel } from "./modelLabel.js";

/** Replies with long text or big tool results can be large; this covers several of them. */
const TAIL_BYTES = 256 * 1024;

export async function readTranscriptModel(path: string): Promise<string | null> {
  const file = await open(path, "r");
  try {
    const { size } = await file.stat();
    const length = Math.min(size, TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    await file.read(buffer, 0, length, size - length);
    const id = lastModelIn(buffer.toString("utf8"));
    return id ? modelLabel(id) : null;
  } finally {
    await file.close();
  }
}
