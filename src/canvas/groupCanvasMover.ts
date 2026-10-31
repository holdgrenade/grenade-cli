/**
 * `group.canvasCwd` (PROTOCOL.md "Canvas", "Moving a group's canvases"): moves a group's canvases to another project
 * (`moveGroupCanvases`), points its published links at their new place, then makes that project the group's canvas
 * folder: every member's `canvasCwd`, or a kept group's `cwd`. Each step reaches every client through its own store.
 */
import type { GroupsFrame, KeptGroup, Session } from "@grenade/protocol";
import type { Logger } from "../log.js";
import { UnknownGroupError } from "../sessions/registry.js";
import { membersInOrder } from "../sessions/groups.js";
import { groupCwdOf, groupFolderOf, normalizeCwd, projectOf } from "./canvasAccess.js";
import { CanvasMoveError, moveGroupCanvases } from "./canvasMove.js";

export interface GroupCanvasMoverDeps {
  registry: { list(): Session[]; setGroupCanvasCwd(group: string, cwd: string): { session: Session; changed: boolean } };
  groups?: { keptGroup(group: string): KeptGroup | undefined; setCwd(group: string, cwd: string): boolean; frame(): GroupsFrame } | undefined;
  publish?: { followMove(from: string, to: string, cwd: string): Promise<number> } | undefined;
  home: string;
  log: Logger;
  /** The move on disk; `moveGroupCanvases` unless a test hands another. */
  move?: (from: string, to: string, group: string) => Promise<boolean>;
}

export class GroupCanvasMover {
  constructor(private readonly d: GroupCanvasMoverDeps) {}

  /**
   * Moves `group`'s canvases to the project `cwd`. Returns what to answer the sender with when nothing changed (the
   * group is there already); undefined once it moved. Throws `UnknownGroupError` or `CanvasMoveError`.
   */
  async move(group: string, cwd: string): Promise<Session | GroupsFrame | undefined> {
    const normalized = normalizeCwd(cwd, this.d.home);
    if (!normalized) throw new CanvasMoveError(`${cwd} is not a folder on this computer.`);
    const to = projectOf(normalized);
    const sessions = this.d.registry.list();
    const first = membersInOrder(group, sessions)[0];
    const kept = first ? undefined : this.d.groups?.keptGroup(group);
    if (!first && !kept) throw new UnknownGroupError(`no group ${group}`);
    const from = first ? groupCwdOf(first, sessions, this.d.home) : normalizeCwd(kept!.cwd, this.d.home);
    if (!from) throw new CanvasMoveError("This group's canvas folder is not known, so its canvases are not moved.");
    if (from === to) return first ?? this.d.groups!.frame();
    const moved = await (this.d.move ?? moveGroupCanvases)(from, to, group);
    const links = moved ? await this.d.publish?.followMove(groupFolderOf(from, group), groupFolderOf(to, group), to) ?? 0 : 0;
    this.d.log.info(moved ? "Moved a group's canvases" : "Moved a group's canvas folder (it had no canvases yet)", { group, from, to, links });
    if (first) this.d.registry.setGroupCanvasCwd(group, to);
    else this.d.groups!.setCwd(group, to);
    return undefined;
  }
}
