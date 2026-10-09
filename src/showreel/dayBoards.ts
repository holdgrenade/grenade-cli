/**
 * The boards saved on a day (PROTOCOL.md "Showreel"): every canvas the listed sessions' folders have, read with the
 * canvas's own readers (never written), each board that was saved that day as a `DayBoard` the cut can name. A
 * folder that cannot be read counts for nothing.
 */
import { CANVAS_SHARED, type Session } from "@grenade/protocol";
import { canvasCwds, canvasFolderOf, groupCanvasFolderOf, groupFolderOf } from "../canvas/canvasAccess.js";
import { listCanvas, listCanvases } from "../canvas/canvasFolder.js";
import { clipDate } from "./clipFile.js";
import type { DayBoard } from "./showreelCut.js";

/** The boards saved on `date` in the canvases of `sessions`' folders, newest first. */
export async function dayBoardsOf(date: string, sessions: Session[], home: string): Promise<DayBoard[]> {
  const boards: DayBoard[] = [];
  const groups = new Set(sessions.map((s) => s.group ?? s.id));
  for (const cwd of canvasCwds(sessions, home)) {
    for (const group of groups) {
      const canvases = await listCanvases(groupFolderOf(cwd, group), canvasFolderOf(cwd)).catch(() => []);
      for (const info of canvases) {
        const folder = groupCanvasFolderOf(cwd, group, info.canvas);
        const listing = await listCanvas(folder).catch(() => null);
        for (const b of listing?.boards ?? []) {
          if (clipDate(new Date(b.modified)) !== date) continue;
          const shared = info.canvas === CANVAS_SHARED;
          if (boards.some((d) => d.cwd === cwd && d.file === b.file && (shared ? !d.canvas : d.canvas === info.canvas && d.group === group))) continue;
          boards.push({ cwd, ...(shared ? {} : { group, canvas: info.canvas }), file: b.file, title: b.name, modified: b.modified });
        }
      }
    }
  }
  return boards.sort((a, b) => b.modified.localeCompare(a.modified));
}
