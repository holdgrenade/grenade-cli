/**
 * `grenade canvas`: where an agent in a Grenade session draws its boards, its group's canvases
 * (`<folder>/.grenade/canvas/<group>/canvas-<n>`). An agent cannot know its group otherwise, and boards drawn in another
 * group's folder, or one it made up, are not on its canvas card (PROTOCOL.md "The canvas card"). Reads only.
 */
import { homedir } from "node:os";
import { posix } from "node:path";
import { CANVAS_SHARED, canvasNumberOf, type CanvasInfo, type Session } from "@grenade/protocol";
import type { Command } from "commander";
import { canvasFolderOf, groupCwdOf, groupFolderOf } from "../canvas/canvasAccess.js";
import { listCanvases } from "../canvas/canvasFolder.js";
import type { Control } from "./controlClient.js";

export interface CanvasCommandDeps {
  control: Control;
  /** The session this runs in (`GRENADE_SESSION`). */
  session?: string;
}

/** What `grenade canvas` prints: the group's canvases, each a folder with its name and boards, then a new one's folder. */
export function canvasLines(groupFolder: string, canvases: readonly CanvasInfo[]): string[] {
  const own = canvases.filter((c) => c.canvas !== CANVAS_SHARED);
  const next = `canvas-${Math.max(0, ...own.map((c) => canvasNumberOf(c.canvas) ?? 0)) + 1}`;
  const plural = (n: number) => `${n} board${n === 1 ? "" : "s"}`;
  return [
    ...own.map((c) => `${posix.join(groupFolder, c.canvas)}  ${c.name} (${plural(c.boards)})`),
    `${posix.join(groupFolder, next)}  a new canvas (make the folder)`,
  ];
}

export function registerCanvasCommand(program: Command, d: CanvasCommandDeps): void {
  program
    .command("canvas")
    .description("the folders a Grenade session draws its boards in: its group's canvases")
    .option("--session <name>", "the session (default: $GRENADE_SESSION)")
    .addHelpText(
      "after",
      [
        "",
        "Each line is a canvas folder of the session's group, then the folder for a new one. Save boards (.html) directly",
        "in one of them, with your file-writing tools, so they show on this session's canvas card. Never draw in another",
        "group's folder or make up a group.",
      ].join("\n"),
    )
    .action(async (o: { session?: string }) => {
      const id = o.session ?? d.session;
      if (!id) throw new Error("run this inside a Grenade session, or name one with --session");
      const sessions = await d.control<Session[]>("GET", "/sessions");
      const session = sessions.find((s) => s.id === id || s.id === `gr-${id}`);
      if (!session) throw new Error(`no session ${id}`);
      const cwd = groupCwdOf(session, sessions, homedir());
      if (!cwd) throw new Error(`${id} works in no folder with a canvas`);
      const groupFolder = groupFolderOf(cwd, session.group ?? session.id);
      const canvases = await listCanvases(groupFolder, canvasFolderOf(cwd)).catch(() => []);
      for (const line of canvasLines(groupFolder, canvases)) console.log(line);
    });
}
