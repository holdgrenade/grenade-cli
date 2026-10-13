import { mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ActivityEntry, Session } from "@grenade/protocol";
import { boardPlaceOf, boardsOfTurn, canvasEntriesOf, patchedFilesOf, workedDuring, writtenPathsOf, type BoardOnDisk } from "../src/canvas/boardSaves.js";
import { CanvasWork } from "../src/canvas/canvasWork.js";
import { ActivityStore } from "../src/activity/activityStore.js";
import { silentLogger } from "../src/log.js";

describe("boardPlaceOf", () => {
  it("finds a board directly in a group's canvas, or in the shared canvas, and nothing else", () => {
    expect(boardPlaceOf("/a/web/.grenade/canvas/g-1/canvas-2/R1A · Cards.html")).toEqual({ root: "/a/web", group: "g-1", canvas: "canvas-2", file: "R1A · Cards.html" });
    expect(boardPlaceOf("/a/web/.grenade/canvas/R1A.htm")).toEqual({ root: "/a/web", group: null, canvas: "shared", file: "R1A.htm" });
    expect(boardPlaceOf("/a/web/.grenade/canvas/g-1/canvas-2/../canvas-3/B.html")).toMatchObject({ canvas: "canvas-3", file: "B.html" });
    expect(boardPlaceOf("/a/web/.grenade/canvas/g-1/canvas-2/notes.md")).toBeNull();
    expect(boardPlaceOf("/a/web/.grenade/canvas/g-1/canvas-2/.hidden.html")).toBeNull();
    expect(boardPlaceOf("/a/web/.grenade/canvas/g-1/canvas-02/A.html")).toBeNull();
    expect(boardPlaceOf("/a/web/.grenade/canvas/g-1/canvas-2/sub/A.html")).toBeNull();
    expect(boardPlaceOf("/a/web/.grenade/canvas/g-1/A.html")).toBeNull();
    expect(boardPlaceOf("/a/web/src/index.html")).toBeNull();
    expect(boardPlaceOf("relative/.grenade/canvas/A.html")).toBeNull();
  });
});

describe("writtenPathsOf", () => {
  it("reads the file of a Write, Edit or MultiEdit after it ran, and the files of a Codex patch", () => {
    expect(writtenPathsOf("PostToolUse", "Write", { file_path: "/a/x.html" }, "/a")).toEqual(["/a/x.html"]);
    expect(writtenPathsOf("PostToolUse", "Edit", { file_path: "b/x.html" }, "/a")).toEqual(["/a/b/x.html"]);
    expect(writtenPathsOf("PostToolUse", "MultiEdit", { file_path: "/a/y.html" }, undefined)).toEqual(["/a/y.html"]);
    expect(writtenPathsOf("PreToolUse", "Write", { file_path: "/a/x.html" }, "/a")).toEqual([]);
    expect(writtenPathsOf("PostToolUse", "Read", { file_path: "/a/x.html" }, "/a")).toEqual([]);
    expect(writtenPathsOf("PostToolUse", "Edit", { file_path: "rel.html" }, undefined)).toEqual([]);
    const patch = "*** Begin Patch\n*** Add File: .grenade/canvas/g-1/canvas-1/R1A.html\n+<html>\n*** Update File: src/a.ts\n*** Move to: src/b.ts\n*** End Patch";
    expect(patchedFilesOf(patch)).toEqual([".grenade/canvas/g-1/canvas-1/R1A.html", "src/a.ts", "src/b.ts"]);
    expect(writtenPathsOf("PostToolUse", "apply_patch", { input: patch }, "/a")).toEqual(["/a/.grenade/canvas/g-1/canvas-1/R1A.html", "/a/src/a.ts", "/a/src/b.ts"]);
    expect(writtenPathsOf("PostToolUse", "apply_patch", { command: ["apply_patch", patch] }, "/a")).toHaveLength(3);
  });
});

