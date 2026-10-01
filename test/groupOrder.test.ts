import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { GroupsFrame, Session } from "@grenade/protocol";
import { moveGroup, placeUnder, reconcileGroupOrder } from "../src/sessions/groupOrder.js";
import { GroupOrderStore } from "../src/sessions/groupOrderStore.js";
import { UnknownGroupError } from "../src/sessions/registry.js";
import { silentLogger } from "../src/log.js";

const s = (id: string, group: string | undefined, createdAt: string): Session => ({
  id,
  name: id,
  agent: "shell",
  cwd: "/tmp",
  status: "idle",
  statusSince: createdAt,
  lastLine: "",
  createdAt,
  ...(group ? { group } : {}),
});

describe("reconcileGroupOrder", () => {
  it("lists groups newest first when nothing is placed yet, by their oldest member", () => {
    const sessions = [s("gr-a", "g-1", "2026-10-01T10:00:00Z"), s("gr-b", "g-2", "2026-10-01T11:00:00Z"), s("gr-c", "g-1", "2026-10-01T12:00:00Z")];
    expect(reconcileGroupOrder([], sessions)).toEqual(["g-2", "g-1"]);
  });

  it("keeps the order it has, puts a new group on top and drops a group with no session", () => {
    const sessions = [s("gr-a", "g-1", "2026-10-01T10:00:00Z"), s("gr-b", "g-2", "2026-10-01T11:00:00Z"), s("gr-new", "g-9", "2026-10-01T13:00:00Z")];
    expect(reconcileGroupOrder(["g-1", "g-gone", "g-2"], sessions)).toEqual(["g-9", "g-1", "g-2"]);
  });

  it("counts a session without a group as a group of its own", () => {
    expect(reconcileGroupOrder([], [s("gr-old", undefined, "2026-10-01T10:00:00Z")])).toEqual(["gr-old"]);
  });
});

describe("placeUnder and moveGroup", () => {
  it("puts a group right under another one, or on top when that one is unknown", () => {
    expect(placeUnder(["g-1", "g-2", "g-3"], "g-new", "g-2")).toEqual(["g-1", "g-2", "g-new", "g-3"]);
    expect(placeUnder(["g-new", "g-1", "g-2"], "g-new", "g-2")).toEqual(["g-1", "g-2", "g-new"]);
    expect(placeUnder(["g-1"], "g-new", "g-x")).toEqual(["g-new", "g-1"]);
  });

  it("moves a group to an index, clamped to the end", () => {
    expect(moveGroup(["g-1", "g-2", "g-3"], "g-3", 0)).toEqual(["g-3", "g-1", "g-2"]);
    expect(moveGroup(["g-1", "g-2", "g-3"], "g-1", 99)).toEqual(["g-2", "g-3", "g-1"]);
  });
});

class FakeRegistry extends EventEmitter {
  sessions: Session[] = [];
  list() { return [...this.sessions]; }
  set(next: Session) {
    this.sessions = [...this.sessions.filter((x) => x.id !== next.id), next];
    this.emit("updated", next);
  }
  remove(id: string) {
    this.sessions = this.sessions.filter((x) => x.id !== id);
    this.emit("removed", id);
  }
}

describe("GroupOrderStore", () => {
  const setup = (path?: string) => {
    const registry = new FakeRegistry();
    registry.sessions = [s("gr-a", "g-1", "2026-10-01T10:00:00Z"), s("gr-b", "g-1", "2026-10-01T10:30:00Z"), s("gr-c", "g-2", "2026-10-01T11:00:00Z")];
    const store = new GroupOrderStore(registry, silentLogger, path);
    const frames: GroupsFrame[] = [];
    store.on("changed", (f) => frames.push(f));
    return { registry, store, frames };
  };

  it("follows the registry: new groups on top, a session moved out right under the group it left", () => {
    const { registry, store, frames } = setup();
    expect(store.frame().order).toEqual(["g-2", "g-1"]);
    store.move("g-1", 0);
    registry.set(s("gr-d", "g-3", "2026-10-01T12:00:00Z"));
    expect(store.frame().order).toEqual(["g-3", "g-1", "g-2"]);
    registry.set(s("gr-a", "g-4", "2026-10-01T10:00:00Z")); // moved out of g-1
    expect(store.frame().order).toEqual(["g-3", "g-1", "g-4", "g-2"]);
    registry.remove("gr-c");
    expect(store.frame().order).toEqual(["g-3", "g-1", "g-4"]);
    expect(frames.map((f) => f.order)).toEqual([
      ["g-1", "g-2"],
      ["g-3", "g-1", "g-2"],
      ["g-3", "g-1", "g-4", "g-2"],
      ["g-3", "g-1", "g-4"],
    ]);
  });

  it("sends nothing when a status change leaves the order as it is", () => {
    const { registry, frames } = setup();
    registry.set({ ...s("gr-c", "g-2", "2026-10-01T11:00:00Z"), status: "working" });
    expect(frames).toEqual([]);
  });

  it("refuses a group it does not know, and says when a move changed nothing", () => {
    const { store } = setup();
    expect(() => store.move("g-x", 0)).toThrow(UnknownGroupError);
    expect(store.move("g-2", 0)).toBe(false);
  });

  it("keeps the order across a restart", () => {
    const path = join(mkdtempSync(join(tmpdir(), "gr-groups-")), "groups.json");
    setup(path).store.move("g-1", 0);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ order: ["g-1", "g-2"] });
    expect(setup(path).store.frame().order).toEqual(["g-1", "g-2"]);
    writeFileSync(path, "not json");
    expect(setup(path).store.frame().order).toEqual(["g-2", "g-1"]);
  });
});
