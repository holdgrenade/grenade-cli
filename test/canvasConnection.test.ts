/** A Connection with a real CanvasService on a folder on disk: what a phone asks for and what it is told (PROTOCOL.md "Canvas"). */
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { computerWord } from "../src/platform/computer.js";
import { CANVAS_SUBSCRIPTIONS_MAX, DaemonFrame, type Session } from "@grenade/protocol";
import { Connection } from "../src/daemon/wsHandler.js";
import { silentLogger } from "../src/log.js";
import { CanvasService } from "../src/canvas/canvasService.js";
import { CanvasWatcher, type Every } from "../src/canvas/canvasWatcher.js";

const hello = JSON.stringify({ type: "hello", protocol: 1, token: "grt_t", client: { name: "Phone", platform: "test", version: "0.1.0" } });

class FakeRegistry extends EventEmitter {
  constructor(readonly sessions: Session[]) {
    super();
  }
  list() { return this.sessions; }
  get(id: string) { return this.sessions.find((s) => s.id === id); }
  unsubscribe() {}
}

let root: string;
let project: string;
let folder: string;
let ticks: (() => void)[];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "grenade-canvas-conn-"));
  project = join(root, "project");
  folder = join(project, ".grenade", "canvas");
  await mkdir(folder, { recursive: true });
  ticks = [];
});
afterEach(() => rm(root, { recursive: true, force: true }));

function connect() {
  const every: Every = (fn) => {
    ticks.push(fn);
    return () => {
      ticks = ticks.filter((t) => t !== fn);
    };
  };
  const watcher = new CanvasWatcher(every);
  const sessions: Session[] = [{ id: "gr-a", name: "a", agent: "claude", cwd: project, status: "idle", statusSince: "2026-10-04T10:00:00.000Z", lastLine: "", createdAt: "2026-10-04T10:00:00.000Z" }];
  const canvas = new CanvasService(() => sessions, watcher, root);
  const out: DaemonFrame[] = [];
  const conn = new Connection({
    registry: new FakeRegistry(sessions) as never,
    attachments: { save: async () => ({ path: "", bytes: 0 }) },
    isValidToken: () => true,
    sealed: true,
    route: "lan",
    canvas,
    daemon: { id: "d_1", name: "Mac", version: "0.1.0" },
    log: silentLogger,
    out: (f) => out.push(f),
    close: () => {},
    setTimer: () => 0,
    clearTimer: () => {},
  });
  const send = (frame: object) => conn.handleMessage(JSON.stringify(frame));
  const since = (n: number) => out.slice(n);
  return { conn, out, send, since, watcher };
}