describe("boardsOfTurn", () => {
  const disk = (path: string, mtimeMs: number, canvas = "canvas-1"): BoardOnDisk => ({ path, canvas, file: path.split("/").at(-1)!, mtimeMs, birthtimeMs: 0 });
  const turn = { start: 1_000_000, end: 1_100_000, hooked: new Map([["/c/B.html", 1_050_000]]), before: new Map([["/c/A.html", 900_000], ["/c/B.html", 900_000], ["/c/Old.html", 900_000]]) };
  const onDisk = [disk("/c/A.html", 1_020_000), disk("/c/B.html", 1_060_000), disk("/c/New.html", 1_010_000), disk("/c/Old.html", 900_000)];

  it("takes the boards hooks named, and those saved in the turn by a script, in the order first saved", () => {
    expect(boardsOfTurn(turn, onDisk, false).map((b) => [b.file, b.new])).toEqual([["New.html", true], ["A.html", false], ["B.html", false]]);
  });
  it("leaves a board no hook named to nobody when another session of the group worked during the turn", () => {
    expect(boardsOfTurn(turn, onDisk, true).map((b) => b.file)).toEqual(["B.html"]);
  });
  it("without the turn's start, takes only what hooks named, new by when the file was made", () => {
    const b = { ...disk("/c/B.html", 1_060_000), birthtimeMs: 1_040_000 };
    expect(boardsOfTurn({ ...turn, before: null }, [...onDisk.filter((x) => x.file !== "B.html"), b], false).map((x) => [x.file, x.new])).toEqual([["B.html", true]]);
  });
  it("leaves out a named board that is gone, and one a script saved outside the turn", () => {
    expect(boardsOfTurn(turn, [disk("/c/A.html", 1_300_000)], false)).toEqual([]);
  });
  it("tells whether a session worked during a time", () => {
    expect(workedDuring([{ from: 10, to: 20 }], 15, 30)).toBe(true);
    expect(workedDuring([{ from: 10, to: 20 }], 21, 30)).toBe(false);
    expect(workedDuring([{ from: 25, to: null }], 0, 30)).toBe(true);
    expect(workedDuring([], 0, 30)).toBe(false);
  });
});

describe("canvasEntriesOf", () => {
  const ctx = { cwd: "/w", group: "g-1", at: "2026-10-12T10:00:00.000Z", nameOf: (c: string) => (c === "canvas-1" ? "Row numbers" : "Jobs"), titleOf: (p: string) => p.split("/").at(-1)!.replace(".html", "") };
  const saved = (file: string, firstAt: number, isNew: boolean, canvas = "canvas-1") => ({ path: `/w/${canvas}/${file}`, canvas, file, firstAt, mtimeMs: firstAt, new: isNew });

  it("makes one entry per canvas, in the order first saved, new boards first, with the words", () => {
    const entries = canvasEntriesOf([saved("R1C.html", 3, false), saved("R2A.html", 1, true), saved("J.html", 2, true, "canvas-2"), saved("R2B.html", 4, true)], ctx);
    expect(entries).toEqual([
      { kind: "canvas", text: "Drew 2 boards and changed 1 on Row numbers", at: ctx.at, cwd: "/w", group: "g-1", canvas: "canvas-1", name: "Row numbers",
        boards: [{ file: "R2A.html", title: "R2A", new: true }, { file: "R2B.html", title: "R2B", new: true }, { file: "R1C.html", title: "R1C", new: false }] },
      { kind: "canvas", text: "Drew 1 board on Jobs", at: ctx.at, cwd: "/w", group: "g-1", canvas: "canvas-2", name: "Jobs", boards: [{ file: "J.html", title: "J", new: true }] },
    ]);
    expect(canvasEntriesOf([saved("A.html", 1, false), saved("B.html", 2, false)], ctx)[0]!.text).toBe("Changed 2 boards on Row numbers");
  });
  it("lists the 20 saved last and counts them all", () => {
    const many = Array.from({ length: 25 }, (_, i) => saved(`R${i + 1}A.html`, i, true));
    const [entry] = canvasEntriesOf(many, ctx);
    expect(entry!.text).toBe("Drew 25 boards on Row numbers");
    expect(entry!.boards).toHaveLength(20);
    expect(entry!.boards![0]!.file).toBe("R6A.html");
  });
});

