/**
 * The design canvas a connection asks for (PROTOCOL.md "Canvas"): which folder a `cwd` names and whether it may be
 * served (`canvasAccess.ts`), its boards (`canvasFolder.ts`), one board's HTML, and a watch on it (`CanvasWatcher`).
 */
import { homedir } from "node:os";
import type { Session } from "@grenade/protocol";
import { computerWord } from "../platform/computer.js";
import { allowedCanvasCwd, canvasFolderOf } from "./canvasAccess.js";
import { CanvasError, listCanvas, readBoard, type CanvasListing } from "./canvasFolder.js";
import { CanvasWatcher } from "./canvasWatcher.js";

export { CanvasError };

/** A canvas as `canvas` sends it, without `type`, `id` and `cwd`. */
export type CanvasReply = CanvasListing & { folder: string };

export class CanvasService {
  constructor(
    /** Every session the daemon lists: whose folders may be served. */
    private readonly sessions: () => Session[],
    private readonly watcher = new CanvasWatcher(),
    private readonly home = homedir(),
    private readonly computer = computerWord(),
  ) {}

  /** The canvas folder of `cwd`, or `CanvasError` when no session works there. */
  folderOf(cwd: string): string {
    const allowed = allowedCanvasCwd(cwd, this.sessions(), this.home);
    if (!allowed) throw new CanvasError(`No session on this ${this.computer} works in ${cwd}, so it has no canvas to show.`);
    return canvasFolderOf(allowed);
  }

  async list(cwd: string): Promise<CanvasReply> {
    const folder = this.folderOf(cwd);
    return { folder, ...(await listCanvas(folder)) };
  }

  async board(cwd: string, file: string): Promise<{ html: string; modified: string; bytes: number }> {
    return readBoard(this.folderOf(cwd), file, this.computer);
  }

  /** The canvas now, and `onChange` with each change after it until `stop`. */
  async watch(cwd: string, onChange: (reply: CanvasReply) => void): Promise<{ reply: CanvasReply; stop: () => void }> {
    const reply = await this.list(cwd);
    const stop = this.watcher.watch(reply.folder, reply, (listing) => onChange({ folder: reply.folder, ...listing }));
    return { reply, stop };
  }

  stop(): void {
    this.watcher.stopAll();
  }
}
