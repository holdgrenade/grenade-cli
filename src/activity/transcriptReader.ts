/**
 * Reads a Claude Code transcript a piece at a time: each `read` returns the whole lines written since the last read
 * of that file, so a hook costs one small read however long the session has run. The protocol's `activityEntriesIn`
 * and `workingDirectoryIn` say what the lines mean.
 */
import { open } from "node:fs/promises";

interface Cursor {
  /** Bytes of the file already returned. Always at the start of a line. */
  offset: number;
  /** Reads of the same file run one after another, so lines never arrive out of order. */
  busy: Promise<unknown>;
}

export class TranscriptReader {
  private readonly cursors = new Map<string, Cursor>();

  /** The complete lines written since the last read, as JSONL; all of them on the first read of a file. */
  read(path: string): Promise<string> {
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

  private async readFrom(path: string, cursor: Cursor): Promise<string> {
    const file = await open(path, "r");
    try {
      const { size } = await file.stat();
      // A shorter file than last time was replaced: start over.
      if (size < cursor.offset) cursor.offset = 0;
      if (size === cursor.offset) return "";
      const buffer = Buffer.alloc(size - cursor.offset);
      await file.read(buffer, 0, buffer.length, cursor.offset);
      // Only whole lines: a line still being written is read next time.
      const end = buffer.lastIndexOf(0x0a);
      if (end < 0) return "";
      cursor.offset += end + 1;
      return buffer.subarray(0, end).toString("utf8");
    } finally {
      await file.close();
    }
  }
}
