/**
 * The order groups are listed in, kept for every client (PROTOCOL.md "Group order"), and the groups kept with no
 * session (PROTOCOL.md "Kept groups"). Follows the registry: new groups go to the top, a session moved out lands right
 * under the group it left, a group whose last session is removed is kept until it is closed, and a group emptied any
 * other way (its last session moved to another group) is dropped. Saved to groups.json so it survives a restart.
 */
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { GROUP_NAME_MAX, type GroupsFrame, type KeptGroup, type Session } from "@grenade/protocol";
import { groupCwdOf } from "../canvas/canvasAccess.js";
import type { Logger } from "../log.js";
import { moveGroup, placeUnder, reconcileGroupOrder, sameOrder } from "./groupOrder.js";
import { cleanGroupName } from "./groups.js";
import { UnknownGroupError } from "./registry.js";

/** The slice of SessionRegistry the store follows. */
export interface GroupOrderRegistry {
  list(): Session[];
  on(event: "updated", cb: (s: Session) => void): unknown;
  on(event: "removed", cb: (id: string) => void): unknown;
}

export interface GroupOrderEvents {
  /** The order or a kept group changed; the frame goes to every client. */
  changed: [frame: GroupsFrame];
}

const groupOf = (s: Session): string => s.group ?? s.id;

export class GroupOrderStore extends EventEmitter<GroupOrderEvents> {
  private order: string[];
  /** The groups kept with no session, by id. */
  private readonly kept = new Map<string, KeptGroup>();
  /** Each session as it was last seen: where a session moved out of its group came from, and what a removed one leaves. */
  private readonly lastSeen = new Map<string, Session>();

  constructor(
    private readonly registry: GroupOrderRegistry,
    private readonly log: Logger,
    private readonly path?: string,
    private readonly home = homedir(),
  ) {
    super();
    const saved = this.load();
    const sessions = registry.list();
    // A kept group that has a session again (one started in it while the daemon was down cannot be, but be sure) is a group like any other.
    for (const k of saved.kept) if (!sessions.some((s) => groupOf(s) === k.group)) this.kept.set(k.group, k);
    this.order = reconcileGroupOrder(saved.order, sessions, [...this.kept.keys()]);
    this.save();
    for (const s of sessions) this.lastSeen.set(s.id, s);
    registry.on("updated", (s) => this.sessionUpdated(s));
    registry.on("removed", (id) => this.sessionRemoved(id));
  }

  frame(): GroupsFrame {
    return { type: "groups", order: [...this.order], kept: [...this.kept.values()].map((k) => ({ ...k })) };
  }

  /** Moves `group` to `index` among the groups. Returns false when it was already there. */
  move(group: string, index: number): boolean {
    if (!this.order.includes(group)) throw new UnknownGroupError(`no group ${group}`);
    const changed = this.apply(moveGroup(this.order, group, index));
    if (changed) this.log.info(`Moved group ${group}`, { index });
    return changed;
  }

  /** The group kept with no session, or undefined when `group` has a session or is not kept. */
  keptGroup(group: string): KeptGroup | undefined {
    return this.kept.get(group);
  }

  /** Names a kept group, or with null gives it back its folder's name. Returns false when nothing changed. */
  rename(group: string, name: string | null): boolean {
    const k = this.kept.get(group);
    if (!k) throw new UnknownGroupError(`no kept group ${group}`);
    const next = cleanGroupName(name);
    if (k.name === next) return false;
    const { name: _was, ...rest } = k;
    this.kept.set(group, next === undefined ? rest : { ...rest, name: next });
    this.save();
    this.emit("changed", this.frame());
    return true;
  }

  /** Makes `cwd` a kept group's canvas folder (`group.canvasCwd`). Returns false when it was that already. */
  setCwd(group: string, cwd: string): boolean {
    const k = this.kept.get(group);
    if (!k) throw new UnknownGroupError(`no kept group ${group}`);
    if (k.cwd === cwd) return false;
    this.kept.set(group, { ...k, cwd });
    this.save();
    this.log.info(`Moved the canvases of group ${group}`, { cwd });
    this.emit("changed", this.frame());
    return true;
  }

