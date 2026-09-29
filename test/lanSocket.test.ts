import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { DaemonFrame } from "@grenade/protocol";
import { LanSocket } from "../src/daemon/lanSocket.js";
import { silentLogger } from "../src/log.js";
import { phoneStart, x25519FromRaw } from "../src/relay/e2e.js";

const fixtures = join(import.meta.dirname, "..", "..", "grenade-protocol", "fixtures");
const v = JSON.parse(readFileSync(join(fixtures, "e2e.vectors.json"), "utf8"));
const b = (s: string) => Buffer.from(s, "base64");
const staticKey = x25519FromRaw(b(v.daemonStaticPrivate));
const welcome: DaemonFrame = { type: "welcome", protocol: 1, daemon: { id: "d_1", name: "Mac", version: "0.1.0" } };

/** A socket whose Connection answers every frame with a welcome, or closes on "bye". */
function setup(ephemeral = () => x25519FromRaw(b(v.daemonEphemeralPrivate))) {
  const sent: string[] = [];
  const closes: [number, string][] = [];
  const made: boolean[] = [];
  const received: string[] = [];
  let connectionClosed = 0;
  let firstFrameTimeout: () => void = () => {};
  const lan = new LanSocket({
    socket: { send: (t) => sent.push(t), close: (code, reason) => closes.push([code, reason]) },
    staticKey,
    makeConnection: (out, close, sealed) => {
      made.push(sealed);
      return {
        handleMessage: (raw: string) => {
          received.push(raw);
          if (raw.includes("bye")) close(4001, "unauthorized");
          else out(welcome);
        },
        handleClose: () => connectionClosed++,
      };
    },
    log: silentLogger,
    label: "test",
    ephemeral,
    setTimer: (fn) => {
      firstFrameTimeout = fn;
      return 0;
    },
    clearTimer: () => {},
  });
  return { lan, sent, closes, made, received, connectionClosed: () => connectionClosed, timeOut: () => firstFrameTimeout() };
}

describe("LanSocket", () => {
  it("reproduces the shared vectors: handshake, sealed hello in, sealed frame out", () => {
    const { lan, sent, made, received } = setup();
    lan.handleMessage(JSON.stringify({ e2e: 1, e: v.phoneEphemeralPublic }));
    expect(JSON.parse(sent[0] ?? "")).toEqual({ e2e: 1, e: v.daemonEphemeralPublic });
    expect(made).toEqual([true]);
    lan.handleMessage(v.samples[0].sealed);
    lan.handleMessage(v.samples[1].sealed);
    expect(received).toEqual([v.samples[0].plaintext, v.samples[1].plaintext]);
  });

  it("carries a whole conversation sealed", () => {
    const { lan, sent } = setup(() => x25519FromRaw(Buffer.alloc(32, 7)));
    const phone = phoneStart(staticKey.publicKey);
    lan.handleMessage(JSON.stringify(phone.hello));
    const channel = phone.finish(JSON.parse(sent[0] ?? ""));
    lan.handleMessage(channel.seal(readFileSync(join(fixtures, "client.hello.json"), "utf8")));
    expect(sent).toHaveLength(2);
    expect(sent[1]).not.toContain("welcome");
    expect(JSON.parse(channel.open(sent[1] ?? ""))).toEqual(welcome);
  });

  it("hands a plain first frame to a connection marked as not encrypted", () => {
    const { lan, sent, made, received } = setup();
    const hello = readFileSync(join(fixtures, "client.hello.json"), "utf8");
    lan.handleMessage(hello);
    lan.handleMessage('{"type":"ping","t":1}');
    expect(made).toEqual([false]);
    expect(received).toEqual([hello, '{"type":"ping","t":1}']);
    expect(sent.map((t) => JSON.parse(t).type)).toEqual(["welcome", "welcome"]);
  });

  it("closes the socket when the connection closes, and tells the connection when the socket did", () => {
    const { lan, closes, connectionClosed } = setup();
    lan.handleMessage('{"type":"bye"}');
    expect(closes).toEqual([[4001, "unauthorized"]]);
    lan.handleClose();
    expect(connectionClosed()).toBe(1);
    lan.handleMessage('{"type":"ping","t":1}');
    expect(closes).toHaveLength(1);
  });

  it("closes with 4400 on a sealed frame that does not open", () => {
    const { lan, closes, connectionClosed } = setup();
    lan.handleMessage(JSON.stringify({ e2e: 1, e: v.phoneEphemeralPublic }));
    lan.handleMessage(v.samples[1].sealed); // counter 1 before counter 0
    expect(closes).toEqual([[4400, "bad frame"]]);
    expect(connectionClosed()).toBe(1);
  });

  it("closes with 4400 on a handshake with a broken key", () => {
    const { lan, closes, made } = setup();
    lan.handleMessage(JSON.stringify({ e2e: 1, e: "AAAA" }));
    expect(closes).toEqual([[4400, "bad handshake"]]);
    expect(made).toEqual([]);
  });

  it("closes a socket that says nothing", () => {
    const { closes, timeOut } = setup();
    timeOut();
    expect(closes).toEqual([[4001, "no first frame"]]);
  });

  it("does not time out a socket that spoke", () => {
    const { lan, closes, timeOut } = setup();
    lan.handleMessage(readFileSync(join(fixtures, "client.hello.json"), "utf8"));
    timeOut();
    expect(closes).toEqual([]);
  });
});
