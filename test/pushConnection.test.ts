import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { BoardRegisterFrame, DaemonFrame, PushRegisterFrame, PushStateFrame } from "@grenade/protocol";
import { Connection } from "../src/daemon/wsHandler.js";
import { silentLogger } from "../src/log.js";

const fixtures = join(import.meta.dirname, "..", "..", "grenade-protocol", "fixtures");
const fixture = (name: string) => readFileSync(join(fixtures, name), "utf8");

class NoSessions extends EventEmitter {
  list() { return []; }
  get() { return undefined; }
}

function connect(withPush: boolean) {
  const out: DaemonFrame[] = [];
  const calls: string[] = [];
  const tell: { send?: (s: PushStateFrame) => void } = {};
  const state = (registered: boolean, events: PushStateFrame["events"]): PushStateFrame => ({ type: "push.state", registered, delivery: "gateway", events });
  const conn = new Connection({
    registry: new NoSessions() as never,
    attachments: { save: async () => ({ path: "/tmp/x", bytes: 0 }) },
    isValidToken: (t) => t === "grt_example_token",
    sealed: true,
    route: "relay",
    ...(withPush
      ? {
          push: {
            register(token: string, frame: PushRegisterFrame) {
              calls.push(`register:${token}:${frame.deviceToken.slice(0, 4)}:${frame.events.join("+")}`);
              return state(true, frame.events);
            },
            unregister(token: string) {
              calls.push(`unregister:${token}`);
              return state(false, []);
            },
            watch(token: string, send: (s: PushStateFrame) => void) {
              calls.push(`watch:${token}`);
              tell.send = send;
              return () => void calls.push(`unwatch:${token}`);
            },
          },
          board: {
            register(token: string, frame: BoardRegisterFrame) {
              calls.push(`board:${token}:${frame.pushToken.slice(0, 4)}`);
              return { type: "board.state" as const, registered: true, delivery: "gateway" as const };
            },
            unregister(token: string) {
              calls.push(`unboard:${token}`);
              return { type: "board.state" as const, registered: false, delivery: "gateway" as const };
            },
          },
        }
      : {}),
    daemon: { id: "d_1", name: "Mac", version: "0.1.0" },
    log: silentLogger,
    out: (f) => out.push(f),
    close: () => {},
    setTimer: () => 0,
    clearTimer: () => {},
  });
  return { conn, out, calls, tell };
}

describe("Connection: push notifications", () => {
  it("registers the phone that said hello, and answers push.state", async () => {
    const { conn, out, calls } = connect(true);
    await conn.handleMessage(fixture("client.hello.json"));
    await conn.handleMessage(fixture("client.push.register.json"));
    expect(calls).toEqual(["watch:grt_example_token", "register:grt_example_token:9f3c:answer+done"]);
    expect(out.at(-1)).toEqual({ type: "push.state", registered: true, delivery: "gateway", events: ["answer", "done"] });
  });

  it("unregisters it", async () => {
    const { conn, out, calls } = connect(true);
    await conn.handleMessage(fixture("client.hello.json"));
    await conn.handleMessage(fixture("client.push.unregister.json"));
    expect(calls).toEqual(["watch:grt_example_token", "unregister:grt_example_token"]);
    expect(out.at(-1)).toEqual({ type: "push.state", registered: false, delivery: "gateway", events: [] });
  });

  it("passes on a push.state the Mac sends unasked, until the connection ends", async () => {
    const { conn, out, calls, tell } = connect(true);
    await conn.handleMessage(fixture("client.hello.json"));
    tell.send?.({ type: "push.state", registered: true, delivery: "off", events: ["answer"] });
    expect(out.at(-1)).toEqual({ type: "push.state", registered: true, delivery: "off", events: ["answer"] });
    conn.handleClose();
    expect(calls).toEqual(["watch:grt_example_token", "unwatch:grt_example_token"]);
  });

  it("takes no registration before hello", async () => {
    const { conn, out, calls } = connect(true);
    await conn.handleMessage(fixture("client.push.register.json"));
    expect(calls).toEqual([]);
    expect(out[0]).toMatchObject({ type: "error", code: "unauthorized" });
  });

  it("a daemon that sends no pushes says so, and the phone keeps notifying by itself", async () => {
    const { conn, out } = connect(false);
    await conn.handleMessage(fixture("client.hello.json"));
    await conn.handleMessage(fixture("client.push.register.json"));
    expect(out.at(-1)).toEqual({ type: "push.state", registered: false, delivery: "off", events: [] });
  });
});

describe("Connection: Mac board", () => {
  it("registers the board of the phone that said hello, and answers board.state", async () => {
    const { conn, out, calls } = connect(true);
    await conn.handleMessage(fixture("client.hello.json"));
    await conn.handleMessage(fixture("client.board.register.json"));
    expect(calls.at(-1)).toMatch(/^board:grt_example_token:/);
    expect(out.at(-1)).toEqual(JSON.parse(fixture("daemon.board.state.json")));
    await conn.handleMessage(fixture("client.board.unregister.json"));
    expect(calls.at(-1)).toBe("unboard:grt_example_token");
    expect(out.at(-1)).toEqual({ type: "board.state", registered: false, delivery: "gateway" });
  });

  it("a daemon that keeps no board says so", async () => {
    const { conn, out } = connect(false);
    await conn.handleMessage(fixture("client.hello.json"));
    await conn.handleMessage(fixture("client.board.register.json"));
    expect(out.at(-1)).toEqual({ type: "board.state", registered: false, delivery: "off" });
  });
});
