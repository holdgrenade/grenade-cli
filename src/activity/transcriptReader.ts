/**
 * Reads a Claude Code transcript a piece at a time: each `read` returns the activity entries of the lines written
 * since the last read of that file, so a hook costs one small read however long the session has run.
 */
import { open } from "node:fs/promises";
import { activityEntriesIn, type ActivityEntry } from "@grenade/protocol";

interface Cursor {
  /** Bytes of the file already turned into entries. Always at the start of a line. */
  offset: number;
  /** Reads of the same file run one after another, so entries never arrive out of order. */
  busy: Promise<unknown>;
}

export class TranscriptReader {
  private readonly cursors = new Map<string, Cursor>();

  /** The entries of the complete lines written since the last read; all of them on the first read of a file. */
  read(path: string): Promise<ActivityEntry[]> {
    const cursor = this.cursors.get(path) ?? { offset: 0, busy: Promise.resolve() };
    this.cursors.set(path, cursor);
    const next = cursor.busy.then(
      () => this.readFrom(path, cursor),
      () => this.readFrom(path, cursor),
    );
    cursor.busy = next;
    return next;
  }

  /** Forgets a file, so the next read starts from its beginning. */
  forget(path: string): void {
    this.cursors.delete(path);
  }

  private async readFrom(path: string, cursor: Cursor): Promise<ActivityEntry[]> {
    const file = await open(path, "r");
    try {
      const { size } = await file.stat();
      // A shorter file than last time was replaced: start over.
      if (size < cursor.offset) cursor.offset = 0;
      if (size === cursor.offset) return [];
      const buffer = Buffer.alloc(size - cursor.offset);
      await file.read(buffer, 0, buffer.length, cursor.offset);
      // Only whole lines: a line still being written is read next time.
      const end = buffer.lastIndexOf(0x0a);
      if (end < 0) return [];
      cursor.offset += end + 1;
      return activityEntriesIn(buffer.subarray(0, end).toString("utf8"));
    } finally {
      await file.close();
    }
  }
}
