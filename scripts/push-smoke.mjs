#!/usr/bin/env node
/**
 * Push notifications, end to end, against a RUNNING daemon whose push route is a relay you started yourself.
 * Acts as a phone: pairs, says hello, registers for pushes with a made-up device token and a push key of its own,
 * then asks the daemon for a test push and opens what the daemon sealed... as far as the relay lets it get:
 * a relay without a push key answers 503, and this script then checks that the daemon says so.
 *
 *   PORT=8799 GRENADE_RELAY_PUSH_UPSTREAM=off npm start          # in ../grenade-relay: a relay that cannot push
 *   node dist/cli.js --control-port 7790 daemon --port 7799 --no-advertise --terminal none --no-relay &
 *   node dist/cli.js --control-port 7790 push on http://127.0.0.1:8799
 *   node scripts/push-smoke.mjs --port 7799 --control-port 7790 --expect push_unavailable
 *
 * With `--expect sent` it wants the relay to take the push (a relay with a push key, or a fake one).
 * It never talks to the main relay or to Apple by itself: where pushes go is the daemon's `grenade push on <url>`.
 */
import { randomBytes } from "node:crypto";
import WebSocket from "ws";
import { generateX25519, phoneStart } from "../dist/relay/e2e.js";

const arg = (name, dflt) => { const i = process.argv.indexOf(`--${name}`); return i === -1 ? dflt : process.argv[i + 1]; };
const PORT = Number(arg("port", "7788"));
const CONTROL = Number(arg("control-port", "7789"));
const EXPECT = arg("expect", "push_unavailable");
const ctl = (method, path, body) => fetch(`http://127.0.0.1:${CONTROL}${path}`, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : null }).then((r) => r.json());
const fail = (msg) => { console.error("FAIL:", msg); process.exit(1); };

const status = await ctl("GET", "/push").catch(() => fail("the daemon does not answer on its control port"));
if (!status.enabled) fail("push is off on this daemon: grenade push on <url of your relay>");
if (/relay\.holdgrenade\.com|grenade-relay-.*herokuapp/.test(status.gateway ?? "")) fail(`this daemon pushes through ${status.gateway}; point it at a relay of your own for this test`);
console.log("push route", status.gateway);

const client = { name: "push-smoke", platform: "test", version: "0" };
const health = await fetch(`http://127.0.0.1:${PORT}/health`).then((r) => r.json());
const daemonKey = Buffer.from(health.key, "base64");

function encrypted(first, onFrame) {
  const socket = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  const start = phoneStart(daemonKey);
  let channel = null;
  const send = (f) => socket.send(channel.seal(JSON.stringify(f)));
  socket.on("open", () => socket.send(JSON.stringify(start.hello)));
  socket.on("message", (raw) => {
    const text = raw.toString();
    if (channel) return onFrame(JSON.parse(channel.open(text)), send);
    channel = start.finish(JSON.parse(text));
    send(first);
  });
  return { socket };
}

const minted = await ctl("POST", "/pair-code");
const pair = await new Promise((resolve) => {
  const { socket } = encrypted({ type: "pair", protocol: 1, code: minted.code, client }, (f) => {
    socket.close();
    resolve(f);
  });
});
if (pair.type !== "paired" || !pair.token) fail(`pair: ${JSON.stringify(pair)}`);
console.log("paired with", pair.daemon.name);

const pushKey = generateX25519();
const register = {
  type: "push.register",
  provider: "apns",
  deviceToken: randomBytes(32).toString("hex"),
  environment: "sandbox",
  topic: "com.holdgrenade.grenade",
  key: pushKey.publicKey.toString("base64"),
  events: ["answer", "done"],
};

const timer = setTimeout(() => fail("timeout"), 20000);
let unpairing = false;
const { socket } = encrypted({ type: "hello", protocol: 1, token: pair.token, client }, async (f, send) => {
  // The daemon says goodbye to a phone it unpairs.
  if (f.type === "error" && unpairing && f.code === "unauthorized") return;
  if (f.type === "error") fail(`error frame ${JSON.stringify(f)}`);
  if (f.type === "welcome") send(register);
  if (f.type !== "push.state") return;
  if (!f.registered || f.delivery !== "gateway" || f.events.join() !== "answer,done") fail(`push.state: ${JSON.stringify(f)}`);
  console.log("registered:", JSON.stringify(f));

  const listed = await ctl("GET", "/push");
  if (listed.devices.length < 1) fail(`the daemon lists no registered phone: ${JSON.stringify(listed)}`);
  if (JSON.stringify(listed).includes(register.deviceToken)) fail("the control API gives the device token away");

  const results = await ctl("POST", "/push/test");
  const mine = results.find((r) => listed.devices.some((d) => d.id === r.device));
  console.log("test push:", JSON.stringify(results));
  if (!mine) fail("no result for this phone");
  const got = mine.outcome === "sent" ? "sent" : mine.error;
  if (got !== EXPECT) fail(`expected ${EXPECT}, the relay answered ${got} (${mine.outcome})`);

  // Leave nothing behind: unpairing takes the registration with it.
  const devices = await ctl("GET", "/devices");
  const me = devices.find((d) => d.name === client.name);
  unpairing = true;
  if (me) await ctl("DELETE", `/devices/${me.id}`);
  const after = await ctl("GET", "/push");
  if (after.devices.some((d) => d.id === me?.id)) fail("the registration outlived the pairing");
  console.log("unpaired; registration gone");
  clearTimeout(timer);
  socket.close();
  console.log("PUSH SMOKE OK");
  process.exit(0);
});
