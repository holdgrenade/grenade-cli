/**
 * Pairing with a scanned offer against the whole daemon, over real sockets on loopback: on the local network,
 * and through a relay that is played by a WebSocket server here. No tmux, no Bonjour; GRENADE_HOME is a temp folder.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import { parsePairingOffer, type DaemonFrame, type PairingOffer, type RelayDaemonFrame } from "@grenade/protocol";
import { silentLogger } from "../src/log.js";
import type { PairingState } from "../src/pairing/pairingWatch.js";
import { accessHash } from "../src/relay/access.js";
import { phoneStart, type SealedChannel } from "../src/relay/e2e.js";
import type { Tmux } from "../src/tmux/tmux.js";

const home = mkdtempSync(join(tmpdir(), "grenade-offer-"));
process.env["GRENADE_HOME"] = home;
// After GRENADE_HOME is set: config.ts reads it when it is first imported.
const { startDaemon } = await import("../src/daemon/server.js");

const tmux: Tmux = {
  async listSessions() { return []; },
  async hasSession() { return false; },
  async newSession() {},
  async capture() { throw new Error("unused"); },
  async captureHistory() { throw new Error("unused"); },
  async applySessionOptions() {},
  async sendText() {},
  async sendKey() {},
  async resize() {},
  async releaseSize() {},
  async killSession() {},
};
const client = { name: "Test phone", platform: "test" as const, version: "0.1.0" };

async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const port = (s.address() as AddressInfo).port;
  await new Promise((r) => s.close(r));
  return port;
}

async function until(check: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

let stops: (() => unknown)[] = [];
afterEach(async () => {
  for (const s of stops.reverse()) await s();
  stops = [];
});
afterAll(() => rmSync(home, { recursive: true, force: true }));

interface Minted {
  code: string;
  typed: string;
  secret: string;
  offer: string;
  expiresAt: number;
}

let run = 0;
async function daemon(opts: { relayUrl?: string } = {}) {
  const dir = join(home, `run-${++run}`);
  const relayPath = join(dir, "relay.json");
  if (opts.relayUrl) {
    // TokenStore makes the folder on its first save; the relay file has to be there before the start.
    const { mkdirSync } = await import("node:fs");
    mkdirSync(dir, { recursive: true });
    writeFileSync(relayPath, JSON.stringify({ url: opts.relayUrl, id: `r_${"ab".repeat(16)}`, secret: "cd".repeat(32) }));
  }
  const d = await startDaemon({
    port: await freePort(),
    controlPort: await freePort(),
    advertise: false,
    log: silentLogger,
    tmux,
    terminal: "none",
    summaries: false,
    sessionsPath: null,
    tokensPath: join(dir, "tokens.json"),
    relayPath,
    e2eKeyPath: join(dir, "e2e-key"),
    attachmentsDir: join(dir, "attachments"),
  });
  stops.push(() => d.stop());
  const control = async <T>(method: string, path: string): Promise<T> => (await fetch(`http://127.0.0.1:${d.controlPort}${path}`, { method })).json() as Promise<T>;
  const mint = async () => {
    const minted = await control<Minted>("POST", "/pair-code");
    const parsed = parsePairingOffer(minted.offer);
    if (!parsed.ok) throw new Error(`the daemon made an offer that does not parse: ${parsed.message}`);
    return { minted, offer: parsed.offer };
  };
  return { d, control, mint };
}

/** A phone on the local network, as `offer` tells it to connect. `sealed: false` skips the handshake. */
async function lanPhone(offer: PairingOffer, port: number, sealed = true) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  stops.push(() => ws.terminate());
  const frames: DaemonFrame[] = [];
  let closed: number | null = null;
  let channel: SealedChannel | null = null;
  const start = sealed ? phoneStart(Buffer.from(offer.key, "base64")) : null;
  ws.on("message", (data) => {
    const text = data.toString();
    if (start && !channel) {
      channel = start.finish(JSON.parse(text));
      return;
    }
    frames.push(JSON.parse(channel ? channel.open(text) : text));
  });
  ws.on("close", (code) => (closed = code));
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  if (start) {
    ws.send(JSON.stringify(start.hello));
    await until(() => channel !== null);
  }
  const send = (frame: unknown) => ws.send(channel ? channel.seal(JSON.stringify(frame)) : JSON.stringify(frame));
  return { frames, send, closed: () => closed };
}

