/** The agent's browser (PROTOCOL.md "Agent browser"): the bridge, the `browser.host` rule and `grenade browser`'s addresses. */
import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import type { BrowserCommandFrame, DaemonFrame } from "@grenade/protocol";
import { BrowserBridge } from "../src/browser/browserBridge.js";
import { browserUrl } from "../src/cli/browserCommand.js";
import { Connection } from "../src/daemon/wsHandler.js";
import { silentLogger } from "../src/log.js";

const hello = { type: "hello", protocol: 1, token: "grt_t", client: { name: "Mac", platform: "macos", version: "1.0.180" } };

class FakeRegistry extends EventEmitter {
  list() { return []; }
  get() { return undefined; }
  unsubscribe() {}
}

function connection(bridge: BrowserBridge, local: boolean) {
  const out: DaemonFrame[] = [];
  const conn = new Connection({
    registry: new FakeRegistry() as never,
    attachments: { save: async () => ({ path: "", bytes: 0 }) },
    isValidToken: () => true,
    sealed: true,
    route: "lan",
    browser: bridge,
    local,
    daemon: { id: "d_1", name: "Mac", version: "0.1.0" },
    log: silentLogger,
    out: (f) => out.push(f),
    close: () => {},
    setTimer: () => 0,
    clearTimer: () => {},
  });
  const send = (frame: object) => conn.handleMessage(JSON.stringify(frame));
  return { conn, out, send };
}

describe("the browser bridge", () => {
  it("fails at once with no app to host it", async () => {
    const bridge = new BrowserBridge();
    expect(await bridge.run({ sessionId: "gr-a", action: "screenshot" })).toMatchObject({ ok: false, message: expect.stringContaining("not open") });
  });

  it("sends to the newest host and hands back its answer", async () => {
    const bridge = new BrowserBridge({ newId: () => "b-1", setTimer: () => 0, clearTimer: () => {} });
    const sent: BrowserCommandFrame[] = [];
    const older = { send: () => {} };
    const newer = { send: (f: BrowserCommandFrame) => sent.push(f) };
    bridge.host(older);
    bridge.host(newer);
    const answer = bridge.run({ sessionId: "gr-a", action: "open", url: "http://localhost:3000/" });
    expect(sent).toEqual([{ type: "browser.command", id: "b-1", sessionId: "gr-a", action: "open", url: "http://localhost:3000/" }]);
    bridge.result(older, { type: "browser.result", id: "b-1", ok: false });
    bridge.result(newer, { type: "browser.result", id: "b-1", ok: true, title: "Acme" });
    expect(await answer).toEqual({ ok: true, title: "Acme" });
  });

  it("fails what a host was asked when it goes, and on a timeout", async () => {
    let fire = (): void => {};
    const bridge = new BrowserBridge({ setTimer: (fn) => { fire = fn; return 0; }, clearTimer: () => {} });
    const host = { send: () => {} };
    bridge.host(host);
    const dropped = bridge.run({ sessionId: "gr-a", action: "screenshot" });
    bridge.drop(host);
    expect(await dropped).toMatchObject({ ok: false });
    expect(bridge.hasHost).toBe(false);
    bridge.host(host);
    const late = bridge.run({ sessionId: "gr-a", action: "screenshot" });
    fire();
    expect(await late).toMatchObject({ ok: false, message: expect.stringContaining("in time") });
  });
});

describe("browser.host on a connection", () => {
  it("is taken from this computer, and its results reach the bridge", async () => {
    const bridge = new BrowserBridge({ newId: () => "b-1", setTimer: () => 0, clearTimer: () => {} });
    const { out, send, conn } = connection(bridge, true);
    await send(hello);
    await send({ type: "browser.host" });
    expect(bridge.hasHost).toBe(true);
    const answer = bridge.run({ sessionId: "gr-a", action: "release" });
    expect(out.at(-1)).toMatchObject({ type: "browser.command", id: "b-1", action: "release" });
    await send({ type: "browser.result", id: "b-1", ok: true });
    expect(await answer).toEqual({ ok: true });
    conn.handleClose();
    expect(bridge.hasHost).toBe(false);
  });

  it("is refused from anywhere else", async () => {
    const bridge = new BrowserBridge();
    const { out, send } = connection(bridge, false);
    await send(hello);
    await send({ type: "browser.host" });
    expect(bridge.hasHost).toBe(false);
    expect(out.at(-1)).toMatchObject({ type: "error", code: "bad_frame", ref: "browser.host" });
  });
});

describe("browserUrl", () => {
  it("reads a port, a local address and a site", () => {
    expect(browserUrl("3000")).toBe("http://localhost:3000");
    expect(browserUrl("5173/admin")).toBe("http://localhost:5173/admin");
    expect(browserUrl("localhost:8080/x")).toBe("http://localhost:8080/x");
    expect(browserUrl("example.com")).toBe("https://example.com");
    expect(browserUrl("http://127.0.0.1:4000/")).toBe("http://127.0.0.1:4000/");
  });
});
