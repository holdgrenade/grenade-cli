/** The design canvas (PROTOCOL.md "Canvas"): which folders are served, what a folder lists, one board, and the watch. */
import { mkdir, mkdtemp, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { computerWord } from "../src/platform/computer.js";
import { CANVAS_BOARD_MAX_BYTES, CANVAS_BOARDS_MAX, type Session } from "@grenade/protocol";
import { allowedCanvasCwd, canvasCwds, canvasFolderOf, normalizeCwd, sharedFolder } from "../src/canvas/canvasAccess.js";
import { boardsFrom, boardTooLarge, isBoardFile, listingKey } from "../src/canvas/boardListing.js";
import { CanvasError, listCanvas, readBoard } from "../src/canvas/canvasFolder.js";
import { CanvasWatcher, type Every } from "../src/canvas/canvasWatcher.js";
import { CanvasService } from "../src/canvas/canvasService.js";

const session = (id: string, cwd: string, group?: string): Session => ({
  id,
  name: id,
  agent: "claude",
  cwd,
  status: "idle",
  statusSince: "2026-10-04T10:00:00.000Z",
  lastLine: "",
  createdAt: "2026-10-04T10:00:00.000Z",
  ...(group ? { group } : {}),
});

describe("which canvases are served", () => {
  const home = "/Users/adam";
  const sessions = [
    session("gr-a", "/Users/adam/work/app/ios", "g-1"),
    session("gr-b", "/Users/adam/work/app/web", "g-1"),
    session("gr-c", "/Users/adam/notes"),
    session("gr-d", "/opt/tool", "g-2"),
    session("gr-e", "/var/other", "g-2"),
  ];

  it("normalizes a cwd: ~, dots and a trailing slash; nothing relative", () => {
    expect(normalizeCwd("~/work/app/", home)).toBe("/Users/adam/work/app");
    expect(normalizeCwd("/Users/adam/work/app/ios/../web/.", home)).toBe("/Users/adam/work/app/web");
    expect(normalizeCwd("work/app", home)).toBeNull();
  });

  it("finds the folder paths share by whole names", () => {
    expect(sharedFolder(["/a/bc/d", "/a/bc/e"])).toBe("/a/bc");
    expect(sharedFolder(["/a/bc", "/a/b"])).toBe("/a");
    expect(sharedFolder(["/a", "/b"])).toBeNull();
    expect(sharedFolder(["/a/b"])).toBe("/a/b");
  });

  it("serves each session's folder and the folder a group shares, never one above or beside them", () => {
    expect([...canvasCwds(sessions, home)].sort()).toEqual([
      "/Users/adam/notes",
      "/Users/adam/work/app",
      "/Users/adam/work/app/ios",
      "/Users/adam/work/app/web",
      "/opt/tool",
      "/var/other",
    ]);
    expect(allowedCanvasCwd("~/work/app", sessions, home)).toBe("/Users/adam/work/app");
    expect(allowedCanvasCwd("/Users/adam/notes/", sessions, home)).toBe("/Users/adam/notes");
    // A cwd that no session uses, the home folder, and the root that g-2 "shares".
    expect(allowedCanvasCwd("/Users/adam/secrets", sessions, home)).toBeNull();
    expect(allowedCanvasCwd("~", sessions, home)).toBeNull();
    expect(allowedCanvasCwd("/", sessions, home)).toBeNull();
    expect(allowedCanvasCwd("/Users/adam/work", sessions, home)).toBeNull();
    // Climbing out of an allowed folder lands on one that is not.
    expect(allowedCanvasCwd("/Users/adam/notes/../../..", sessions, home)).toBeNull();
    expect(allowedCanvasCwd("/Users/adam/notes/../work/app/ios", sessions, home)).toBe("/Users/adam/work/app/ios");
  });

  it("puts the canvas in .grenade/canvas", () => {
    expect(canvasFolderOf("/Users/adam/work/app")).toBe("/Users/adam/work/app/.grenade/canvas");
  });
});

describe("a board listing", () => {
  const file = (name: string, mtimeMs = 0, bytes = 10, head = "") => ({ file: name, mtimeMs, bytes, head });

  it("takes .html and .htm files that are not hidden, in Finder's order", () => {
    expect(isBoardFile("R3A · Cards.html")).toBe(true);
    expect(isBoardFile(".R3A.html")).toBe(false);
    expect(isBoardFile("notes.md")).toBe(false);
    const { boards } = boardsFrom([file("R10A · Late.html"), file("R2A · Early.htm"), file("picture.png"), file("Moodboard.HTML")]);
    expect(boards.map((b) => b.file)).toEqual(["Moodboard.HTML", "R2A · Early.htm", "R10A · Late.html"]);
  });

  it("reads each board's name, revision, letter and size", () => {
    const { boards } = boardsFrom([file("R3A · Cards.html", Date.parse("2026-10-04T10:02:11.000Z"), 24871, `<meta name="board" content="390x844">`)]);
    expect(boards).toEqual([{ file: "R3A · Cards.html", name: "Cards", revision: 3, letter: "A", width: 390, height: 844, modified: "2026-10-04T10:02:11.000Z", bytes: 24871 }]);
  });

  it("stops at the cap and says so", () => {
    const many = Array.from({ length: CANVAS_BOARDS_MAX + 3 }, (_, i) => file(`R${i + 1}A.html`));
    const { boards, truncated } = boardsFrom(many);
    expect(boards).toHaveLength(CANVAS_BOARDS_MAX);
    expect(truncated).toBe(true);
  });

  it("keys a listing by file, save time and size", () => {
    const a = boardsFrom([file("A.html", 1, 10)]);
    expect(listingKey(a)).toBe(listingKey(boardsFrom([file("A.html", 1, 10, "other head")])));
    expect(listingKey(a)).not.toBe(listingKey(boardsFrom([file("A.html", 2, 10)])));
    expect(listingKey(a)).not.toBe(listingKey(boardsFrom([file("A.html", 1, 11)])));
    expect(listingKey({ boards: [], missing: true })).not.toBe(listingKey({ boards: [] }));
  });

  it("says why a board is too large", () => {
    expect(boardTooLarge("R3A · Cards.html", CANVAS_BOARD_MAX_BYTES, 100)).toBeNull();
    expect(boardTooLarge("R3A · Cards.html", 3.4 * 1024 * 1024, 0)).toBe(`"R3A · Cards" is too large to show here (3.4 MB; at most 2 MB). Open it on the Mac.`);
    expect(boardTooLarge("R3A · Cards.html", 1000, 3_100_000, "computer")).toBe(`"R3A · Cards" is too large to show here (3.0 MB; at most 2 MB). Open it on the computer.`);
  });
});

describe("a canvas folder on disk", () => {
  let root: string;
  let folder: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "grenade-canvas-"));
    folder = join(root, "project", ".grenade", "canvas");
  });
  afterEach(() => rm(root, { recursive: true, force: true }));

  it("is missing until a session draws on it", async () => {
    await mkdir(join(root, "project"));
    expect(await listCanvas(folder)).toEqual({ boards: [], missing: true });
    await mkdir(folder, { recursive: true });
    expect(await listCanvas(folder)).toEqual({ boards: [] });
  });

  it("lists the boards and nothing else: no hidden file, no picture, no folder, no link", async () => {
    await mkdir(join(folder, "sub.html"), { recursive: true });
    await writeFile(join(folder, "R1A · Cards.html"), `<meta name="board" content="390x844"><h1>Cards</h1>`);
    await writeFile(join(folder, ".R1B · Hidden.html"), "x");
    await writeFile(join(folder, "shot.png"), "x");
    await writeFile(join(root, "secret.html"), "secret");
    await symlink(join(root, "secret.html"), join(folder, "R1C · Link.html"));
    const listing = await listCanvas(folder);
    expect(listing.boards.map((b) => [b.file, b.width, b.height, b.bytes])).toEqual([["R1A · Cards.html", 390, 844, Buffer.byteLength(`<meta name="board" content="390x844"><h1>Cards</h1>`)]]);
  });

  it("refuses a .grenade or a canvas folder that is a link", async () => {
    const elsewhere = join(root, "elsewhere");
    await mkdir(join(elsewhere, "canvas"), { recursive: true });
    await mkdir(join(root, "project"));
    await symlink(elsewhere, join(root, "project", ".grenade"));
    await expect(listCanvas(folder)).rejects.toBeInstanceOf(CanvasError);
    await rm(join(root, "project", ".grenade"));
    await mkdir(join(root, "project", ".grenade"));
    await symlink(join(elsewhere, "canvas"), folder);
    await expect(listCanvas(folder)).rejects.toBeInstanceOf(CanvasError);
    await expect(readBoard(folder, "R1A.html")).rejects.toBeInstanceOf(CanvasError);
  });

  it("reads one board, and only a board directly in the folder", async () => {
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, "R1A · Cards.html"), "<h1>Cards · ünïcode</h1>");
    await writeFile(join(root, "project", ".grenade", "outside.html"), "outside");
    await writeFile(join(root, "secret.html"), "secret");
    await symlink(join(root, "secret.html"), join(folder, "R1B · Link.html"));
    const board = await readBoard(folder, "R1A · Cards.html");
    expect(board.html).toBe("<h1>Cards · ünïcode</h1>");
    expect(board.bytes).toBe(Buffer.byteLength(board.html));
    for (const name of ["../outside.html", "../../../secret.html", "R1B · Link.html", "missing.html", ".hidden.html", "notes.txt", "sub/x.html"]) {
      await expect(readBoard(folder, name), name).rejects.toThrow(CanvasError);
    }
  });

  it("refuses a board over 2 MiB with a sentence", async () => {
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, "R1A · Huge.html"), Buffer.alloc(CANVAS_BOARD_MAX_BYTES + 1, 0x61));
    await expect(readBoard(folder, "R1A · Huge.html")).rejects.toThrow(`"R1A · Huge" is too large to show here (2.0 MB; at most 2 MB). Open it on the Mac.`);
  });
});

