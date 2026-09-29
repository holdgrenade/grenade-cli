import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { DaemonFrame, RelayDaemonFrame } from "@grenade/protocol";
import { phoneStart, x25519FromRaw } from "../src/relay/e2e.js";
import { CLOSE_BAD_PIPE, PhonePipe } from "../src/relay/phonePipe.js";
import { silentLogger } from "../src/log.js";

const fixtures = join(import.meta.dirname, "..", "..", "grenade-protocol", "fixtures");
const v = JSON.parse(readFileSync(join(fixtures, "e2e.vectors.json"), "utf8"));
const staticKey = x25519FromRaw(Buffer.from(v.daemonStaticPrivate, "base64"));
const welcome: DaemonFrame = { type: "welcome", protocol: 1, daemon: { id: "d_1", name: "Mac", version: "0.1.0" } };

/** A pipe whose Connection answers any frame with a welcome, and closes on "bye". */
function setup() {
  const sent: RelayDaemonFrame[] = [];
  const received: string[] = [];
  let ended = 0;
  let closedConnection = false;
  const pipe = new PhonePipe({
    conn: "c1",
    staticKey,
    send: (f) => sent.push(f),
    makeConnection: (out, close) => ({
      handleMessage: (raw: string) => {
        received.push(raw);
        if (raw.includes("bye")) close(4001, "unauthorized");
        else out(welcome);
      },
      handleClose: () => (closedConnection = true),
    }),
    log: silentLogger,
    onEnd: () => ended++,
    setTimer: () => 0,
    clearTimer: () => {},
  });
  return { pipe, sent, received, ended: () => ended, closedConnection: () => closedConnection };
}

describe("PhonePipe", () => {
  it("handshakes, opens the sealed hello and seals the welcome", () => {
    const { pipe, sent, received } = setup();
    const phone = phoneStart(staticKey.publicKey);
    pipe.handleData(JSON.stringify(phone.hello));
    const reply = sent[0];
    expect(reply).toMatchObject({ type: "data", conn: "c1" });
    const channel = phone.finish(JSON.parse((reply as { text: string }).text));
    pipe.handleData(channel.seal(readFileSync(join(fixtures, "client.hello.json"), "utf8")));
    expect(JSON.parse(received[0] ?? "")).toMatchObject({ type: "hello" });
    const sealedWelcome = sent[1] as { type: string; text: string };
    expect(sealedWelcome.type).toBe("data");
    expect(sealedWelcome.text).not.toContain("welcome");
    expect(JSON.parse(channel.open(sealedWelcome.text))).toEqual(welcome);
  });

  it("closes with 4400 on a bad handshake", () => {
    const { pipe, sent, ended } = setup();
    pipe.handleData('{"type":"hello"}');
    expect(sent).toEqual([{ type: "close", conn: "c1", code: CLOSE_BAD_PIPE, reason: "bad handshake" }]);
    expect(ended()).toBe(1);
    pipe.handleData("anything");
    expect(sent).toHaveLength(1);
  });

  it("closes with 4400 on a frame that does not decrypt", () => {
    const { pipe, sent, closedConnection } = setup();
    const phone = phoneStart(staticKey.publicKey);
    pipe.handleData(JSON.stringify(phone.hello));
    pipe.handleData(Buffer.from("not sealed at all, long enough").toString("base64"));
    expect(sent.at(-1)).toEqual({ type: "close", conn: "c1", code: CLOSE_BAD_PIPE, reason: "bad frame" });
    expect(closedConnection()).toBe(true);
  });

  it("passes the Connection's close to the relay, and a relay close to the Connection", () => {
    const a = setup();
    const phone = phoneStart(staticKey.publicKey);
    a.pipe.handleData(JSON.stringify(phone.hello));
    const channel = phone.finish(JSON.parse((a.sent[0] as { text: string }).text));
    a.pipe.handleData(channel.seal('{"bye":1}'));
    expect(a.sent.at(-1)).toEqual({ type: "close", conn: "c1", code: 4001, reason: "unauthorized" });
    expect(a.closedConnection()).toBe(true);

    const b = setup();
    const p2 = phoneStart(staticKey.publicKey);
    b.pipe.handleData(JSON.stringify(p2.hello));
    b.pipe.handleClose();
    expect(b.closedConnection()).toBe(true);
    expect(b.ended()).toBe(1);
    expect(b.sent).toHaveLength(1);
  });
});
