/** Writes uploaded attachments under <dir>/<sessionId>/ and hands back where they went. */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { attachmentFileName } from "./attachmentName.js";

export interface SavedAttachment {
  /** Absolute path on this Mac. */
  path: string;
  bytes: number;
}

export interface AttachmentStore {
  save(sessionId: string, name: string, mime: string, data: Buffer): Promise<SavedAttachment>;
}

export function createAttachmentStore(dir: string, now: () => Date = () => new Date()): AttachmentStore {
  return {
    async save(sessionId, name, mime, data) {
      const folder = join(dir, sessionId);
      await mkdir(folder, { recursive: true });
      const fileName = attachmentFileName(name, mime, now());
      // Two uploads in the same second get `-2`, `-3`… before the extension. `wx` claims the name, so uploads
      // written at once (several images dropped together, all called "image") never pick the same one.
      for (let n = 1; ; n++) {
        const path = join(folder, numbered(fileName, n));
        try {
          await writeFile(path, data, { flag: "wx" });
          return { path, bytes: data.length };
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        }
      }
    },
  };
}

function numbered(fileName: string, n: number): string {
  if (n === 1) return fileName;
  const dot = fileName.lastIndexOf(".");
  return dot > 0 ? `${fileName.slice(0, dot)}-${n}${fileName.slice(dot)}` : `${fileName}-${n}`;
}