describe("ActivityStore.noteCanvas", () => {
  const e = (kind: ActivityEntry["kind"], at: string): ActivityEntry => ({ kind, text: kind, at });
  const card = (at: string): ActivityEntry => ({ kind: "canvas", text: "Drew 1 board on X", at, group: "g-1", canvas: "canvas-1", cwd: "/w", name: "X", boards: [{ file: "A.html", title: "A", new: true }] });

  it("goes after the turn, as new entries", () => {
    const s = new ActivityStore();
    const frames: unknown[] = [];
    s.on("activity", (f) => frames.push(f));
    s.append("gr-a", [e("asked", "2026-10-12T10:00:00.000Z"), e("said", "2026-10-12T10:01:00.000Z")]);
    s.noteCanvas("gr-a", [card("2026-10-12T10:02:00.000Z")], Date.parse("2026-10-12T10:00:00.000Z"));
    expect(s.entriesOf("gr-a").map((x) => x.kind)).toEqual(["asked", "said", "canvas"]);
    expect(frames.at(-1)).toEqual({ type: "activity", sessionId: "gr-a", entries: [card("2026-10-12T10:02:00.000Z")] });
  });
  it("goes before a push of the turn that came after its last words, no later than it, and the whole list is sent", () => {
    const s = new ActivityStore();
    const frames: { full?: true }[] = [];
    s.on("activity", (f) => frames.push(f));
    s.append("gr-a", [e("asked", "2026-10-12T10:00:00.000Z"), e("said", "2026-10-12T10:01:00.000Z")]);
    s.notePush("gr-a", e("push", "2026-10-12T10:01:30.000Z"));
    s.noteCanvas("gr-a", [card("2026-10-12T10:02:00.000Z")], Date.parse("2026-10-12T10:00:00.000Z"));
    expect(s.entriesOf("gr-a").map((x) => [x.kind, x.at])).toEqual([
      ["asked", "2026-10-12T10:00:00.000Z"], ["said", "2026-10-12T10:01:00.000Z"], ["canvas", "2026-10-12T10:01:30.000Z"], ["push", "2026-10-12T10:01:30.000Z"],
    ]);
    expect(frames.at(-1)!.full).toBe(true);
  });
  it("never goes before a push of an earlier turn", () => {
    const s = new ActivityStore();
    s.append("gr-a", [e("said", "2026-10-12T09:00:00.000Z")]);
    s.notePush("gr-a", e("push", "2026-10-12T09:01:00.000Z"));
    s.noteCanvas("gr-a", [card("2026-10-12T10:02:00.000Z")], Date.parse("2026-10-12T10:00:00.000Z"));
    expect(s.entriesOf("gr-a").map((x) => x.kind)).toEqual(["said", "push", "canvas"]);
  });
});

