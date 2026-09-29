/**
 * Prompts through the whole daemon on loopback: a held hook request as Claude Code sends it, a phone on the
 * encrypted local connection, and the answer on its way back. No tmux; GRENADE_HOME is a temp folder.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import type { DaemonFrame } from "@grenade/protocol";
import { silentLogger } from "../src/log.js";
import { phoneStart, type SealedChannel } from "../src/relay/e2e.js";
import type { Tmux } from "../src/tmux/tmux.js";

const home = mkdtempSync(join(tmpdir(), "grenade-prompts-"));
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

let run = 0;
/** A daemon with one session, `gr-demo`, and one phone that is paired and connected. */
async function setup() {
  const dir = join(home, `run-${++run}`);
  const d = await startDaemon({
    port: await freePort(),
    controlPort: await freePort(),
    advertise: false,
    log: silentLogger,
    tmux,
    terminal: "none",
    summaries: false,
    relay: false,
    sessionsPath: null,
    tokensPath: join(dir, "tokens.json"),
    e2eKeyPath: join(dir, "e2e-key"),
    attachmentsDir: join(dir, "attachments"),
    pushPath: join(dir, "push.json"),
  });
  stops.push(() => d.stop());
  const control = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`http://127.0.0.1:${d.controlPort}${path}`, {
      method,
      ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    });
    return (await res.json()) as Record<string, unknown>;
  };
  const session = (await control("POST", "/sessions", { name: "demo", cwd: tmpdir(), agent: "claude" })) as { id: string };

  const ws = new WebSocket(`ws://127.0.0.1:${d.port}/ws`);
  stops.push(() => ws.terminate());
  const frames: DaemonFrame[] = [];
  let channel: SealedChannel | null = null;
  const start = phoneStart(Buffer.from(d.info.key ?? "", "base64"));
  ws.on("message", (data) => {
    if (!channel) channel = start.finish(JSON.parse(data.toString()));
    else frames.push(JSON.parse(channel.open(data.toString())));
  });
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  ws.send(JSON.stringify(start.hello));
  await until(() => channel !== null);
  const send = (frame: unknown) => ws.send(channel!.seal(JSON.stringify(frame)));
  const code = (await control("POST", "/pair-code"))["code"] as string;
  send({ type: "pair", protocol: 1, code, client });
  await until(() => frames.some((f) => f.type === "paired"));
  send({ type: "hello", protocol: 1, token: (frames.find((f) => f.type === "paired") as { token: string }).token, client });
  await until(() => frames.some((f) => f.type === "sessions"));

  /** What Claude Code does when it shows a prompt: posts the payload and waits. */
  const hook = (payload: unknown, opts: { session?: string; signal?: AbortSignal } = {}) =>
    fetch(`http://127.0.0.1:${d.port}/hooks/claude/prompt`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(opts.session === "" ? {} : { "X-Grenade-Session": opts.session ?? session.id }) },
      body: JSON.stringify(payload),
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
  const statusHook = (payload: unknown) =>
    fetch(`http://127.0.0.1:${d.port}/hooks/claude?session=${session.id}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
  const of = <T extends DaemonFrame["type"]>(type: T) => frames.filter((f): f is Extract<DaemonFrame, { type: T }> => f.type === type);
  const lastSession = () => of("session.updated").at(-1)?.session;
  return { d, session, frames, send, hook, statusHook, of, lastSession };
}

const bash = { hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command: "npm test", description: "Run the tests" } };

describe("a prompt, through the daemon", () => {
  it("reaches the phone, waits, and the phone's answer is the hook's reply", async () => {
    const { session, send, hook, of, lastSession } = await setup();
    let settled = false;
    const held = hook(bash).then(async (res) => {
      settled = true;
      return { status: res.status, body: await res.json() };
    });
    await until(() => of("prompt").length === 1);
    const prompt = of("prompt")[0]!;
    expect(prompt).toMatchObject({ sessionId: session.id, kind: "permission", tool: "Bash", detail: "npm test", note: "Run the tests" });
    expect(prompt.promptId).toMatch(/^p-[0-9a-f]{8}$/);
    expect(lastSession()).toMatchObject({ status: "waiting", waitingFor: "answer" });
    await new Promise((r) => setTimeout(r, 50));
    expect(settled).toBe(false);

    send({ type: "prompt.answer", sessionId: session.id, promptId: prompt.promptId, allow: true });
    expect(await held).toEqual({ status: 200, body: { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } } } });
    await until(() => of("prompt.closed").length === 1);
    expect(of("prompt.closed")[0]).toEqual({ type: "prompt.closed", sessionId: session.id, promptId: prompt.promptId, reason: "answered" });
    await until(() => lastSession()?.status === "working");
  });

  it("is closed for the phone when Claude Code lets go of the request", async () => {
    const { hook, of } = await setup();
    const abort = new AbortController();
    const held = hook(bash, { signal: abort.signal }).catch((e: Error) => e.name);
    await until(() => of("prompt").length === 1);
    abort.abort();
    expect(await held).toBe("AbortError");
    await until(() => of("prompt.closed").length === 1);
    expect(of("prompt.closed")[0]?.reason).toBe("elsewhere");
  });

  it("is closed when the tool ran after a yes in the terminal, and the held request gets an empty answer", async () => {
    const { hook, statusHook, of } = await setup();
    const held = hook(bash).then(async (res) => ({ status: res.status, body: await res.text() }));
    await until(() => of("prompt").length === 1);
    await statusHook({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: bash.tool_input });
    expect(await held).toEqual({ status: 200, body: "" });
    await until(() => of("prompt.closed").length === 1);
    expect(of("prompt.closed")[0]?.reason).toBe("elsewhere");
  });

  it("is closed when its session is killed", async () => {
    const { session, send, hook, of } = await setup();
    const held = hook(bash).then((res) => res.status);
    await until(() => of("prompt").length === 1);
    send({ type: "session.kill", sessionId: session.id });
    expect(await held).toBe(200);
    await until(() => of("prompt.closed").length === 1);
  });

  it("answers at once, with nothing, when there is no session, an unknown one, or nothing to show", async () => {
    const { hook, of } = await setup();
    for (const res of [await hook(bash, { session: "" }), await hook(bash, { session: "gr-unknown" }), await hook({ hook_event_name: "PermissionRequest", tool_name: "ExitPlanMode", tool_input: {} })]) {
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("");
    }
    expect(of("prompt")).toEqual([]);
  });

  it("does not keep the daemon from stopping while a request is held", async () => {
    const { d, hook, of } = await setup();
    const held = hook(bash).then((res) => res.status);
    await until(() => of("prompt").length === 1);
    await d.stop();
    expect(await held).toBe(200);
  });
});
