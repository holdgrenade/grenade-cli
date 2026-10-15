import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { KeptGroup, Session, SessionPlan } from "@grenade/protocol";
import { canvasItem, cwdIn, groupStateOf, libraryList, planFilesIn, revisionsOf } from "../src/library/libraryItems.js";
import { LibraryError, LibraryStore } from "../src/library/libraryStore.js";
import { silentLogger } from "../src/log.js";

const at = "2026-10-14T10:00:00.000Z";
const s = (id: string, group: string, cwd: string, extra: Partial<Session> = {}): Session => ({
  id,
  name: id,
  agent: "claude",
  cwd,
  status: "idle",
  statusSince: at,
  lastLine: "",
  createdAt: at,
  group,
  ...extra,
});

class FakeRegistry extends EventEmitter<{ updated: [Session] }> {
  sessions: Session[] = [];
  list(): Session[] {
    return this.sessions;
  }
  set(session: Session): void {
    this.sessions = [...this.sessions.filter((x) => x.id !== session.id), session];
    this.emit("updated", session);
  }
}

class FakePlans extends EventEmitter<{ plan: [string, SessionPlan | undefined] }> {
  paths = new Map<string, string>();
  pathOf(id: string): string | undefined {
    return this.paths.get(id);
  }
}

function setUp() {
  const root = mkdtempSync(join(tmpdir(), "grenade-library-"));
  const claudeDir = join(root, "claude");
  const project = join(root, "web");
  mkdirSync(join(claudeDir, "plans"), { recursive: true });
  const canvas = join(project, ".grenade", "canvas", "g-1", "canvas-1");
  mkdirSync(canvas, { recursive: true });
  writeFileSync(join(canvas, "R1A · Cards.html"), "<title>Pricing page</title>");
  writeFileSync(join(canvas, "R2A · Cards.html"), "<title>Later</title>");
  writeFileSync(join(canvas, "R2B · Table.html"), "x");
  const registry = new FakeRegistry();
  const plans = new FakePlans();
  const kept: KeptGroup[] = [];
  const keptListeners: (() => void)[] = [];
  const store = (path = join(root, "library.json")) =>
    new LibraryStore({ registry, kept: () => kept, onKeptChanged: (cb) => keptListeners.push(cb), plans, claudeDir, home: root, log: silentLogger, path });
  return { root, claudeDir, project, canvas, registry, plans, kept, store };
}

describe("libraryItems", () => {
  it("counts each revision once and the boards without one as one more", () => {
    expect(revisionsOf(["R1A · a.html", "R1B · b.html", "R2A · c.html", "notes.html", "old.html"])).toBe(3);
  });

  it("says where a group stands: live, kept, or gone with the name it had", () => {
    const now = {
      sessions: [s("gr-a", "g-1", "/w", { groupName: "Web" }), s("gr-b", "g-2", "/w", { status: "gone", groupName: "Old" })],
      kept: [{ group: "g-3", cwd: "/w", name: "Kept" }],
      remembered: new Map([["g-4", { group: "g-4", cwd: "/w", name: "Gone" }]]),
    };
    expect(groupStateOf("g-1", now)).toEqual({ groupState: "live", groupName: "Web" });
    expect(groupStateOf("g-2", now)).toEqual({ groupState: "gone", groupName: "Old" });
    expect(groupStateOf("g-3", now)).toEqual({ groupState: "kept", groupName: "Kept" });
    expect(groupStateOf("g-4", now)).toEqual({ groupState: "gone", groupName: "Gone" });
    expect(groupStateOf("g-5", now)).toEqual({ groupState: "gone" });
  });

  it("lists newest first", () => {
    const now = { sessions: [], kept: [], remembered: new Map() };
    const older = canvasItem({ folder: "/w/a", cwd: "/w", canvas: "canvas-1", title: "A", files: ["a.html"], modifiedMs: 1 }, now);
    const newer = canvasItem({ folder: "/w/b", cwd: "/w", canvas: "canvas-2", title: "B", files: ["b.html"], modifiedMs: 2 }, now);
    expect(libraryList([older, newer]).items.map((i) => i.title)).toEqual(["B", "A"]);
  });

  it("finds plan files and the folder in a transcript line", () => {
    const line = JSON.stringify({ cwd: "/Users/ada/code/web", message: { content: "wrote /Users/ada/.claude/plans/velvety-knitting-shell.md and /tmp/plans/x.md" } });
    expect(planFilesIn(line, "/Users/ada/.claude/plans")).toEqual(["velvety-knitting-shell.md"]);
    expect(cwdIn(line)).toBe("/Users/ada/code/web");
  });
});

