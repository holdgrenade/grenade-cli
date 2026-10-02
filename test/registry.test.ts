import { describe, expect, it } from "vitest";
import { silentLogger } from "../src/log.js";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Session } from "@grenade/protocol";
import { byGroupOrder, defaultGroupFor, isJoinableGroup, nextOrder, otherMembers, placeAt } from "../src/sessions/groups.js";
import { BadCwdError, SessionRegistry, UnknownGroupError } from "../src/sessions/registry.js";
import type { Tmux } from "../src/tmux/tmux.js";

function fakeTmux(live: string[] = []) {
  const created: { id: string; cwd: string }[] = [];
  const sizing: string[] = [];
  const tmux: Tmux = {
    async listSessions() { return live; },
    async hasSession() { return false; },
    async newSession(o) { created.push({ id: o.id, cwd: o.cwd }); },
    async capture() { throw new Error("unused"); },
    async captureHistory() { throw new Error("unused"); },
    async applySessionOptions() {},
    async sendText() {},
    async sendKey() {},
    async resize(id) { sizing.push(`resize:${id}`); },
    async releaseSize(id) { sizing.push(`release:${id}`); },
    async killSession() {},
  };
  return { tmux, created, sizing };
}

describe("SessionRegistry.create", () => {
  const folders = new Set(["/Users/me", "/Users/me/app"]);
  const make = () => {
    const t = fakeTmux();
    const registry = new SessionRegistry({ tmux: t.tmux, log: silentLogger, home: "/Users/me", isDirectory: (p) => folders.has(p) });
    return { registry, created: t.created };
  };

  it("starts tmux in the expanded folder and stores it", async () => {
    const { registry, created } = make();
    const s = await registry.create({ name: "App", cwd: "~/app", agent: "claude" });
    expect(created).toEqual([{ id: "gr-app", cwd: "/Users/me/app" }]);
    expect(s.cwd).toBe("/Users/me/app");
  });

  it("refuses a folder that does not exist instead of letting tmux fall back to home", async () => {
    const { registry, created } = make();
    await expect(registry.create({ name: "x", cwd: "/nope", agent: "claude" })).rejects.toBeInstanceOf(BadCwdError);
    await expect(registry.create({ name: "x", cwd: "relative", agent: "shell" })).rejects.toBeInstanceOf(BadCwdError);
    expect(created).toEqual([]);
  });
});

describe("phone width", () => {
  const mac = {};
  const phone = {};
  const make = async () => {
    const t = fakeTmux();
    const registry = new SessionRegistry({ tmux: t.tmux, log: silentLogger, home: "/Users/me", isDirectory: () => true });
    const s = await registry.create({ name: "a", cwd: "/Users/me", agent: "shell" });
    return { registry, id: s.id, sizing: t.sizing };
  };

  it("gives the width back when the last subscriber leaves", async () => {
    const { registry, id, sizing } = await make();
    registry.subscribe(id);
    registry.subscribe(id);
    await registry.resize(id, 46, undefined, mac);
    registry.unsubscribe(id);
    expect(sizing).toEqual([`resize:${id}`]);
    registry.unsubscribe(id);
    expect(sizing).toEqual([`resize:${id}`, `release:${id}`]);
  });

  it("gives the width back on request, only to the client that sized it last", async () => {
    const { registry, id, sizing } = await make();
    registry.subscribe(id);
    await registry.resize(id, 46, undefined, mac);
    await registry.releaseSize(id, phone);
    expect(sizing).toEqual([`resize:${id}`]);
    await registry.releaseSize(id, mac);
    expect(sizing).toEqual([`resize:${id}`, `release:${id}`]);
    await registry.resize(id, 46, undefined, mac);
    await registry.resize(id, 40, undefined, phone);
    await registry.releaseSize(id, mac);
    expect(sizing).toEqual([`resize:${id}`, `release:${id}`, `resize:${id}`, `resize:${id}`]);
    registry.unsubscribe(id);
    expect(sizing.at(-1)).toBe(`release:${id}`);
  });

  it("does not release a window no phone resized, and releases only once", async () => {
    const { registry, id, sizing } = await make();
    registry.subscribe(id);
    registry.unsubscribe(id);
    registry.unsubscribe(id);
    expect(sizing).toEqual([]);
    registry.subscribe(id);
    await registry.resize(id, 46, undefined, mac);
    registry.unsubscribe(id);
    registry.subscribe(id);
    registry.unsubscribe(id);
    expect(sizing).toEqual([`resize:${id}`, `release:${id}`]);
  });
});

