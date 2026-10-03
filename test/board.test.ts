import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BOARD_DEBOUNCE_MS,
  BOARD_MIN_INTERVAL_MS,
  BOARD_QUIET_END_MS,
  BoardPushRequest,
  boardStateFor,
  type BoardRegisterFrame,
  type BoardState,
  type Session,
} from "@grenade/protocol";
import { deviceIdFor } from "../src/daemon/pairing.js";
import type { LogData, Logger } from "../src/log.js";
import { BoardDevices } from "../src/push/boardDevices.js";
import { afterTry, boardAlert, boardKey, boardStep, newTrack, observe } from "../src/push/boardPolicy.js";
import { BoardPusher } from "../src/push/boardPusher.js";
import type { PushGateway } from "../src/push/pushConfig.js";
import type { PushResult } from "../src/push/pushGateway.js";

const fixture = JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "grenade-protocol", "fixtures", "board.examples.json"), "utf8")) as {
  token: string;
  sessions: Array<Pick<Session, "id" | "status" | "waitingFor" | "statusSince">>;
  keys: Record<string, string>;
  state: BoardState;
  request: BoardPushRequest;
};
const TOKEN = fixture.token;
const DEVICE = deviceIdFor(TOKEN);

const empty: BoardState = { v: 1, sessions: [] };
const board = (...s: BoardState["sessions"]): BoardState => ({ v: 1, sessions: s });
const working = board({ k: "0000000000000001", s: "working", t: 1 });
const asking = board({ k: "0000000000000001", s: "answer", t: 2 });
const idle = board({ k: "0000000000000001", s: "idle", t: 3 });

describe("board keys and state", () => {
  it("reproduces fixtures/board.examples.json", () => {
    for (const [id, key] of Object.entries(fixture.keys)) expect(boardKey(TOKEN, id)).toBe(key);
    const sessions = fixture.sessions.map((s) => ({ id: s.id, status: s.status, statusSince: s.statusSince, ...(s.waitingFor ? { waitingFor: s.waitingFor } : {}) }));
    expect(boardStateFor(sessions, (id) => boardKey(TOKEN, id))).toEqual(fixture.state);
    expect(BoardPushRequest.parse(fixture.request)).toEqual(fixture.request);
  });

  it("a key depends on the pairing token", () => {
    expect(boardKey("grt_other", "gr-grenade-cli")).not.toBe(fixture.keys["gr-grenade-cli"]);
  });
});