describe("CanvasWork", () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function setup() {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "grenade-canvaswork-")));
    const canvas = join(dir, ".grenade", "canvas", "g-1", "canvas-2");
    mkdirSync(canvas, { recursive: true });
    const sessions = new Map<string, Session>();
    const add = (id: string, status: Session["status"] = "idle") => {
      const s = { id, name: id, agent: "claude", cwd: dir, status, statusSince: new Date(clock).toISOString(), lastLine: "", createdAt: "2026-10-12T09:00:00.000Z", group: "g-1" } as Session;
      sessions.set(id, s);
      return s;
    };
    let clock = Date.parse("2026-10-12T10:00:00.000Z");
    const noted: { id: string; entries: ActivityEntry[] }[] = [];
    const work = new CanvasWork({
      registry: { get: (id) => sessions.get(id), list: () => [...sessions.values()] },
      activity: { noteCanvas: (id, entries) => noted.push({ id, entries }) },
      home: dir,
      log: silentLogger,
      now: () => clock,
    });
    const set = (id: string, status: Session["status"], waitingFor?: Session["waitingFor"]) => {
      const s = { ...sessions.get(id)!, status, ...(waitingFor ? { waitingFor } : {}) } as Session;
      sessions.set(id, s);
      work.statusChanged(s);
    };
    const save = (file: string, html: string) => {
      const path = join(canvas, file);
      writeFileSync(path, html);
      utimesSync(path, new Date(clock), new Date(clock));
      return path;
    };
    const tick = (ms: number) => { clock += ms; };
    return { canvas, add, set, save, tick, noted, work };
  }

  it("ends a turn with a card of the boards its hooks wrote and those it saved alone, and keeps them for Command Center", async () => {
    const { add, set, save, tick, noted, work, canvas } = setup();
    add("gr-a");
    save("R1A · Today.html", "<title>Row numbers</title>");
    tick(60_000);
    set("gr-a", "working");
    await new Promise((r) => setTimeout(r, 20));
    tick(5_000);
    const path = save("R2A · Day.html", "<title>Numbers that carry their day</title>");
    work.hook("gr-a", "PostToolUse", "Write", { file_path: path }, dir);
    tick(5_000);
    save("R1A · Today.html", "<title>Row numbers</title><p>again");
    tick(5_000);
    set("gr-a", "waiting", "answer");
    tick(5_000);
    set("gr-a", "working");
    tick(5_000);
    set("gr-a", "waiting", "done");
    await work.settled();
    expect(noted).toEqual([{ id: "gr-a", entries: [{
      kind: "canvas", text: "Drew 1 board and changed 1 on Row numbers", at: new Date(Date.parse("2026-10-12T10:01:25.000Z")).toISOString(), cwd: dir, group: "g-1", canvas: "canvas-2", name: "Row numbers",
      boards: [{ file: "R2A · Day.html", title: "R2A · Numbers that carry their day", new: true }, { file: "R1A · Today.html", title: "R1A · Row numbers", new: false }],
    }] }]);
    const kept = work.savedBoards("gr-a", Date.parse("2026-10-12T10:01:00.000Z"), Date.parse("2026-10-12T10:02:00.000Z"));
    expect(kept.map((b) => [b.file, b.canvas, b.group, b.cwd, b.folder])).toEqual([["R2A · Day.html", "canvas-2", "g-1", dir, canvas], ["R1A · Today.html", "canvas-2", "g-1", dir, canvas]]);
  });

  it("says a turn drew while it works and after it ends, until the next turn starts", async () => {
    const { add, set, save, tick, work } = setup();
    add("gr-a");
    set("gr-a", "working");
    expect(work.drawing("gr-a")).toBe(false);
    const path = save("R1A · Drawn.html", "<title>Drawn</title>");
    work.hook("gr-a", "PostToolUse", "Write", { file_path: path }, dir);
    expect(work.drawing("gr-a")).toBe(true);
    tick(5_000);
    set("gr-a", "waiting", "done");
    expect(work.drawing("gr-a")).toBe(true);
    set("gr-a", "working");
    expect(work.drawing("gr-a")).toBe(false);
    set("gr-a", "waiting", "done");
    await work.settled();
  });

  it("gives a board no hook named to nobody while another session of the group worked", async () => {
    const { add, set, save, tick, noted, work } = setup();
    add("gr-a");
    add("gr-b");
    set("gr-a", "working");
    set("gr-b", "working");
    await new Promise((r) => setTimeout(r, 20));
    tick(5_000);
    save("R1A · Script.html", "<title>By a script</title>");
    const path = save("R1B · Hooked.html", "<title>Hooked</title>");
    work.hook("gr-a", "PostToolUse", "Edit", { file_path: path }, dir);
    tick(5_000);
    set("gr-b", "idle");
    set("gr-a", "waiting", "done");
    await work.settled();
    expect(noted.map((n) => [n.id, n.entries.map((e) => e.boards!.map((b) => b.file))])).toEqual([["gr-a", [["R1B · Hooked.html"]]]]);
    expect(work.savedBoards("gr-b", 0, Date.now() * 2)).toEqual([]);
  });

  it("adds nothing for a turn that saved no board", async () => {
    const { add, set, tick, noted, work } = setup();
    add("gr-a");
    set("gr-a", "working");
    tick(5_000);
    set("gr-a", "idle");
    await work.settled();
    expect(noted).toEqual([]);
  });
});