  /** Drops a kept group (`group.close`). Its canvases stay in its folder. */
  close(group: string): void {
    if (!this.kept.delete(group)) throw new UnknownGroupError(`no kept group ${group}`);
    this.log.info(`Closed group ${group}`);
    if (!this.apply(reconcileGroupOrder(this.order, this.registry.list(), [...this.kept.keys()]))) {
      this.save();
      this.emit("changed", this.frame());
    }
  }

  /**
   * Each kept group as a stand-in `gone` session in its folder, for what serves a group's folder and canvases as it
   * does a session's (`CanvasService`): so a kept group's canvases stay open.
   */
  standIns(): Session[] {
    return [...this.kept.values()].map((k) => ({
      id: `kept-${k.group}`,
      name: k.name ?? k.group,
      agent: "shell",
      cwd: k.cwd,
      status: "gone",
      statusSince: new Date(0).toISOString(),
      lastLine: "",
      createdAt: new Date(0).toISOString(),
      group: k.group,
    }));
  }

  private sessionUpdated(s: Session): void {
    const from = this.lastSeen.get(s.id)?.group;
    this.lastSeen.set(s.id, s);
    // A session started in (or moved into) a kept group: the group has a session again.
    if (this.kept.delete(groupOf(s))) {
      this.log.info(`Group ${groupOf(s)} has a session again`);
      this.save();
      this.emit("changed", this.frame());
    }
    // A session moved out of its group: its new group sits right under the one it left.
    const movedOut = s.group !== undefined && from !== undefined && s.group !== from && !this.order.includes(s.group);
    const order = movedOut ? placeUnder(this.order, s.group as string, from) : this.order;
    this.apply(reconcileGroupOrder(order, this.registry.list(), [...this.kept.keys()]));
  }

  /** A removed session that was its group's last leaves the group kept, with its folder and name. */
  private sessionRemoved(id: string): void {
    const was = this.lastSeen.get(id);
    this.lastSeen.delete(id);
    const sessions = this.registry.list();
    if (was && !sessions.some((s) => groupOf(s) === groupOf(was))) {
      const cwd = groupCwdOf(was, [was], this.home) ?? was.cwd;
      const name = was.groupName?.slice(0, GROUP_NAME_MAX);
      this.kept.set(groupOf(was), { group: groupOf(was), cwd, ...(name ? { name } : {}) });
      this.log.info(`Kept group ${groupOf(was)} with no session`, { cwd });
      this.save();
      this.emit("changed", this.frame());
      return;
    }
    this.apply(reconcileGroupOrder(this.order, sessions, [...this.kept.keys()]));
  }

  private apply(next: string[]): boolean {
    if (sameOrder(next, this.order)) return false;
    this.order = next;
    this.save();
    this.emit("changed", this.frame());
    return true;
  }

  private load(): { order: string[]; kept: KeptGroup[] } {
    if (!this.path || !existsSync(this.path)) return { order: [], kept: [] };
    try {
      const saved = JSON.parse(readFileSync(this.path, "utf8")) as { order?: unknown; kept?: unknown };
      const order = Array.isArray(saved.order) ? saved.order.filter((g): g is string => typeof g === "string") : [];
      const kept = Array.isArray(saved.kept) ? saved.kept.flatMap((k) => keptGroupOf(k)) : [];
      return { order, kept };
    } catch (e) {
      this.log.warn("Could not read groups.json; groups are listed newest first", { error: e });
      return { order: [], kept: [] };
    }
  }

  private save(): void {
    if (!this.path) return;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const kept = [...this.kept.values()];
      writeFileSync(this.path, JSON.stringify(kept.length > 0 ? { order: this.order, kept } : { order: this.order }, null, 2) + "\n");
    } catch (e) {
      this.log.warn("Could not save groups.json", { error: e });
    }
  }
}

/** A kept group as groups.json holds it, or nothing when it is not one. */
function keptGroupOf(raw: unknown): KeptGroup[] {
  if (typeof raw !== "object" || raw === null) return [];
  const { group, cwd, name } = raw as Record<string, unknown>;
  if (typeof group !== "string" || group === "" || typeof cwd !== "string" || cwd === "") return [];
  const clean = typeof name === "string" ? cleanGroupName(name) : undefined;
  return [{ group, cwd, ...(clean ? { name: clean } : {}) }];
}