/** Plays the relay's side of the daemon link: takes `register` and `update`, and can open a phone pipe. */
async function fakeRelay() {
  const port = await freePort();
  const server = new WebSocketServer({ port, host: "127.0.0.1", path: "/v1/daemon" });
  stops.push(() => new Promise((r) => server.close(() => r(undefined))));
  const frames: RelayDaemonFrame[] = [];
  let link: WebSocket | null = null;
  server.on("connection", (ws) => {
    link = ws;
    ws.on("message", (data) => {
      const frame = JSON.parse(data.toString()) as RelayDaemonFrame;
      frames.push(frame);
      if (frame.type === "register") ws.send(JSON.stringify({ type: "registered", publicIp: "203.0.113.7" }));
    });
  });
  /** The access list the relay holds now: the last one the daemon sent. */
  const access = (): string[] => {
    for (const f of [...frames].reverse()) if ((f.type === "register" || f.type === "update") && f.access) return f.access;
    return [];
  };
  /** A phone the relay admitted: frames go through the daemon link as `data` for `conn`. */
  const pipe = async (offer: PairingOffer, conn: string) => {
    const start = phoneStart(Buffer.from(offer.key, "base64"));
    const seen = () => frames.filter((f): f is Extract<RelayDaemonFrame, { type: "data" }> => f.type === "data" && f.conn === conn);
    link?.send(JSON.stringify({ type: "open", conn, ip: "198.51.100.4" }));
    link?.send(JSON.stringify({ type: "data", conn, text: JSON.stringify(start.hello) }));
    await until(() => seen().length >= 1);
    const channel = start.finish(JSON.parse(seen()[0]?.text ?? ""));
    let opened = 1;
    const received: DaemonFrame[] = [];
    const send = (frame: unknown) => link?.send(JSON.stringify({ type: "data", conn, text: channel.seal(JSON.stringify(frame)) }));
    const frame = async (n: number): Promise<DaemonFrame> => {
      await until(() => seen().length > n);
      while (opened < seen().length) received.push(JSON.parse(channel.open(seen()[opened++]?.text ?? "")));
      const f = received[n - 1];
      if (!f) throw new Error("no frame");
      return f;
    };
    return { send, frame, raw: () => seen().map((f) => f.text) };
  };
  return { url: `http://127.0.0.1:${port}`, frames, access, pipe, online: () => until(() => frames.some((f) => f.type === "register")) };
}

describe("the offer the daemon makes", () => {
  it("names this daemon, its key, its port and a fresh secret", async () => {
    const { d, mint } = await daemon();
    const a = await mint();
    expect(a.offer).toMatchObject({ v: 1, id: d.info.id, name: d.info.name, key: d.info.key, port: d.port, secret: a.minted.secret });
    expect(a.offer.relay).toBeUndefined();
    expect((await mint()).minted.secret).not.toBe(a.minted.secret);
  });

  it("carries the relay while the daemon has one", async () => {
    const relay = await fakeRelay();
    const { mint } = await daemon({ relayUrl: relay.url });
    expect((await mint()).offer.relay).toEqual({ url: relay.url, id: `r_${"ab".repeat(16)}` });
  });
});

describe("pairing on the local network", () => {
  it("trades the offer's secret for a token inside the encrypted channel, then says hello on the same socket", async () => {
    const { d, mint, control } = await daemon();
    const { offer } = await mint();
    expect(await control<PairingState>("GET", "/pair-code")).toMatchObject({ state: "waiting" });

    const p = await lanPhone(offer, d.port);
    p.send({ type: "pair", protocol: 1, secret: offer.secret, client });
    await until(() => p.frames.length >= 1);
    const paired = p.frames[0];
    if (paired?.type !== "paired") throw new Error(`expected paired, got ${JSON.stringify(paired)}`);
    expect(paired.token).toMatch(/^grt_/);
    expect(paired.daemon.key).toBe(offer.key);

    p.send({ type: "hello", protocol: 1, token: paired.token, client });
    await until(() => p.frames.length >= 4);
    expect(p.frames.slice(1).map((f) => f.type)).toEqual(["welcome", "sessions", "groups"]);
    expect(await control("GET", "/pair-code")).toEqual({ state: "paired", phone: "Test phone", platform: "test", route: "lan" });
    expect(await control("GET", "/devices")).toMatchObject([{ name: "Test phone", sealed: true, connected: ["lan"] }]);
  });

  it("takes the typed code the same way", async () => {
    const { d, mint } = await daemon();
    const { offer, minted } = await mint();
    const p = await lanPhone(offer, d.port);
    p.send({ type: "pair", protocol: 1, code: minted.code, client });
    await until(() => p.frames.length >= 1);
    expect(p.frames[0]?.type).toBe("paired");
  });

  it("works once: the second phone is told the code is wrong, and the typed code went with the secret", async () => {
    const { d, mint } = await daemon();
    const { offer, minted } = await mint();
    const first = await lanPhone(offer, d.port);
    first.send({ type: "pair", protocol: 1, secret: offer.secret, client });
    await until(() => first.frames.length >= 1);

    const second = await lanPhone(offer, d.port);
    second.send({ type: "pair", protocol: 1, secret: offer.secret, client });
    second.send({ type: "pair", protocol: 1, code: minted.code, client });
    await until(() => second.frames.length >= 2);
    expect(second.frames).toMatchObject([
      { type: "error", code: "invalid_code", ref: "pair" },
      { type: "error", code: "invalid_code", ref: "pair" },
    ]);
  });

  it("voids the offer after five wrong tries, closes the connection and pauses pairing", async () => {
    const { d, mint, control } = await daemon();
    const { offer } = await mint();
    const p = await lanPhone(offer, d.port);
    const before = Date.now();
    for (let i = 0; i < 5; i++) p.send({ type: "pair", protocol: 1, secret: "x".repeat(22), client });
    await until(() => p.closed() !== null);
    expect(p.frames.map((f) => (f.type === "error" ? f.code : f.type))).toEqual(["invalid_code", "invalid_code", "invalid_code", "invalid_code", "too_many_attempts"]);
    const strike = p.frames[4] as { pausedUntil?: string };
    const until1 = Date.parse(strike.pausedUntil ?? "");
    expect(until1 - before).toBeGreaterThanOrEqual(59_000);
    expect(until1 - before).toBeLessThanOrEqual(61_000);
    expect(await control("GET", "/pair-code")).toMatchObject({ state: "paused" });
    // No new code while paused, and nothing ends it early.
    const refused = await fetch(`http://127.0.0.1:${d.controlPort}/pair-code`, { method: "POST" });
    expect(refused.status).toBe(409);

    const late = await lanPhone(offer, d.port);
    late.send({ type: "pair", protocol: 1, secret: offer.secret, client });
    await until(() => late.frames.length >= 1);
    expect(late.frames[0]).toMatchObject({ type: "error", code: "too_many_attempts", pausedUntil: strike.pausedUntil });
  });

  it("refuses to pair outside the encrypted channel, and does not count it as a try", async () => {
    const { d, mint, control } = await daemon();
    const { offer } = await mint();
    const plain = await lanPhone(offer, d.port, false);
    for (let i = 0; i < 6; i++) plain.send({ type: "pair", protocol: 1, secret: offer.secret, client });
    await until(() => plain.frames.length >= 6);
    for (const f of plain.frames) expect(f).toMatchObject({ type: "error", code: "unsupported_protocol", ref: "pair" });
    expect(await control("GET", "/devices")).toEqual([]);

    const sealed = await lanPhone(offer, d.port);
    sealed.send({ type: "pair", protocol: 1, secret: offer.secret, client });
    await until(() => sealed.frames.length >= 1);
    expect(sealed.frames[0]?.type).toBe("paired");
  });

  it("a phone with the wrong key for this Mac gets nothing it can read", async () => {
    const { d, mint } = await daemon();
    const { offer } = await mint();
    const other = await daemon();
    const wrongKey: PairingOffer = { ...offer, key: other.d.info.key ?? "" };
    await expect(
      (async () => {
        const p = await lanPhone(wrongKey, d.port);
        p.send({ type: "pair", protocol: 1, secret: offer.secret, client });
        await until(() => p.frames.length >= 1 || p.closed() !== null);
        return p.frames;
      })(),
    ).resolves.toEqual([]);
  });
});