describe("LibraryStore", () => {
  it("lists a gone group's canvas with the name it had, and serves its folder", async () => {
    const { registry, project, store } = setUp();
    registry.set(s("gr-a", "g-1", project, { groupName: "Website" }));
    const library = store();
    registry.set(s("gr-a", "g-1", project, { groupName: "Website", status: "gone" }));
    registry.sessions = [];
    const { items } = await library.frame("l-1");
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "canvas", title: "Pricing page", cwd: project, group: "g-1", groupName: "Website", groupState: "gone", canvas: "canvas-1", boards: 3, revisions: 2 });
    expect(library.standIns().some((x) => x.group === "g-1" && x.cwd === project)).toBe(true);
    library.stop();
  });

  it("keeps a session's plan, approves it when the agent leaves plan mode, and reads it", async () => {
    const { claudeDir, registry, plans, project, store } = setUp();
    const path = join(claudeDir, "plans", "velvety-knitting-shell.md");
    writeFileSync(path, "# Move the docs\n\nEvery page into a collection.\n");
    const library = store();
    registry.set(s("gr-a", "g-1", project, { title: "docs-move", plan: { file: "velvety-knitting-shell.md", planning: true, writing: false } }));
    plans.paths.set("gr-a", path);
    plans.emit("plan", "gr-a", { file: "velvety-knitting-shell.md", planning: true, writing: false });
    let plan = (await library.frame()).items.find((i) => i.kind === "plan");
    expect(plan).toMatchObject({ title: "Move the docs", preview: "Every page into a collection.", planState: "planning", session: "docs-move", group: "g-1", groupState: "live" });
    registry.set(s("gr-a", "g-1", project, { title: "docs-move", plan: { file: "velvety-knitting-shell.md", planning: false, writing: false } }));
    plans.emit("plan", "gr-a", { file: "velvety-knitting-shell.md", planning: false, writing: false });
    plan = (await library.frame()).items.find((i) => i.kind === "plan");
    expect(plan?.planState).toBe("approved");
    expect((await library.plan("velvety-knitting-shell.md", "p-1")).text).toContain("Every page");
    await expect(library.plan("other.md")).rejects.toBeInstanceOf(LibraryError);
    library.stop();
    // What it keeps outlives a restart.
    const again = store();
    expect((await again.frame()).items.find((i) => i.kind === "plan")?.planState).toBe("approved");
    again.stop();
  });

  it("finds old plans in past conversations once", async () => {
    const { claudeDir, project, root, store } = setUp();
    writeFileSync(join(claudeDir, "plans", "old-plan.md"), "## Old plan\nText");
    const conversations = join(claudeDir, "projects", "-web");
    mkdirSync(conversations, { recursive: true });
    const line = JSON.stringify({ cwd: project, message: `Plan written to ${join(claudeDir, "plans", "old-plan.md")}` });
    writeFileSync(join(conversations, "a.jsonl"), `${line}\n`);
    const library = store();
    await library.backfill();
    const plan = (await library.frame()).items.find((i) => i.kind === "plan");
    expect(plan).toMatchObject({ title: "Old plan", cwd: project });
    expect(plan?.planState).toBeUndefined();
    library.stop();
    expect(JSON.parse(readFileSync(join(root, "library.json"), "utf8")).backfilled).toBe(true);
  });
});

describe("LibraryStore, starting again", () => {
  it("lets a session start in a remembered group that no session has, carrying its name", async () => {
    const { registry, project, store } = setUp();
    registry.set(s("gr-a", "g-1", project, { groupName: "Website" }));
    const library = store();
    expect(library.rememberedGroup("g-1")).toBeUndefined();
    registry.sessions = [];
    expect(library.rememberedGroup("g-1")).toEqual({ name: "Website" });
    expect(library.rememberedGroup("g-9")).toBeUndefined();
    library.stop();
  });
});
