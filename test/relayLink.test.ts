import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import type { RelayDaemonFrame } from "@grenade/protocol";
import { silentLogger } from "../src/log.js";
import { RelayLink } from "../src/relay/relayLink.js";

const ID = "r_" + "a".repeat(32);
const SECRET = "b".repeat(64);
const HASH = "c".repeat(64);

/** An in-process relay: records every frame and header, and hands the test the daemon socket. */
async function fakeRelay() {
  const wss = new WebSocketServer({ port: 0 });
  await new Promise((r) => wss.once("listening", r));
  const frames: RelayDaemonFrame[] = [];
  const auth: (string | undefined)[] = [];
  const sockets: WebSocket[] = [];
  wss.on("connection", (ws, req) => {
    auth.push(req.headers.authorization);
    sockets.push(ws);
    ws.on("message", (d) => frames.push(JSON.parse(d.toString())));
  });
  const url = `http://127.0.0.1:${(wss.address() as AddressInfo).port}`;
  return { wss, url, frames, auth, sockets, last: () => sockets.at(-1) as WebSocket };
}

async function until(check: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

let cleanup: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanup) c();
  cleanup = [];
});

async function setup(opts: { key?: string } = {}) {
  const relay = await fakeRelay();
  const hashes = [HASH];
  let ips = ["192.168.1.20"];
  const pipeEvents: string[] = [];
  const pipeSends: ((f: RelayDaemonFrame) => void)[] = [];
  const link = new RelayLink({
    config: { url: relay.url, id: ID, secret: SECRET, ...(opts.key ? { key: opts.key } : {}) },
    name: "MacBook Pro",
    version: "0.1.0",
    accessHashes: () => hashes,
    localIps: () => ips,
    openPipe: (conn, send, onEnd) => {
      pipeEvents.push(`open:${conn}`);
      pipeSends.push(send);
      return { handleData: (t) => pipeEvents.push(`data:${conn}:${t}`), handleClose: () => { pipeEvents.push(`close:${conn}`); onEnd(); } };
    },
    log: silentLogger,
    backoffMs: [20],
    ipCheckMs: 20,
  });
  cleanup.push(() => link.stop(), () => relay.wss.close());
  link.start();
  await until(() => relay.frames.length > 0);
  return { relay, link, hashes, setIps: (x: string[]) => (ips = x), pipeEvents, pipeSends };
}

describe("RelayLink", () => {
  it("registers with its identity, name, IPs and access hashes, and sends the key", async () => {
    const { relay, link } = await setup({ key: "reg-key" });
    expect(relay.frames[0]).toEqual({
      type: "register", protocol: 1, id: ID, secret: SECRET, name: "MacBook Pro", version: "0.1.0", localIps: ["192.168.1.20"], access: [HASH],
    });
    expect(relay.auth[0]).toBe("Bearer reg-key");
    expect(link.status().state).toBe("connecting");
    relay.last().send(JSON.stringify({ type: "registered", publicIp: "203.0.113.7" }));
    await until(() => link.status().state === "online");
    expect(link.status()).toMatchObject({ publicIp: "203.0.113.7", id: ID, phones: 0 });
  });

  it("routes open, data and close to pipes, and pipe frames back", async () => {
    const { relay, link, pipeEvents, pipeSends } = await setup();
    const ws = relay.last();
    ws.send(JSON.stringify({ type: "registered" }));
    ws.send(JSON.stringify({ type: "open", conn: "c1", ip: "198.51.100.1" }));
    ws.send(JSON.stringify({ type: "data", conn: "c1", text: "hello" }));
    ws.send(JSON.stringify({ type: "data", conn: "zz", text: "nobody" }));
    await until(() => pipeEvents.length === 2);
    expect(link.status().phones).toBe(1);
    pipeSends[0]?.({ type: "data", conn: "c1", text: "sealed" });
    await until(() => relay.frames.some((f) => f.type === "data"));
    expect(relay.frames.find((f) => f.type === "data")).toEqual({ type: "data", conn: "c1", text: "sealed" });
    ws.send(JSON.stringify({ type: "close", conn: "c1" }));
    await until(() => pipeEvents.includes("close:c1"));
    expect(pipeEvents).toEqual(["open:c1", "data:c1:hello", "close:c1"]);
    expect(link.status().phones).toBe(0);
  });

  it("sends update when a phone pairs and when local IPs change", async () => {
    const { relay, link, hashes, setIps } = await setup();
    relay.last().send(JSON.stringify({ type: "registered" }));
    await until(() => link.status().state === "online");
    hashes.push("d".repeat(64));
    link.tokensChanged();
    setIps(["10.0.0.8"]);
    await until(() => relay.frames.filter((f) => f.type === "update").length >= 2);
    const updates = relay.frames.filter((f) => f.type === "update");
    expect(updates).toContainEqual({ type: "update", access: [HASH, "d".repeat(64)] });
    expect(updates).toContainEqual({ type: "update", localIps: ["10.0.0.8"] });
  });

  it("sends the shorter list when a phone is unpaired", async () => {
    const { relay, link, hashes } = await setup();
    relay.last().send(JSON.stringify({ type: "registered" }));
    await until(() => link.status().state === "online");
    hashes.length = 0;
    link.tokensChanged();
    await until(() => relay.frames.some((f) => f.type === "update"));
    expect(relay.frames.find((f) => f.type === "update")).toEqual({ type: "update", access: [] });
  });

  it("leaving a relay empties its access list there, then stays away", async () => {
    const { relay, link } = await setup();
    let closed = false;
    relay.last().on("close", () => (closed = true));
    relay.last().send(JSON.stringify({ type: "registered" }));
    await until(() => link.status().state === "online");
    link.leave();
    await until(() => closed);
    expect(relay.frames.at(-1)).toEqual({ type: "update", access: [] });
    await until(() => link.status().state === "off");
    await new Promise((r) => setTimeout(r, 80)); // longer than the 20 ms backoff
    expect(relay.frames.filter((f) => f.type === "register")).toHaveLength(1);
  });

  it("leaving a relay it never reached just stops", async () => {
    const { relay, link } = await setup();
    link.leave();
    expect(link.status().state).toBe("off");
    expect(relay.frames.filter((f) => f.type === "update")).toEqual([]);
  });

  it("reconnects after the relay drops it, closing its pipes", async () => {
    const { relay, link, pipeEvents } = await setup();
    relay.last().send(JSON.stringify({ type: "registered" }));
    relay.last().send(JSON.stringify({ type: "open", conn: "c9" }));
    await until(() => pipeEvents.includes("open:c9"));
    relay.last().terminate();
    await until(() => relay.frames.filter((f) => f.type === "register").length === 2);
    expect(pipeEvents).toContain("close:c9");
    expect(link.status().phones).toBe(0);
  });

  it("goes to error on id_taken and keeps the message", async () => {
    const { relay, link } = await setup();
    relay.last().send(JSON.stringify({ type: "error", code: "id_taken", message: "this relay id belongs to another Mac" }));
    await until(() => link.status().state === "error");
    expect(link.status().lastError).toBe("this relay id belongs to another Mac");
  });
});
