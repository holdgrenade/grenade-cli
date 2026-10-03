/** The first and last bytes of a transcript, which a conversation's list row is read from; and a folder check. */
import { open } from "node:fs/promises";
import { statSync } from "node:fs";

/** How much of each end of a transcript a list row is read from. */
export const SLICE = 128 * 1024;

/** The first and last SLICE bytes of a file; the whole file twice when it is small. */
export async function readEnds(path: string, size: number): Promise<{ head: string; tail: string }> {
  const file = await open(path, "r");
  try {
    if (size <= 2 * SLICE) {
      const all = Buffer.alloc(size);
      await file.read(all, 0, size, 0);
      const text = all.toString("utf8");
      return { head: text, tail: text };
    }
    const head = Buffer.alloc(SLICE);
    const tail = Buffer.alloc(SLICE);
    await file.read(head, 0, SLICE, 0);
    await file.read(tail, 0, SLICE, size - SLICE);
    return { head: head.toString("utf8"), tail: tail.toString("utf8") };
  } finally {
    await file.close();
  }
}

export function isDirectoryOnDisk(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
