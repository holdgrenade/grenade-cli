/**
 * The whole daemon over real sockets on loopback: pairing, the encrypted local connection, unpairing from the Mac
 * and from the phone, and what its relay is told. No tmux, no Bonjour, no iTerm; GRENADE_HOME is a temp folder.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import type { DaemonFrame, RelayDaemonFrame } from "@grenade/protocol";
import { silentLogger } from "../src/log.js";
import { accessHash } from "../src/relay/access.js";
import { phoneStart, type SealedChannel } from "../src/relay/e2e.js";
import type { Tmux } from "../src/tmux/tmux.js";

const home = mkdtempSync(join(tmpdir(), "grenade-daemon-"));
process.env["GRENADE_HOME"] = home;
// After GRENADE_HOME is set: config.ts reads it when it is first imported.
const { startDaemon } = await import("../src/daemon/server.js");
type Running = Awaited<ReturnType<typeof startDaemon>>;

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

let run = 0;
async function daemon(opts: { allowPlainLan?: boolean; relayUrl?: string } = {}) {
  const dir = join(home, `run-${++run}`);
  const relayPath = join(dir, "relay.json");
  const tokensPath = join(dir, "tokens.json");
  const d: Running = await startDaemon({
    port: await freePort(),
    controlPort: await freePort(),
    advertise: false,
    log: silentLogger,
    tmux,
    terminal: "none",
    summaries: false,
    sessionsPath: null,
    tokensPath,
    relayPath,
    e2eKeyPath: join(dir, "e2e-key"),
    attachmentsDir: join(dir, "attachments"),
    ...(opts.allowPlainLan ? { allowPlainLan: true } : {}),
  });
  stops.push(() => d.stop());
  const base = `http://127.0.0.1:${d.port}`;
  const control = async (method: string, path: string) => {
    const res = await fetch(`http://127.0.0.1:${d.controlPort}${path}`, { method });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> & unknown[] };
  };
  const pairPlain = async () => {
    const code = (await control("POST", "/pair-code")).body["code"] as string;
    const res = await fetch(`${base}/pair`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, client }) });
    return { status: res.status, body: (await res.json()) as { token?: string; error?: string } };
  };
  return { d, dir, base, control, pairPlain, tokensPath, relayPath, key: Buffer.from(d.info.key ?? "", "base64") };
}

/** A phone on the local network. `sealed` does the handshake first; otherwise frames go in plain. */
async function phone(port: number, key: Buffer, sealed: boolean) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  stops.push(() => ws.terminate());
  const frames: DaemonFrame[] = [];
  const raw: string[] = [];
  let closed: number | null = null;
  let channel: SealedChannel | null = null;
  const start = sealed ? phoneStart(key) : null;
  ws.on("message", (data) => {
    const text = data.toString();
    raw.push(text);
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
  const hello = (token: string) => send({ type: "hello", protocol: 1, token, client });
  return { ws, frames, raw, send, hello, closed: () => closed, types: () => frames.map((f) => f.type) };
}

describe("pairing without encryption", () => {
  it("is refused by default", async () => {
    const { pairPlain } = await daemon();
    expect(await pairPlain()).toEqual({ status: 426, body: { error: "encryption_required" } });
  });

  it("works when the daemon allows plain connections", async () => {
    const { pairPlain, control } = await daemon({ allowPlainLan: true });
    const r = await pairPlain();
    expect(r.status).toBe(200);
    expect(r.body.token).toMatch(/^grt_/);
    expect((await control("GET", "/devices")).body).toMatchObject([{ name: "Test phone", platform: "test", connected: [], sealed: false }]);
  });
});

describe("the pairing code", () => {
  it("comes with check digits for this daemon's key", async () => {
    const { control, key } = await daemon();
    const { pairCheck } = await import("../src/daemon/pairCheck.js");
    const body = (await control("POST", "/pair-code")).body as unknown as { code: string; typed: string };
    expect(body.code).toMatch(/^\d{6}$/);
    expect(body.typed).toBe(body.code + pairCheck(body.code, key));
  });
});

describe("pairing with a typed code", () => {
  it("travels sealed, and the phone it pairs is encrypted from the start", async () => {
    const { d, control, key } = await daemon();
    const code = (await control("POST", "/pair-code")).body["code"] as string;
    const p = await phone(d.port, key, true);
    p.send({ type: "pair", protocol: 1, code, client });
    await until(() => p.frames.length >= 1);
    const paired = p.frames[0] as { type: string; token: string };
    expect(paired).toMatchObject({ type: "paired", daemon: { key: d.info.key, e2e: 1 } });
    expect(p.raw.join("")).not.toContain(code);
    p.hello(paired.token);
    await until(() => p.frames.length >= 3);
    expect(p.types()).toEqual(["paired", "welcome", "sessions"]);
    expect((await control("GET", "/devices")).body).toMatchObject([{ name: "Test phone", connected: ["lan"], sealed: true }]);
  });

  it("is refused in plain, and the code is still good afterwards", async () => {
    const { d, control, key } = await daemon();
    const code = (await control("POST", "/pair-code")).body["code"] as string;
    const plain = await phone(d.port, key, false);
    plain.send({ type: "pair", protocol: 1, code, client });
    await until(() => plain.frames.length >= 1);
    expect(plain.frames[0]).toMatchObject({ type: "error", code: "unsupported_protocol", ref: "pair" });
    const sealed = await phone(d.port, key, true);
    sealed.send({ type: "pair", protocol: 1, code, client });
    await until(() => sealed.frames.length >= 1);
    expect(sealed.frames[0]).toMatchObject({ type: "paired" });
  });
});

describe("the local connection", () => {
  it("is encrypted: nothing readable crosses the socket after the handshake", async () => {
    const { d, pairPlain, control, key } = await daemon({ allowPlainLan: true });
    const token = (await pairPlain()).body.token ?? "";
    const p = await phone(d.port, key, true);
    p.hello(token);
    await until(() => p.frames.length >= 2);
    expect(p.types()).toEqual(["welcome", "sessions"]);
    expect(p.frames[0]).toMatchObject({ daemon: { e2e: 1, key: d.info.key } });
    for (const text of p.raw.slice(1)) expect(text).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
    expect((await control("GET", "/devices")).body).toMatchObject([{ connected: ["lan"], sealed: true }]);
  });

  it("refuses a plain hello by default, without unpairing the phone", async () => {
    const allowing = await daemon({ allowPlainLan: true });
    const token = (await allowing.pairPlain()).body.token ?? "";
    // The same tokens, a daemon that does not allow plain.
    const strict = await daemon();
    writeFileSync(strict.tokensPath, readFileSync(allowing.tokensPath));
    await strict.d.stop();
    const again = await startDaemon({
      port: strict.d.port, controlPort: strict.d.controlPort, advertise: false, log: silentLogger, tmux, terminal: "none", summaries: false,
      sessionsPath: null, tokensPath: strict.tokensPath, relayPath: strict.relayPath, e2eKeyPath: join(strict.dir, "e2e-key"),
    });
    stops.push(() => again.stop());
    const p = await phone(again.port, strict.key, false);
    p.hello(token);
    await until(() => p.closed() !== null);
    expect(p.frames).toMatchObject([{ type: "error", code: "unsupported_protocol", ref: "hello" }]);
    expect(p.closed()).toBe(4001);
    expect(JSON.parse(readFileSync(strict.tokensPath, "utf8"))).toHaveLength(1);
  });

  it("accepts a plain hello when allowed, until that phone has connected encrypted once", async () => {
    const { d, pairPlain, key } = await daemon({ allowPlainLan: true });
    const token = (await pairPlain()).body.token ?? "";
    const before = await phone(d.port, key, false);
    before.hello(token);
    await until(() => before.frames.length >= 1);
    expect(before.types()[0]).toBe("welcome");

    const sealed = await phone(d.port, key, true);
    sealed.hello(token);
    await until(() => sealed.frames.length >= 1);

    const after = await phone(d.port, key, false);
    after.hello(token);
    await until(() => after.closed() !== null);
    expect(after.frames).toMatchObject([{ type: "error", code: "unsupported_protocol" }]);
  });

  it("closes a socket whose sealed frame does not open", async () => {
    const { d, key } = await daemon();
    const p = await phone(d.port, key, true);
    p.ws.send("bm90IHNlYWxlZCBhdCBhbGwgYnV0IGxvbmcgZW5vdWdo");
    await until(() => p.closed() !== null);
    expect(p.closed()).toBe(4400);
  });
});

describe("unpairing", () => {
  it("from the Mac: the open connection is told and closed, and the token stops working", async () => {
    const { d, pairPlain, control, key, tokensPath } = await daemon({ allowPlainLan: true });
    const token = (await pairPlain()).body.token ?? "";
    const p = await phone(d.port, key, true);
    p.hello(token);
    await until(() => p.frames.length >= 2);
    const id = ((await control("GET", "/devices")).body as unknown as { id: string }[])[0]?.id ?? "";

    expect(await control("DELETE", `/devices/${id}`)).toEqual({ status: 200, body: { ok: true, closed: 1 } });
    await until(() => p.closed() !== null);
    expect(p.frames.at(-1)).toMatchObject({ type: "error", code: "unauthorized" });
    expect(p.closed()).toBe(4001);
    expect(JSON.parse(readFileSync(tokensPath, "utf8"))).toEqual([]);
    expect((await control("GET", "/devices")).body).toEqual([]);

    const again = await phone(d.port, key, true);
    again.hello(token);
    await until(() => again.closed() !== null);
    expect(again.frames).toMatchObject([{ type: "error", code: "unauthorized", ref: "hello" }]);
    expect((await control("DELETE", `/devices/${id}`)).status).toBe(404);
  });

  it("--all: every phone goes, a phone paired later is untouched", async () => {
    const { d, pairPlain, control, key } = await daemon({ allowPlainLan: true });
    const a = await phone(d.port, key, true);
    a.hello((await pairPlain()).body.token ?? "");
    const b = await phone(d.port, key, true);
    b.hello((await pairPlain()).body.token ?? "");
    await until(() => a.frames.length >= 2 && b.frames.length >= 2);
    expect(await control("DELETE", "/devices")).toEqual({ status: 200, body: { removed: 2, closed: 2 } });
    await until(() => a.closed() !== null && b.closed() !== null);
    const later = await phone(d.port, key, true);
    later.hello((await pairPlain()).body.token ?? "");
    await until(() => later.frames.length >= 2);
    expect(later.types()).toEqual(["welcome", "sessions"]);
  });

  it("from the phone: unpaired, closed, and its other connection goes too", async () => {
    const { d, pairPlain, control, key } = await daemon({ allowPlainLan: true });
    const token = (await pairPlain()).body.token ?? "";
    const one = await phone(d.port, key, true);
    one.hello(token);
    const two = await phone(d.port, key, true);
    two.hello(token);
    await until(() => one.frames.length >= 2 && two.frames.length >= 2);
    one.send({ type: "unpair" });
    await until(() => one.closed() !== null && two.closed() !== null);
    expect(one.frames.at(-1)).toEqual({ type: "unpaired" });
    expect(one.closed()).toBe(4001);
    expect(two.frames.at(-1)).toMatchObject({ type: "error", code: "unauthorized" });
    expect((await control("GET", "/devices")).body).toEqual([]);
  });
});

describe("the relay's access list", () => {
  it("loses a phone the moment it is unpaired", async () => {
    const relay = new WebSocketServer({ port: 0 });
    await new Promise((r) => relay.once("listening", r));
    stops.push(() => new Promise((r) => relay.close(r)));
    const frames: RelayDaemonFrame[] = [];
    relay.on("connection", (ws) => {
      stops.push(() => ws.terminate());
      ws.on("message", (data) => {
        const f = JSON.parse(data.toString()) as RelayDaemonFrame;
        frames.push(f);
        if (f.type === "register") ws.send(JSON.stringify({ type: "registered" }));
      });
    });

    const { control, pairPlain, relayPath } = await daemon({ allowPlainLan: true });
    writeFileSync(relayPath, JSON.stringify({ url: `http://127.0.0.1:${(relay.address() as AddressInfo).port}`, id: `r_${"a".repeat(32)}`, secret: "b".repeat(64) }));
    await control("POST", "/relay/reload");
    await until(() => frames.some((f) => f.type === "register"));
    await until(async_online(control));

    const token = (await pairPlain()).body.token ?? "";
    await until(() => frames.some((f) => f.type === "update"));
    expect(frames.at(-1)).toEqual({ type: "update", access: [accessHash(token)] });

    const id = ((await control("GET", "/devices")).body as unknown as { id: string }[])[0]?.id ?? "";
    await control("DELETE", `/devices/${id}`);
    await until(() => frames.filter((f) => f.type === "update").length >= 2);
    expect(frames.at(-1)).toEqual({ type: "update", access: [] });
  });
});

/** Polls the daemon's status until its relay link is online. */
function async_online(control: (method: string, path: string) => Promise<{ body: Record<string, unknown> }>): () => boolean {
  let online = false;
  const poll = async (): Promise<void> => {
    const s = (await control("GET", "/status")).body["relayLink"] as { state: string };
    online = s.state === "online";
    if (!online) setTimeout(() => void poll(), 20);
  };
  void poll();
  return () => online;
}

describe("Claude Code hooks", () => {
  it("are answered for this Mac (other addresses get 403; see isLoopback in devices.test.ts)", async () => {
    const { base } = await daemon();
    const res = await fetch(`${base}/hooks/claude`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ hook_event_name: "Stop" }) });
    expect(res.status).not.toBe(403);
  });
});