describe("canvas on a connection", () => {
  it("lists the boards of a session's folder, and every frame it sends is a valid DaemonFrame", async () => {
    await writeFile(join(folder, "R2A · Cards.html"), `<meta name="board" content="390x844"><h1>Cards</h1>`);
    const { send, out } = connect();
    await send(JSON.parse(hello));
    out.length = 0;
    await send({ type: "canvas", id: "c_1", cwd: project });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ type: "canvas", id: "c_1", cwd: project, folder, boards: [{ file: "R2A · Cards.html", name: "Cards", revision: 2, letter: "A", width: 390, height: 844 }] });
    expect(DaemonFrame.safeParse(out[0]).success).toBe(true);

    await send({ type: "canvas.board", id: "c_2", cwd: project, file: "R2A · Cards.html" });
    expect(out[1]).toMatchObject({ type: "canvas.board", id: "c_2", cwd: project, file: "R2A · Cards.html", html: `<meta name="board" content="390x844"><h1>Cards</h1>` });
    expect(DaemonFrame.safeParse(out[1]).success).toBe(true);
  });

  it("refuses a cwd no session uses, with the request's id", async () => {
    const { send, out } = connect();
    await send(JSON.parse(hello));
    out.length = 0;
    await send({ type: "canvas", id: "c_1", cwd: root });
    await send({ type: "canvas.subscribe", id: "c_2", cwd: "/etc" });
    await send({ type: "canvas.board", id: "c_3", cwd: `${project}/..`, file: "x.html" });
    expect(out).toMatchObject([
      { type: "error", code: "bad_frame", ref: "canvas", id: "c_1" },
      { type: "error", code: "bad_frame", ref: "canvas.subscribe", id: "c_2", message: `No session on this ${computerWord()} works in /etc, so it has no canvas to show.` },
      { type: "error", code: "bad_frame", ref: "canvas.board", id: "c_3" },
    ]);
  });

  it("refuses a path in a board's name before the daemon sees it", async () => {
    const { send, out } = connect();
    await send(JSON.parse(hello));
    out.length = 0;
    await send({ type: "canvas.board", id: "c_1", cwd: project, file: "../../secret.html" });
    expect(out).toMatchObject([{ type: "error", code: "bad_frame" }]);
  });

  it("refuses a board whose frame would be too large once its text is escaped", async () => {
    // 1.6 MB of quotes is under 2 MiB on disk and 3.2 MB as JSON.
    await writeFile(join(folder, "R1A · Quotes.html"), '"'.repeat(1_600_000));
    const { send, out } = connect();
    await send(JSON.parse(hello));
    out.length = 0;
    await send({ type: "canvas.board", id: "c_1", cwd: project, file: "R1A · Quotes.html" });
    expect(out).toEqual([{ type: "error", code: "bad_frame", ref: "canvas.board", id: "c_1", message: `"R1A · Quotes" is too large to show here (3.1 MB; at most 2 MB). Open it on the ${computerWord()}.` }]);
  });

  it("sends the canvas again without an id when a board is written, until unsubscribed", async () => {
    const { send, since, out, watcher } = connect();
    await send(JSON.parse(hello));
    out.length = 0;
    await send({ type: "canvas.subscribe", id: "c_1", cwd: project });
    expect(out).toMatchObject([{ type: "canvas", id: "c_1", boards: [] }]);
    await watcher.look(folder);
    expect(out).toHaveLength(1);
    await writeFile(join(folder, "R1A · Cards.html"), "<h1>Cards</h1>");
    await watcher.look(folder);
    expect(since(1)).toHaveLength(1);
    expect(out[1]).not.toHaveProperty("id");
    expect(out[1]).toMatchObject({ type: "canvas", cwd: project, folder, boards: [{ file: "R1A · Cards.html" }] });
    await send({ type: "canvas.unsubscribe", cwd: project });
    expect(ticks).toHaveLength(0);
    await writeFile(join(folder, "R1B · Table.html"), "<h1>Table</h1>");
    await watcher.look(folder);
    expect(out).toHaveLength(2);
  });

  it("stops watching when the connection closes, and watches at most 8 canvases", async () => {
    const { conn, send, out } = connect();
    await send(JSON.parse(hello));
    out.length = 0;
    // Subscribing to the same cwd again replaces the watch.
    await send({ type: "canvas.subscribe", id: "c_0", cwd: project });
    await send({ type: "canvas.subscribe", id: "c_1", cwd: project });
    expect(ticks).toHaveLength(1);
    // Seven more spellings of the same folder fill the eight.
    for (let i = 1; i < CANVAS_SUBSCRIPTIONS_MAX; i++) await send({ type: "canvas.subscribe", id: `c_s${i}`, cwd: `${project}${"/.".repeat(i)}` });
    expect(out.filter((f) => f.type === "error")).toEqual([]);
    await send({ type: "canvas.subscribe", id: "c_9", cwd: `${project}/` });
    expect(out.at(-1)).toMatchObject({ type: "error", code: "bad_frame", ref: "canvas.subscribe", id: "c_9" });
    conn.handleClose();
    expect(ticks).toHaveLength(0);
  });
});