describe("watching a canvas", () => {
  let root: string;
  let folder: string;
  let ticks: (() => void)[];
  const every: Every = (fn) => {
    ticks.push(fn);
    return () => {
      ticks = ticks.filter((t) => t !== fn);
    };
  };
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "grenade-canvas-watch-"));
    folder = join(root, ".grenade", "canvas");
    ticks = [];
  });
  afterEach(() => rm(root, { recursive: true, force: true }));

  it("tells each subscriber of an added, saved or removed board, once, and stops polling when nobody watches", async () => {
    const watcher = new CanvasWatcher(every);
    const seen: string[][] = [];
    const other: string[][] = [];
    const stop = watcher.watch(folder, await listCanvas(folder), (l) => seen.push(l.missing ? ["missing"] : l.boards.map((b) => b.file)));
    const stopOther = watcher.watch(folder, await listCanvas(folder), (l) => other.push(l.boards.map((b) => b.file)));
    expect(ticks).toHaveLength(1);
    const look = () => watcher.look(folder);

    await look();
    expect(seen).toEqual([]);
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, "R1A · Cards.html"), "<h1>1</h1>");
    await look();
    expect(seen).toEqual([["R1A · Cards.html"]]);
    await look();
    expect(seen).toHaveLength(1);
    // Saved: a new time and size.
    await writeFile(join(folder, "R1A · Cards.html"), "<h1>one</h1>");
    await utimes(join(folder, "R1A · Cards.html"), new Date(), new Date(Date.now() + 5000));
    await look();
    expect(seen).toHaveLength(2);
    await rm(join(folder, "R1A · Cards.html"));
    await look();
    expect(seen.at(-1)).toEqual([]);
    expect(other).toEqual(seen);
    stopOther();
    expect(ticks).toHaveLength(1);
    stop();
    expect(ticks).toHaveLength(0);
    expect(watcher.size).toBe(0);
  });
});

describe("CanvasService", () => {
  it("refuses a cwd no session uses before it reads anything", async () => {
    const service = new CanvasService(() => [session("gr-a", "/Users/adam/app")], new CanvasWatcher(() => () => {}), "/Users/adam");
    await expect(service.list("/etc")).rejects.toThrow(`No session on this ${computerWord()} works in /etc, so it has no canvas to show.`);
    await expect(service.board("/Users/adam", "x.html")).rejects.toBeInstanceOf(CanvasError);
    await expect(service.watch("/Users/adam/app/..", () => {})).rejects.toBeInstanceOf(CanvasError);
  });
});