describe("boardStep", () => {
  const t0 = 1_000_000;

  it("a change waits BOARD_DEBOUNCE_MS from when it was first seen", () => {
    let track = observe(newTrack(working, t0), asking, t0);
    expect(boardStep(track, t0)).toEqual({ action: "none", wakeAt: t0 + BOARD_DEBOUNCE_MS });
    track = observe(track, board(...asking.sessions, { k: "0000000000000002", s: "working", t: 4 }), t0 + 1000);
    expect(boardStep(track, t0 + BOARD_DEBOUNCE_MS - 1)).toEqual({ action: "none", wakeAt: t0 + BOARD_DEBOUNCE_MS });
    expect(boardStep(track, t0 + BOARD_DEBOUNCE_MS)).toEqual({ action: "update" });
  });

  it("a change undone before it was pushed pushes nothing", () => {
    const track = observe(observe(newTrack(working, t0), asking, t0), working, t0 + 500);
    expect(boardStep(track, t0 + BOARD_DEBOUNCE_MS)).toEqual({ action: "none" });
  });

  it("never two pushes closer than BOARD_MIN_INTERVAL_MS", () => {
    let track = afterTry(observe(newTrack(working, t0), asking, t0), asking, t0 + BOARD_DEBOUNCE_MS, "sent");
    track = observe(track, working, t0 + BOARD_DEBOUNCE_MS + 100);
    expect(boardStep(track, t0 + BOARD_DEBOUNCE_MS * 2 + 100)).toEqual({ action: "none", wakeAt: t0 + BOARD_DEBOUNCE_MS + BOARD_MIN_INTERVAL_MS });
    expect(boardStep(track, t0 + BOARD_DEBOUNCE_MS + BOARD_MIN_INTERVAL_MS)).toEqual({ action: "update" });
  });

  it("a push that could not reach the route is tried once more, then waits for the next change", () => {
    let track = afterTry(observe(newTrack(working, t0), asking, t0), asking, t0 + 2000, "retry");
    expect(boardStep(observe(track, asking, t0 + 3000), t0 + 7000)).toEqual({ action: "update" });
    track = afterTry(observe(track, asking, t0 + 7000), asking, t0 + 7000, "retry");
    expect(boardStep(observe(track, asking, t0 + 20_000), t0 + 20_000)).toEqual({ action: "none" });
  });

  it("ends after BOARD_QUIET_END_MS with nothing but idle sessions, and a working session stops the clock", () => {
    let track = observe(newTrack(working, t0), idle, t0);
    track = afterTry(track, idle, t0 + BOARD_DEBOUNCE_MS, "sent");
    expect(boardStep(observe(track, idle, t0 + 60_000), t0 + 60_000)).toEqual({ action: "none", wakeAt: t0 + BOARD_QUIET_END_MS });
    expect(boardStep(observe(track, idle, t0 + BOARD_QUIET_END_MS), t0 + BOARD_QUIET_END_MS)).toEqual({ action: "end" });
    expect(observe(track, working, t0 + 60_000).quietSince).toBeNull();
    expect(observe(newTrack(empty, t0), empty, t0 + 1).quietSince).toBe(t0);
  });
});

describe("boardAlert", () => {
  it("alerts for a session that newly needs an answer, unless someone is at the Mac", () => {
    expect(boardAlert(working, asking, false)).toBe(true);
    expect(boardAlert(working, asking, true)).toBe(false);
    expect(boardAlert(asking, asking, false)).toBe(false);
    expect(boardAlert(asking, working, false)).toBe(false);
    expect(boardAlert(null, asking, false)).toBe(true);
  });
});

// ---- BoardPusher, with fake timers ---------------------------------------------

class FakeRegistry extends EventEmitter {
  sessions: Session[] = [];
  list() { return this.sessions; }
  set(s: Session) {
    const i = this.sessions.findIndex((x) => x.id === s.id);
    if (i === -1) this.sessions.push(s);
    else this.sessions[i] = s;
    this.emit("updated", s);
  }
}

function collectingLogger(): Logger & { lines: string[] } {
  const lines: string[] = [];
  const write = (m: string, d?: LogData) => void lines.push(`${m} ${JSON.stringify(d ?? {})}`);
  return { lines, debug: write, info: write, warn: write, error: write, close() {} };
}

const session = (id: string, status: Session["status"], waitingFor?: Session["waitingFor"]): Session => ({
  id,
  name: id,
  agent: "claude",
  cwd: "/tmp",
  status,
  ...(waitingFor ? { waitingFor } : {}),
  statusSince: new Date(Date.now()).toISOString(),
  lastLine: "",
  createdAt: "2026-10-03T08:00:00.000Z",
});

const frame: BoardRegisterFrame = { type: "board.register", provider: "apns", pushToken: fixture.request.pushToken, environment: "production", topic: "com.holdgrenade.grenade" };

function setup(opts: { gateway?: PushGateway | null; answers?: PushResult[]; boardsPath?: string; atMac?: boolean } = {}) {
  const registry = new FakeRegistry();
  const posts: BoardPushRequest[] = [];
  const answers = [...(opts.answers ?? [])];
  const log = collectingLogger();
  const paired = { value: true };
  const atMac = { value: opts.atMac ?? false };
  const boards = new BoardDevices(opts.boardsPath);
  const pusher = new BoardPusher({
    registry,
    boards,
    paired: () => (paired.value ? [{ id: DEVICE, token: TOKEN }] : []),
    gateway: () => (opts.gateway === undefined ? { url: "https://relay.example.com" } : opts.gateway),
    atMac: async () => atMac.value,
    log,
    post: async (_gateway, request) => {
      posts.push(BoardPushRequest.parse(request));
      return answers.shift() ?? { outcome: "sent", status: 200 };
    },
  });
  pusher.start();
  return { registry, pusher, posts, log, paired, atMac, boards, wait: (ms: number) => vi.advanceTimersByTimeAsync(ms) };
}