describe("pairing through the relay", () => {
  it("lets the relay admit the phone only while the offer is live", async () => {
    const relay = await fakeRelay();
    const { mint, d } = await daemon({ relayUrl: relay.url });
    await relay.online();
    expect(relay.access()).toEqual([]);

    const { offer } = await mint();
    await until(() => relay.access().length === 1);
    expect(relay.access()).toEqual([accessHash(offer.secret)]);

    const p = await lanPhone(offer, d.port);
    p.send({ type: "pair", protocol: 1, secret: offer.secret, client });
    await until(() => p.frames.length >= 1);
    const paired = p.frames[0];
    if (paired?.type !== "paired") throw new Error("expected paired");
    await until(() => relay.access().length === 1 && relay.access()[0] === accessHash(paired.token));
    expect(relay.access()).not.toContain(accessHash(offer.secret));
  });

  it("takes the old offer's hash away when a new one is minted", async () => {
    const relay = await fakeRelay();
    const { mint } = await daemon({ relayUrl: relay.url });
    await relay.online();
    const a = await mint();
    await until(() => relay.access().includes(accessHash(a.offer.secret)));
    const b = await mint();
    await until(() => relay.access().includes(accessHash(b.offer.secret)));
    expect(relay.access()).toEqual([accessHash(b.offer.secret)]);
  });

  it("pairs a phone that only has the relay, and the relay reads none of it", async () => {
    const relay = await fakeRelay();
    const { mint, control } = await daemon({ relayUrl: relay.url });
    await relay.online();
    const { offer } = await mint();

    const pipe = await relay.pipe(offer, "c1");
    pipe.send({ type: "pair", protocol: 1, secret: offer.secret, client });
    const paired = await pipe.frame(1);
    if (paired.type !== "paired") throw new Error(`expected paired, got ${JSON.stringify(paired)}`);
    expect(paired.daemon).toMatchObject({ key: offer.key, relay: offer.relay });

    pipe.send({ type: "hello", protocol: 1, token: paired.token, client });
    expect((await pipe.frame(2)).type).toBe("welcome");
    expect(await control("GET", "/pair-code")).toEqual({ state: "paired", phone: "Test phone", platform: "test", route: "relay" });
    expect(await control("GET", "/devices")).toMatchObject([{ sealed: true, connected: ["relay"] }]);

    // Everything the relay carried after the handshake is sealed: no secret, no token, no JSON.
    const carried = pipe.raw().slice(1).join("\n");
    expect(carried).not.toContain(offer.secret);
    expect(carried).not.toContain(paired.token);
    for (const text of pipe.raw().slice(1)) expect(text).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
  });
});
