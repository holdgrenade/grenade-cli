/**
 * The design canvas a connection asks for (PROTOCOL.md "Canvas"): which folder a `cwd`, or a group's canvas under it,
 * names and whether it may be served (`canvasAccess.ts`), a group's canvases, a canvas's boards (`canvasFolder.ts`),
 * one board's HTML, and a watch on it (`CanvasWatcher`).
 */
import { homedir } from "node:os";
import type { CanvasInfo, Session } from "@grenade/protocol";
import { computerWord } from "../platform/computer.js";
import { allowedCanvasCwd, canvasFolderOf, groupCanvasFolderOf, groupFolderOf, isListedGroup } from "./canvasAccess.js";
import { CanvasError, canvasInfoOf, listCanvas, listCanvases, readBoard, type CanvasListing } from "./canvasFolder.js";
import { CanvasWatcher } from "./canvasWatcher.js";

export { CanvasError };

/** Which canvas a frame means: `group`'s `canvas` under `cwd`, or without them the boards directly in `<cwd>/.grenade/canvas`. */
export interface CanvasPick {
  cwd: string;
  group?: string;
  canvas?: string;
}

/** A canvas as `canvas` sends it, without `type`, `id`, `cwd`, `group` and `canvas`. */
export type CanvasReply = CanvasListing & { folder: string; name?: string };

export class CanvasService {
  constructor(
    /** Every session the daemon lists: whose folders may be served. */
    private readonly sessions: () => Session[],
    private readonly watcher = new CanvasWatcher(),
    private readonly home = homedir(),
    private readonly computer = computerWord(),
  ) {}

  /** The folder `cwd` names, normalized, or `CanvasError` when no session works there. */
  private allowedCwd(cwd: string): string {
    const allowed = allowedCanvasCwd(cwd, this.sessions(), this.home);
    if (!allowed) throw new CanvasError(`No session on this ${this.computer} works in ${cwd}, so it has no canvas to show.`);
    return allowed;
  }

  /** `group` is one the daemon lists, or `CanvasError`. */
  private listedGroup(group: string): void {
    if (!isListedGroup(group, this.sessions())) throw new CanvasError(`No session on this ${this.computer} is in that group, so it has no canvas to show.`);
  }

  /** The canvas folder a frame names, or `CanvasError` when it may not be served. */
  folderOf(pick: CanvasPick): string {
    if ((pick.group === undefined) !== (pick.canvas === undefined)) throw new CanvasError("A group's canvas is asked for with both its group and its canvas.");
    const cwd = this.allowedCwd(pick.cwd);
    if (pick.group === undefined || pick.canvas === undefined) return canvasFolderOf(cwd);
    this.listedGroup(pick.group);
    return groupCanvasFolderOf(cwd, pick.group, pick.canvas);
  }

  /** A group's canvases (`canvases`), with the group's folder. */
  async canvases(cwd: string, group: string): Promise<{ folder: string; canvases: CanvasInfo[] }> {
    const allowed = this.allowedCwd(cwd);
    this.listedGroup(group);
    const folder = groupFolderOf(allowed, group);
    return { folder, canvases: await listCanvases(folder, canvasFolderOf(allowed)) };
  }

  async list(pick: CanvasPick): Promise<CanvasReply> {
    const folder = this.folderOf(pick);
    return this.named(pick, { folder, ...(await listCanvas(folder)) });
  }

  async board(pick: CanvasPick, file: string): Promise<{ html: string; modified: string; bytes: number }> {
    return readBoard(this.folderOf(pick), file, this.computer);
  }

  /** The canvas now, and `onChange` with each change after it until `stop`. */
  async watch(pick: CanvasPick, onChange: (reply: CanvasReply) => void): Promise<{ reply: CanvasReply; stop: () => void }> {
    const reply = await this.list(pick);
    let stopped = false;
    const stopWatch = this.watcher.watch(reply.folder, reply, (listing) => {
      // A group's canvas is named after its first board, which may just have changed.
      void this.named(pick, { folder: reply.folder, ...listing }).then((named) => {
        if (!stopped) onChange(named);
      });
    });
    return {
      reply,
      stop: () => {
        stopped = true;
        stopWatch();
      },
    };
  }

  /** The reply with the canvas's name, for a group's canvas. */
  private async named(pick: CanvasPick, reply: CanvasReply): Promise<CanvasReply> {
    if (pick.canvas === undefined) return reply;
    const { name } = await canvasInfoOf(reply.folder, pick.canvas).catch(() => ({ name: undefined }));
    return name ? { ...reply, name } : reply;
  }

  stop(): void {
    this.watcher.stopAll();
  }
}