describe("BoardPusher", () => {
  beforeEach(() => void vi.useFakeTimers({ now: Date.parse("2026-10-03T09:00:00.000Z") }));
  afterEach(() => void vi.useRealTimers());

  it("answers board.register with board.state and pushes nothing until the board changes", async () => {
    const t = setup();
    t.registry.set(session("gr-a", "working"));
    expect(t.pusher.register(TOKEN, frame)).toEqual({ type: "board.state", registered: true, delivery: "gateway" });
    await t.wait(60_000);
    expect(t.posts).toEqual([]);
  });

  it("reproduces the fixture's board push: keys, statuses, times, alert", async () => {
    // The push leaves at the fixture's `at`: the change is seen BOARD_DEBOUNCE_MS before.
    vi.setSystemTime(fixture.request.at * 1000 - BOARD_DEBOUNCE_MS);
    const t = setup();
    t.pusher.register(TOKEN, frame);
    for (const s of fixture.sessions) t.registry.set({ ...session(s.id, s.status, s.waitingFor), statusSince: s.statusSince });
    await t.wait(BOARD_DEBOUNCE_MS);
    expect(t.posts).toEqual([fixture.request]);
  });

  it("waits BOARD_DEBOUNCE_MS so a burst is one push, and alerts for a new question", async () => {
    const t = setup();
    t.registry.set(session("gr-a", "working"));
    t.pusher.register(TOKEN, frame);
    t.registry.set(session("gr-a", "waiting", "answer"));
    await t.wait(1000);
    t.registry.set(session("gr-b", "working"));
    await t.wait(BOARD_DEBOUNCE_MS - 1001);
    expect(t.posts).toEqual([]);
    await t.wait(1);
    expect(t.posts).toHaveLength(1);
    expect(t.posts[0]).toMatchObject({ kind: "board", event: "update", alert: true });
    expect(t.posts[0]!.state.sessions.map((e) => e.s)).toEqual(["answer", "working"]);
  });

  it("never sends two pushes less than BOARD_MIN_INTERVAL_MS apart", async () => {
    const t = setup();
    t.registry.set(session("gr-a", "working"));
    t.pusher.register(TOKEN, frame);
    t.registry.set(session("gr-a", "waiting", "done"));
    await t.wait(BOARD_DEBOUNCE_MS);
    expect(t.posts).toHaveLength(1);
    t.registry.set(session("gr-a", "working"));
    await t.wait(BOARD_MIN_INTERVAL_MS - 1);
    expect(t.posts).toHaveLength(1);
    await t.wait(1);
    expect(t.posts).toHaveLength(2);
    expect(t.posts[1]).toMatchObject({ event: "update", alert: false });
  });

  it("someone at the Mac holds the alert, never the push", async () => {
    const t = setup({ atMac: true });
    t.registry.set(session("gr-a", "working"));
    t.pusher.register(TOKEN, frame);
    t.registry.set(session("gr-a", "waiting", "answer"));
    await t.wait(BOARD_DEBOUNCE_MS);
    expect(t.posts).toHaveLength(1);
    expect(t.posts[0]).toMatchObject({ event: "update", alert: false });
  });

  it("ends once after BOARD_QUIET_END_MS of nothing but idle sessions, and forgets the board", async () => {
    const t = setup();
    t.registry.set(session("gr-a", "working"));
    t.pusher.register(TOKEN, frame);
    t.registry.set(session("gr-a", "idle"));
    await t.wait(BOARD_DEBOUNCE_MS);
    expect(t.posts.map((p) => p.event)).toEqual(["update"]);
    await t.wait(BOARD_QUIET_END_MS - BOARD_DEBOUNCE_MS - 1);
    expect(t.posts).toHaveLength(1);
    await t.wait(1);
    expect(t.posts.map((p) => p.event)).toEqual(["update", "end"]);
    expect(t.posts[1]!.alert).toBe(false);
    expect(t.boards.list()).toEqual([]);
    t.registry.set(session("gr-a", "working"));
    await t.wait(60_000);
    expect(t.posts).toHaveLength(2);
  });

  it("a working session stops the quiet clock", async () => {
    const t = setup();
    t.registry.set(session("gr-a", "idle"));
    t.pusher.register(TOKEN, frame);
    await t.wait(BOARD_QUIET_END_MS - 1000);
    t.registry.set(session("gr-a", "working"));
    await t.wait(BOARD_QUIET_END_MS);
    expect(t.posts.map((p) => p.event)).toEqual(["update"]);
  });

  it("forgets the board when the route answers 410", async () => {
    const t = setup({ answers: [{ outcome: "unregistered", status: 410, error: "unregistered" }] });
    t.registry.set(session("gr-a", "working"));
    t.pusher.register(TOKEN, frame);
    t.registry.set(session("gr-a", "waiting", "done"));
    await t.wait(BOARD_DEBOUNCE_MS);
    expect(t.boards.list()).toEqual([]);
    t.registry.set(session("gr-a", "working"));
    await t.wait(60_000);
    expect(t.posts).toHaveLength(1);
  });

  it("an answer it does not know is a failure: the board is not counted as sent", async () => {
    const t = setup({ answers: [{ outcome: "refused", status: 418, error: "http_418" }] });
    t.registry.set(session("gr-a", "working"));
    t.pusher.register(TOKEN, frame);
    t.registry.set(session("gr-a", "waiting", "answer"));
    await t.wait(BOARD_DEBOUNCE_MS);
    t.registry.set(session("gr-b", "working"));
    await t.wait(BOARD_MIN_INTERVAL_MS);
    // The question was never delivered, so the next push still alerts for it.
    expect(t.posts.map((p) => p.alert)).toEqual([true, true]);
  });

  it("with push off says delivery off and sends nothing", async () => {
    const t = setup({ gateway: null });
    t.registry.set(session("gr-a", "working"));
    expect(t.pusher.register(TOKEN, frame)).toEqual({ type: "board.state", registered: true, delivery: "off" });
    t.registry.set(session("gr-a", "waiting", "answer"));
    await t.wait(60_000);
    expect(t.posts).toEqual([]);
  });

  it("board.unregister and the end of the pairing forget the board", async () => {
    const t = setup();
    t.pusher.register(TOKEN, frame);
    expect(t.pusher.unregister(TOKEN)).toEqual({ type: "board.state", registered: false, delivery: "gateway" });
    expect(t.boards.list()).toEqual([]);
    t.pusher.register(TOKEN, frame);
    t.paired.value = false;
    t.pusher.pairingsChanged();
    expect(t.boards.list()).toEqual([]);
    expect(t.pusher.register(TOKEN, frame).registered).toBe(false);
  });

  it("keeps boards in a 0600 file that a restarted daemon reads, and never logs a token", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "grenade-board-")), "push-boards.json");
    const t = setup({ boardsPath: path });
    t.registry.set(session("gr-a", "working"));
    t.pusher.register(TOKEN, frame);
    t.registry.set(session("gr-a", "waiting", "answer"));
    await t.wait(BOARD_DEBOUNCE_MS);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const saved = new BoardDevices(path).list();
    expect(saved).toHaveLength(1);
    expect(saved[0]!.sent?.sessions.map((e) => e.s)).toEqual(["answer"]);
    const log = t.log.lines.join("\n");
    expect(log).not.toContain(TOKEN);
    expect(log).not.toContain(frame.pushToken);
    expect(log).toContain(DEVICE);
  });
});
