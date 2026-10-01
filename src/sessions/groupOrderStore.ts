/**
 * The order groups are listed in, kept for every client (PROTOCOL.md "Group order"). Follows the
 * registry: new groups go to the top, a session moved out lands right under the group it left, and
 * groups without a session are dropped. Saved to groups.json so it survives a restart.
 */
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { GroupsFrame, Session } from "@grenade/protocol";
import type { Logger } from "../log.js";
import { moveGroup, placeUnder, reconcileGroupOrder, sameOrder } from "./groupOrder.js";
import { UnknownGroupError } from "./registry.js";

/** The slice of SessionRegistry the store follows. */
export interface GroupOrderRegistry {
  list(): Session[];
  on(event: "updated", cb: (s: Session) => void): unknown;
  on(event: "removed", cb: (id: string) => void): unknown;
}

export interface GroupOrderEvents {
  /** The order changed; the frame goes to every client. */
  changed: [frame: GroupsFrame];
}

export class GroupOrderStore extends EventEmitter<GroupOrderEvents> {
  private order: string[];
  /** The group each session was last seen in, to tell where a session moved out of its group came from. */
  private readonly lastGroup = new Map<string, string>();

  constructor(
    private readonly registry: GroupOrderRegistry,
    private readonly log: Logger,
    private readonly path?: string,
  ) {
    super();
    this.order = reconcileGroupOrder(this.load(), registry.list());
    this.save();
    for (const s of registry.list()) if (s.group !== undefined) this.lastGroup.set(s.id, s.group);
    registry.on("updated", (s) => this.sessionUpdated(s));
    registry.on("removed", (id) => {
      this.lastGroup.delete(id);
      this.apply(reconcileGroupOrder(this.order, registry.list()));
    });
  }

  frame(): GroupsFrame {
    return { type: "groups", order: [...this.order] };
  }

  /** Moves `group` to `index` among the groups. Returns false when it was already there. */
  move(group: string, index: number): boolean {
    if (!this.order.includes(group)) throw new UnknownGroupError(`no group ${group}`);
    const changed = this.apply(moveGroup(this.order, group, index));
    if (changed) this.log.info(`Moved group ${group}`, { index });
    return changed;
  }

  private sessionUpdated(s: Session): void {
    const from = this.lastGroup.get(s.id);
    if (s.group !== undefined) this.lastGroup.set(s.id, s.group);
    // A session moved out of its group: its new group sits right under the one it left.
    const movedOut = s.group !== undefined && from !== undefined && s.group !== from && !this.order.includes(s.group);
    const order = movedOut ? placeUnder(this.order, s.group as string, from) : this.order;
    this.apply(reconcileGroupOrder(order, this.registry.list()));
  }

  private apply(next: string[]): boolean {
    if (sameOrder(next, this.order)) return false;
    this.order = next;
    this.save();
    this.emit("changed", this.frame());
    return true;
  }

  private load(): string[] {
    if (!this.path || !existsSync(this.path)) return [];
    try {
      const saved = JSON.parse(readFileSync(this.path, "utf8")) as { order?: unknown };
      return Array.isArray(saved.order) ? saved.order.filter((g): g is string => typeof g === "string") : [];
    } catch (e) {
      this.log.warn("Could not read groups.json; groups are listed newest first", { error: e });
      return [];
    }
  }

  private save(): void {
    if (!this.path) return;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      writeFileSync(this.path, JSON.stringify({ order: this.order }, null, 2) + "\n");
    } catch (e) {
      this.log.warn("Could not save groups.json", { error: e });
    }
  }
}