describe("session groups", () => {
  const folders = new Set(["/Users/me/app", "/Users/me/web"]);
  const make = (o: { live?: string[]; persistPath?: string } = {}) => {
    let n = 0;
    let t = 0;
    const registry = new SessionRegistry({
      tmux: fakeTmux(o.live).tmux,
      log: silentLogger,
      home: "/Users/me",
      isDirectory: (p) => folders.has(p),
      newGroupId: () => `g-${++n}`,
      now: () => Date.parse("2026-09-27T12:00:00.000Z") + ++t * 1000,
      ...(o.persistPath ? { persistPath: o.persistPath } : {}),
    });
    return registry;
  };

  it("a new session joins the group of its folder, or gets its own", async () => {
    const r = make();
    const claude = await r.create({ name: "app", cwd: "~/app", agent: "claude" });
    const zsh = await r.create({ name: "app-zsh", cwd: "~/app", agent: "shell" });
    const web = await r.create({ name: "web", cwd: "~/web", agent: "claude" });
    expect(claude.group).toBe("g-1");
    expect(zsh.group).toBe("g-1");
    expect(web.group).toBe("g-2");
  });

  it("an explicit group wins over the folder, and an unknown one is refused before tmux starts", async () => {
    const r = make();
    await r.create({ name: "app", cwd: "~/app", agent: "claude" });
    const web = await r.create({ name: "web", cwd: "~/web", agent: "shell", group: "g-1" });
    expect(web.group).toBe("g-1");
    await expect(r.create({ name: "x", cwd: "~/web", agent: "shell", group: "g-nope" })).rejects.toBeInstanceOf(UnknownGroupError);
    expect(r.get("gr-x")).toBeUndefined();
  });

  it("moves a session out and back in, emitting updated and regrouped", async () => {
    const r = make();
    await r.create({ name: "app", cwd: "~/app", agent: "claude" });
    await r.create({ name: "zsh", cwd: "~/app", agent: "shell" });
    const regrouped: string[] = [];
    r.on("regrouped", (s) => regrouped.push(`${s.id}:${s.group}`));
    expect(r.setGroup("gr-zsh", null).group).toBe("g-2");
    expect(r.setGroup("gr-zsh", null).group).toBe("g-2"); // already alone: no change
    expect(r.setGroup("gr-zsh", "g-1").group).toBe("g-1");
    expect(regrouped).toEqual(["gr-zsh:g-2", "gr-zsh:g-1"]);
    expect(() => r.setGroup("gr-zsh", "g-2")).toThrow(UnknownGroupError); // g-2 has no one left
  });

  it("orders a group: new sessions go last, a join or reorder at an index renumbers the group", async () => {
    const r = make();
    for (const name of ["a", "b", "c"]) await r.create({ name, cwd: "~/app", agent: "shell" });
    await r.create({ name: "w", cwd: "~/web", agent: "shell" });
    const order = (g: string) => r.list().filter((s) => s.group === g).sort(byGroupOrder).map((s) => `${s.id.slice(3)}${s.order}`);
    expect(order("g-1")).toEqual(["a0", "b1", "c2"]);
    const updated: string[] = [];
    const regrouped: string[] = [];
    r.on("updated", (s) => updated.push(s.id));
    r.on("regrouped", (s, from) => regrouped.push(`${s.id}:${from}->${s.group}`));

    r.setGroup("gr-c", "g-1", 0); // reorder
    expect(order("g-1")).toEqual(["c0", "a1", "b2"]);
    expect(updated.sort()).toEqual(["gr-a", "gr-b", "gr-c"]);
    expect(regrouped).toEqual(["gr-c:g-1->g-1"]);

    updated.length = 0;
    r.setGroup("gr-c", "g-1"); // own group, no index: nothing
    r.setGroup("gr-c", "g-1", 0); // already there: nothing
    expect(updated).toEqual([]);

    r.setGroup("gr-w", "g-1", 1); // join in the middle
    expect(order("g-1")).toEqual(["c0", "w1", "a2", "b3"]);
    r.setGroup("gr-a", null); // out
    expect(r.get("gr-a")?.order).toBe(0);
    expect(order("g-1")).toEqual(["c0", "w1", "b3"]); // gaps are fine
    r.setGroup("gr-a", "g-1", 99); // back in, clamped to last
    expect(order("g-1")).toEqual(["c0", "w1", "b2", "a3"]);
    r.setGroup("gr-b", "g-1", 0);
    expect(order("g-1")).toEqual(["b0", "c1", "w2", "a3"]);
  });

  it("persists order and gives sessions without one the next place in their group", async () => {
    const dir = mkdtempSync(join(tmpdir(), "grenade-order-"));
    const persistPath = join(dir, "sessions.json");
    writeFileSync(persistPath, JSON.stringify([
      { id: "gr-a", name: "a", agent: "shell", cwd: "/Users/me/app", createdAt: "2026-09-27T09:00:00.000Z", group: "g-k", order: 1 },
      { id: "gr-b", name: "b", agent: "shell", cwd: "/Users/me/app", createdAt: "2026-09-27T10:00:00.000Z", group: "g-k", order: 0 },
      { id: "gr-c", name: "c", agent: "shell", cwd: "/Users/me/app", createdAt: "2026-09-27T11:00:00.000Z", group: "g-k" },
    ]));
    const r = make({ live: ["gr-a", "gr-b", "gr-c"], persistPath });
    await r.adopt();
    expect(r.list().sort(byGroupOrder).map((s) => `${s.id}:${s.order}`)).toEqual(["gr-b:0", "gr-a:1", "gr-c:2"]);
    const saved = JSON.parse(readFileSync(persistPath, "utf8")) as { id: string; order: number }[];
    expect(Object.fromEntries(saved.map((s) => [s.id, s.order]))).toEqual({ "gr-a": 1, "gr-b": 0, "gr-c": 2 });
  });

  it("a gone session's group cannot be joined and it cannot move", async () => {
    const r = make();
    await r.create({ name: "app", cwd: "~/app", agent: "claude" });
    r.markGone("gr-app");
    const next = await r.create({ name: "zsh", cwd: "~/app", agent: "shell" });
    expect(next.group).toBe("g-2");
    expect(() => r.setGroup("gr-app", null)).toThrow();
  });

  it("persists groups and groups old sessions by folder on adopt", async () => {
    const dir = mkdtempSync(join(tmpdir(), "grenade-groups-"));
    const persistPath = join(dir, "sessions.json");
    writeFileSync(persistPath, JSON.stringify([
      { id: "gr-b", name: "b", agent: "shell", cwd: "/Users/me/app", createdAt: "2026-09-27T11:00:00.000Z" },
      { id: "gr-a", name: "a", agent: "claude", cwd: "/Users/me/app", createdAt: "2026-09-27T10:00:00.000Z" },
      { id: "gr-c", name: "c", agent: "claude", cwd: "/Users/me/app", createdAt: "2026-09-27T09:00:00.000Z", group: "g-kept" },
    ]));
    const r = make({ live: ["gr-b", "gr-a", "gr-c"], persistPath });
    await r.adopt();
    expect(r.get("gr-c")?.group).toBe("g-kept");
    expect(r.get("gr-a")?.group).toBe("g-kept");
    expect(r.get("gr-b")?.group).toBe("g-kept");
    const saved = JSON.parse(readFileSync(persistPath, "utf8")) as { id: string; group: string }[];
    expect(saved.map((s) => s.group)).toEqual(["g-kept", "g-kept", "g-kept"]);
  });

  it("sets, emits and persists a summary, and restores it on adopt", async () => {
    const dir = mkdtempSync(join(tmpdir(), "grenade-summary-"));
    const persistPath = join(dir, "sessions.json");
    const r = make({ persistPath });
    await r.create({ name: "app", cwd: "~/app", agent: "claude" });
    const seen: (string | undefined)[] = [];
    r.on("updated", (s) => seen.push(s.summary));
    r.setSummary("gr-app", "Fixing the tests.");
    r.setSummary("gr-app", "Fixing the tests.");
    expect(seen).toEqual(["Fixing the tests."]);
    const again = make({ live: ["gr-app"], persistPath });
    await again.adopt();
    expect(again.get("gr-app")?.summary).toBe("Fixing the tests.");
  });

  it("sets, emits and persists a model, and restores it on adopt", async () => {
    const dir = mkdtempSync(join(tmpdir(), "grenade-model-"));
    const persistPath = join(dir, "sessions.json");
    const r = make({ persistPath });
    await r.create({ name: "app", cwd: "~/app", agent: "claude" });
    const seen: (string | undefined)[] = [];
    r.on("updated", (s) => seen.push(s.model));
    r.setModel("gr-app", "Opus 5.5");
    r.setModel("gr-app", "Opus 5.5");
    expect(seen).toEqual(["Opus 5.5"]);
    const again = make({ live: ["gr-app"], persistPath });
    await again.adopt();
    expect(again.get("gr-app")?.model).toBe("Opus 5.5");
  });

  it("saves the transcript a hook named, keeps it off the session, and restores it on adopt", async () => {
    const persistPath = join(mkdtempSync(join(tmpdir(), "grenade-transcript-")), "sessions.json");
    const r = make({ persistPath });
    await r.create({ name: "app", cwd: "~/app", agent: "claude" });
    r.setTranscript("gr-app", "/Users/adam/.claude/projects/app/one.jsonl");
    expect(r.get("gr-app")).not.toHaveProperty("transcript");
    const again = make({ live: ["gr-app"], persistPath });
    await again.adopt();
    expect(again.transcripts()).toEqual([{ id: "gr-app", path: "/Users/adam/.claude/projects/app/one.jsonl" }]);
  });

  it("setCwd follows the agent into another folder, once per change, and restores it on adopt", async () => {
    const persistPath = join(mkdtempSync(join(tmpdir(), "grenade-cwd-")), "sessions.json");
    const r = make({ live: ["gr-app"], persistPath });
    await r.adopt();
    const seen: string[] = [];
    r.on("updated", (s) => seen.push(s.cwd));
    r.setCwd("gr-app", "/Users/adam/workspace/grenade/grenade-ios");
    r.setCwd("gr-app", "/Users/adam/workspace/grenade/grenade-ios");
    expect(seen).toEqual(["/Users/adam/workspace/grenade/grenade-ios"]);
    const again = make({ live: ["gr-app"], persistPath });
    await again.adopt();
    expect(again.get("gr-app")?.cwd).toBe("/Users/adam/workspace/grenade/grenade-ios");
  });
});

