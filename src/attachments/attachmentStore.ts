/** Writes uploaded attachments under <dir>/<sessionId>/ and hands back where they went. */
import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
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
      const path = unusedPath(folder, attachmentFileName(name, mime, now()));
      await writeFile(path, data, { flag: "wx" });
      return { path, bytes: data.length };
    },
  };
}

/** Two uploads in the same second get `-2`, `-3`… before the extension. */
function unusedPath(folder: string, fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  const stem = dot > 0 ? fileName.slice(0, dot) : fileName;
  const ext = dot > 0 ? fileName.slice(dot) : "";
  let candidate = join(folder, fileName);
  for (let n = 2; existsSync(candidate); n++) candidate = join(folder, `${stem}-${n}${ext}`);
  return candidate;
}
