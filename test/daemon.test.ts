/**
 * The whole daemon over real sockets on loopback: pairing, the encrypted local connection, unpairing from the Mac
 * and from the phone, and what its relay is told. No tmux, no Bonjour, no iTerm; GRENADE_HOME is a temp folder.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
import type { TalkRun } from "../src/talk/talkRunner.js";
import { daemonToolCaller } from "../src/talk/talkMcp.js";

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
async function daemon(opts: { allowPlainLan?: boolean; relayUrl?: string; tmux?: Tmux; sessionsPath?: string; voiceFetch?: typeof fetch; talkRun?: TalkRun } = {}) {
  const dir = join(home, `run-${++run}`);
  const relayPath = join(dir, "relay.json");
  const tokensPath = join(dir, "tokens.json");
  const d: Running = await startDaemon({
    port: await freePort(),
    controlPort: await freePort(),
    advertise: false,
    log: silentLogger,
    tmux: opts.tmux ?? tmux,
    terminal: "none",
    summaries: false,
    sessionsPath: opts.sessionsPath ?? null,
    tokensPath,
    relayPath,
    e2eKeyPath: join(dir, "e2e-key"),
    attachmentsDir: join(dir, "attachments"),
    voiceKeysPath: join(dir, "voice-keys.json"),
    ...(opts.voiceFetch ? { voiceFetch: opts.voiceFetch } : {}),
    talk: { dir: join(dir, "talk"), settingsPath: join(dir, "talk.json"), agents: ["claude"], ...(opts.talkRun ? { run: opts.talkRun } : {}) },
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

describe("updates through the control API", () => {
  it("reports what installs this copy and refuses a restart it cannot do", async () => {
    const { control } = await daemon();
    const update = (await control("GET", "/status")).body["update"] as { method?: string; restarts?: boolean };
    expect(update).toMatchObject({ method: "source", restarts: false });
    expect(await control("POST", "/update/restart")).toEqual({ status: 409, body: { error: "cannot_restart" } });
  });
});

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

describe("activity after a restart", () => {
  it("is read from the saved transcript at start, before any hook", async () => {
    const fixtures = join(import.meta.dirname, "..", "..", "grenade-protocol", "fixtures");
    const dir = mkdtempSync(join(home, "restart-"));
    const transcript = join(dir, "t.jsonl");
    writeFileSync(transcript, readFileSync(join(fixtures, "transcript.examples.jsonl")));
    const sessionsPath = join(dir, "sessions.json");
    writeFileSync(sessionsPath, JSON.stringify([{ id: "gr-app", name: "app", agent: "claude", cwd: dir, createdAt: "2026-09-30T14:00:00.000Z", transcript }]));
    const live: Tmux = { ...tmux, async listSessions() { return ["gr-app"]; } };
    const { d, pairPlain } = await daemon({ allowPlainLan: true, tmux: live, sessionsPath });
    const { token } = (await pairPlain()).body;
    const p = await phone(d.port, Buffer.alloc(0), false);
    p.hello(token ?? "");
    await until(() => p.types().includes("welcome"));
    p.send({ type: "subscribe", sessionId: "gr-app" });
    await until(() => p.types().includes("activity"));
    const expected = JSON.parse(readFileSync(join(fixtures, "daemon.activity.json"), "utf8")) as { entries: unknown[] };
    expect(p.frames.find((f) => f.type === "activity")).toMatchObject({ sessionId: "gr-app", full: true, entries: expected.entries });
  });
});

describe("Codex hooks", () => {
  it("bring a Codex session's activity from its rollout, its model and its status", async () => {
    const fixtures = join(import.meta.dirname, "..", "..", "grenade-protocol", "fixtures");
    const dir = mkdtempSync(join(home, "codex-"));
    const rollout = join(dir, "rollout.jsonl");
    writeFileSync(rollout, readFileSync(join(fixtures, "codex.rollout.examples.jsonl")));
    const sessionsPath = join(dir, "sessions.json");
    writeFileSync(sessionsPath, JSON.stringify([{ id: "gr-cx", name: "cx", agent: "codex", cwd: dir, createdAt: "2026-10-02T14:00:00.000Z" }]));
    const live: Tmux = { ...tmux, async listSessions() { return ["gr-cx"]; } };
    const { d, base, pairPlain } = await daemon({ allowPlainLan: true, tmux: live, sessionsPath });
    const { token } = (await pairPlain()).body;
    const p = await phone(d.port, Buffer.alloc(0), false);
    p.hello(token ?? "");
    await until(() => p.types().includes("welcome"));
    expect(p.frames.find((f) => f.type === "welcome")).toMatchObject({ daemon: { codexActivity: 1, board: 1 } });
    p.send({ type: "subscribe", sessionId: "gr-cx" });
    const stop = { hook_event_name: "Stop", session_id: "s", transcript_path: rollout, model: "gpt-6-luna", last_assistant_message: "done" };
    const res = await fetch(`${base}/hooks/codex?session=gr-cx`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(stop) });
    expect(await res.json()).toEqual({ ok: true, applied: "waiting" });
    const expected = JSON.parse(readFileSync(join(fixtures, "daemon.activity.codex.json"), "utf8")) as { entries: unknown[] };
    await until(() => p.frames.some((f) => f.type === "activity" && f.entries.length > 0));
    expect(p.frames.filter((f) => f.type === "activity").flatMap((f) => (f.type === "activity" ? f.entries : []))).toEqual(expected.entries);
    await until(() => p.frames.some((f) => f.type === "session.updated" && f.session.model === "gpt-6-luna" && f.session.waitingFor === "done"));
  });
});

describe("the design canvas", () => {
  it("says canvas: 1, lists a session's boards and sends one, and refuses a folder no session uses", async () => {
    const dir = join(home, "canvas-project");
    mkdirSync(join(dir, ".grenade", "canvas"), { recursive: true });
    writeFileSync(join(dir, ".grenade", "canvas", "R1A · Cards.html"), `<meta name="board" content="390x844"><h1>Cards</h1>`);
    const sessionsPath = join(home, "canvas-sessions.json");
    writeFileSync(sessionsPath, JSON.stringify([{ id: "gr-cv", name: "cv", agent: "claude", cwd: dir, createdAt: "2026-10-04T10:00:00.000Z" }]));
    const live: Tmux = { ...tmux, async listSessions() { return ["gr-cv"]; } };
    const { d, pairPlain } = await daemon({ allowPlainLan: true, tmux: live, sessionsPath });
    const { token } = (await pairPlain()).body;
    const p = await phone(d.port, Buffer.alloc(0), false);
    p.hello(token ?? "");
    await until(() => p.types().includes("welcome"));
    expect(p.frames.find((f) => f.type === "welcome")).toMatchObject({ daemon: { canvas: 1 } });
    p.send({ type: "canvas", id: "c_1", cwd: dir });
    p.send({ type: "canvas.board", id: "c_2", cwd: dir, file: "R1A · Cards.html" });
    p.send({ type: "canvas", id: "c_3", cwd: home });
    await until(() => p.types().filter((t) => t === "canvas" || t === "canvas.board" || t === "error").length >= 3);
    expect(p.frames.find((f) => f.type === "canvas")).toMatchObject({ id: "c_1", boards: [{ file: "R1A · Cards.html", name: "Cards", revision: 1, letter: "A", width: 390, height: 844 }] });
    expect(p.frames.find((f) => f.type === "canvas.board")).toMatchObject({ id: "c_2", html: `<meta name="board" content="390x844"><h1>Cards</h1>` });
    expect(p.frames.find((f) => f.type === "error")).toMatchObject({ code: "bad_frame", ref: "canvas", id: "c_3" });
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

describe("a web page", () => {
  it("cannot reach the control API or POST /pair, even from this Mac; an extension and the CLI can", async () => {
    const { d, base } = await daemon();
    const page = { origin: "https://evil.example" };
    const mint = (headers: Record<string, string>) => fetch(`http://127.0.0.1:${d.controlPort}/pair-code`, { method: "POST", headers });
    expect((await mint(page)).status).toBe(403);
    expect((await mint({ origin: "http://localhost:4321" })).status).toBe(403);
    expect((await mint({ origin: "null" })).status).toBe(403);
    expect((await fetch(`http://127.0.0.1:${d.controlPort}/status`, { headers: page })).status).toBe(403);
    expect((await fetch(`${base}/pair`, { method: "POST", headers: { ...page, "content-type": "application/json" }, body: "{}" })).status).toBe(403);
    expect((await fetch(`${base}/hooks/claude`, { method: "POST", headers: page, body: "{}" })).status).toBe(403);
    expect((await mint({ origin: "chrome-extension://eiocljcomciaepiidgadhbbadmmnpdne" })).status).toBe(200);
    expect((await mint({ origin: "chrome-extension://abcdefghijklmnopabcdefghijklmnop" })).status).toBe(403);
    expect((await mint({})).status).toBe(200);
    expect((await fetch(`${base}/health`, { headers: page })).status).toBe(200);
  });
});

describe("a page that rebinds its own name to this Mac", () => {
  it("is refused by the control API, which answers loopback names only", async () => {
    const { d } = await daemon();
    const { request } = await import("node:http");
    const get = (host: string) =>
      new Promise<number>((resolve, reject) => {
        request({ host: "127.0.0.1", port: d.controlPort, path: "/sessions", headers: { host } }, (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        }).on("error", reject).end();
      });
    expect(await get(`evil.example:${d.controlPort}`)).toBe(403);
    expect(await get(`127.0.0.1:${d.controlPort}`)).toBe(200);
    expect(await get(`localhost:${d.controlPort}`)).toBe(200);
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
    await until(() => p.frames.length >= 4);
    expect(p.types()).toEqual(["paired", "welcome", "sessions", "groups"]);
    expect((await control("GET", "/devices")).body).toMatchObject([{ name: "Test phone", connected: ["lan"], sealed: true }]);
  });

  it("pairs the Chrome extension, which says platform chrome", async () => {
    const { d, control, key } = await daemon();
    const code = (await control("POST", "/pair-code")).body["code"] as string;
    const p = await phone(d.port, key, true);
    const chrome = { name: "Chrome on Test Mac", platform: "chrome" as const, version: "0.1.0" };
    p.send({ type: "pair", protocol: 1, code, client: chrome });
    await until(() => p.frames.length >= 1);
    const paired = p.frames[0] as { type: string; token: string };
    expect(paired).toMatchObject({ type: "paired" });
    p.send({ type: "hello", protocol: 1, token: paired.token, client: chrome });
    await until(() => p.frames.length >= 2);
    expect(p.frames[1]).toMatchObject({ type: "welcome" });
    expect((await control("GET", "/devices")).body).toMatchObject([{ name: "Chrome on Test Mac", platform: "chrome" }]);
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
    await until(() => p.frames.length >= 3);
    expect(p.types()).toEqual(["welcome", "sessions", "groups"]);
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
    await until(() => later.frames.length >= 3);
    expect(later.types()).toEqual(["welcome", "sessions", "groups"]);
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

describe("group order", () => {
  it("is the same on every phone: a group moved on one moves on the other", async () => {
    const { d, pairPlain, key, dir } = await daemon({ allowPlainLan: true });
    for (const f of ["one", "two"]) mkdirSync(join(dir, f), { recursive: true });
    const a = await phone(d.port, key, true);
    a.hello((await pairPlain()).body.token ?? "");
    const b = await phone(d.port, key, true);
    b.hello((await pairPlain()).body.token ?? "");
    await until(() => a.frames.length >= 3 && b.frames.length >= 3);
    a.send({ type: "session.create", name: "one", cwd: join(dir, "one"), agent: "shell" });
    a.send({ type: "session.create", name: "two", cwd: join(dir, "two"), agent: "shell" });
    const orders = (p: typeof a) => p.frames.flatMap((f) => (f.type === "groups" ? [f.order] : []));
    await until(() => orders(b).at(-1)?.length === 2);
    const [top, below] = orders(b).at(-1) as string[];
    a.send({ type: "group.move", group: below, index: 0 });
    await until(() => orders(b).at(-1)?.[0] === below);
    expect(orders(b).at(-1)).toEqual([below, top]);
    expect(orders(a).at(-1)).toEqual([below, top]);
  });
});

describe("voice providers", () => {
  it("keep the owner's key on the Mac: a phone hands it over sealed, gets tokens back, and every phone hears of a change", async () => {
    const key = "sk-proj-0123456789abcdefghijklmnopqrstuvwxyzABCD";
    let minted = 0;
    const voiceFetch = (async () => new Response(JSON.stringify({ value: `ek_secret_${++minted}`, expires_at: 1791115260 }), { status: 200 })) as unknown as typeof fetch;
    const { d, dir, control, pairPlain, key: daemonKey } = await daemon({ allowPlainLan: true, voiceFetch });
    expect(d.info.voice).toBe(1);
    const a = await phone(d.port, daemonKey, true);
    a.hello((await pairPlain()).body.token ?? "");
    const b = await phone(d.port, daemonKey, true);
    b.hello((await pairPlain()).body.token ?? "");
    await until(() => a.frames.length >= 3 && b.frames.length >= 3);
    const voices = (p: typeof a) => p.frames.flatMap((f) => (f.type === "voice" ? [f.providers] : []));
    b.send({ type: "voice" });
    await until(() => voices(b).length === 1);
    expect(voices(b)[0]!.map((p) => [p.id, p.key])).toEqual([["openai", undefined], ["gemini", undefined]]);

    a.send({ type: "voice.key", provider: "openai", key });
    await until(() => voices(a).length === 1 && voices(b).length === 2);
    expect(voices(b)[1]![0]).toEqual({ id: "openai", name: "OpenAI", uses: ["talk"], key: "sk-…ABCD" });
    expect(JSON.parse(readFileSync(join(dir, "voice-keys.json"), "utf8"))).toEqual({ openai: key });

    a.send({ type: "voice.token", id: "v_1", provider: "openai", use: "talk", model: "gpt-realtime-2.1-mini" });
    a.send({ type: "voice.token", id: "v_2", provider: "gemini", use: "talk" });
    await until(() => a.frames.some((f) => f.type === "error" && f.id === "v_2") && a.frames.some((f) => f.type === "voice.token"));
    expect(a.frames.find((f) => f.type === "voice.token")).toEqual({ type: "voice.token", id: "v_1", provider: "openai", use: "talk", token: "ek_secret_2", expiresAt: "2026-10-04T12:01:00.000Z", once: true });
    expect(a.frames.find((f) => f.type === "error")).toMatchObject({ code: "bad_frame", ref: "voice.token", id: "v_2" });
    // Neither the key nor a token was readable on the socket, in either direction's frames as the daemon sent them.
    expect(a.raw.join("\n")).not.toContain("ek_secret");
    expect(a.raw.join("\n")).not.toContain(key);
    // No frame ever carries the key back.
    expect(JSON.stringify([...a.frames, ...b.frames])).not.toContain(key);

    // `grenade voice forget` writes the file and asks the daemon to read it again: both phones hear.
    writeFileSync(join(dir, "voice-keys.json"), "{}");
    expect((await control("POST", "/voice/reload")).body.map((p) => (p as { key?: string }).key)).toEqual([undefined, undefined]);
    await until(() => voices(b).length === 3);
    expect(voices(b)[2]![0]).toEqual({ id: "openai", name: "OpenAI", uses: ["talk"] });
  });
});

describe("typed Talk", () => {
  it("runs a turn whose tools reach the daemon over loopback with the turn's secret, and only during the turn", async () => {
    let leaked: Record<string, string> = {};
    const answers: string[] = [];
    const talkRun: TalkRun = async (_agent, _spec, _words, env) => {
      leaked = env;
      // What Grenade's MCP server does with the environment it is given.
      const listed = await daemonToolCaller(env)("list_sessions", {});
      answers.push(listed.text);
      const forged = await daemonToolCaller({ ...env, GRENADE_TALK_SECRET: "nope" })("list_sessions", {});
      answers.push(forged.text);
      return { text: "Nothing to send to.", conversation: "c1" };
    };
    const { d, control } = await daemon({ talkRun });
    expect(d.info.talk).toBe(1);
    expect(d.info.agents.find((a) => a.kind === "claude")?.talk).toBe(true);
    expect(d.info.agents.find((a) => a.kind === "codex")?.talk).toBeUndefined();
    const said = await fetch(`http://127.0.0.1:${d.controlPort}/talk/say`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "anything running?" }) });
    expect(said.status).toBe(200);
    await until(() => answers.length === 2);
    let thread: { entries: { kind: string; text: string }[]; busy: boolean } = { entries: [], busy: true };
    for (let i = 0; i < 100 && (thread.busy || thread.entries.length < 2); i++) {
      thread = (await control("GET", "/talk/thread")).body as unknown as typeof thread;
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(JSON.parse(answers[0]!)).toMatchObject({ sessions: [], note: expect.stringContaining("data") });
    expect(JSON.parse(answers[1]!)).toEqual({ error: "This Talk turn is over." });
    expect(thread.entries.map((e) => `${e.kind}:${e.text}`)).toEqual(["you:anything running?", "it:Nothing to send to."]);
    // The turn is over: its own secret no longer works.
    expect(JSON.parse((await daemonToolCaller(leaked)("list_sessions", {})).text)).toEqual({ error: "This Talk turn is over." });
  });
});