describe("group rules", () => {
  const s = (id: string, cwd: string, group: string | undefined, status: Session["status"] = "idle", createdAt = "2026-09-27T12:00:00.000Z"): Session => ({
    id, name: id, agent: "shell", cwd, status, statusSince: createdAt, lastLine: "", createdAt, ...(group ? { group } : {}),
  });

  it("the default group is the oldest live one in the folder", () => {
    const list = [s("gr-new", "/a", "g-2", "idle", "2026-09-27T12:05:00.000Z"), s("gr-old", "/a", "g-1", "idle", "2026-09-27T12:00:00.000Z"), s("gr-dead", "/a", "g-0", "gone", "2026-09-27T11:00:00.000Z")];
    expect(defaultGroupFor("/a", list)).toBe("g-1");
    expect(defaultGroupFor("/b", list)).toBeNull();
    expect(defaultGroupFor("", [s("gr-x", "", "g-9")])).toBeNull();
  });

  it("joinable means another live member exists", () => {
    const list = [s("gr-a", "/a", "g-1"), s("gr-b", "/a", "g-2", "gone")];
    expect(isJoinableGroup("g-1", list)).toBe(true);
    expect(isJoinableGroup("g-1", list, "gr-a")).toBe(false);
    expect(isJoinableGroup("g-2", list)).toBe(false);
    expect(otherMembers("g-1", list, "gr-z").map((m) => m.id)).toEqual(["gr-a"]);
  });

  it("group order sorts by order, missing last, then oldest", () => {
    const list = [
      { ...s("gr-none-new", "/a", "g-1", "idle", "2026-09-27T12:09:00.000Z") },
      { ...s("gr-none-old", "/a", "g-1", "idle", "2026-09-27T12:01:00.000Z") },
      { ...s("gr-two", "/a", "g-1"), order: 2 },
      { ...s("gr-zero", "/a", "g-1", "idle", "2026-09-27T13:00:00.000Z"), order: 0 },
    ];
    expect([...list].sort(byGroupOrder).map((x) => x.id)).toEqual(["gr-zero", "gr-two", "gr-none-old", "gr-none-new"]);
    expect(nextOrder("g-1", list)).toBe(3);
    expect(nextOrder("g-1", list, "gr-two")).toBe(1);
    expect(nextOrder("g-9", list)).toBe(0);
  });

  it("placeAt takes the id out, then inserts it at the clamped index", () => {
    expect(placeAt(["a", "b", "c"], "a", 2)).toEqual(["b", "c", "a"]);
    expect(placeAt(["a", "b", "c"], "c", 0)).toEqual(["c", "a", "b"]);
    expect(placeAt(["a", "b"], "x", 1)).toEqual(["a", "x", "b"]);
    expect(placeAt(["a", "b"], "x", 9)).toEqual(["a", "b", "x"]);
  });
});

describe("SessionRegistry.updateScreen", () => {
  const screen = (lines: string[]) => ({
    lines, styled: lines, cursor: { row: 0, col: 0 }, cols: 40, rows: lines.length, start: 0, historySize: 0,
  });

  it("emits updated only when the session itself changed, not for every screen change", async () => {
    const t = fakeTmux();
    const r = new SessionRegistry({ tmux: t.tmux, log: silentLogger, home: "/Users/me", isDirectory: () => true });
    const s = await r.create({ name: "a", cwd: "/Users/me", agent: "claude" });
    const seen: string[] = [];
    r.on("updated", (u) => seen.push(u.lastLine));

    expect(r.updateScreen(s.id, screen(["hello", "$"]))).toBe(true);
    expect(seen).toEqual(["$"]);

    // A spinner redraw: the screen changed, the last line did not, status is still working.
    expect(r.updateScreen(s.id, screen(["hello ✻", "$"]))).toBe(true);
    expect(r.updateScreen(s.id, screen(["hello ✽", "$"]))).toBe(true);
    expect(seen).toEqual(["$"]);

    expect(r.updateScreen(s.id, screen(["hello", "done"]))).toBe(true);
    expect(seen).toEqual(["$", "done"]);
  });
});
