#!/usr/bin/env node
/**
 * End-to-end smoke test against a RUNNING daemon. Creates a shell session, pairs,
 * subscribes, sends `echo hello-grenade`, and checks that the screen and status frames arrive. Then prints 3000
 * numbered lines and pages back through them with `history` frames to check scrollback is contiguous. Finally it
 * uploads a 1 MiB `attachment` and checks the file the daemon names is really on disk with those bytes.
 * Everything is encrypted like a phone's traffic (PROTOCOL.md "On the local network"), pairing included: the typed
 * code is checked against the daemon's key first, then sent in a sealed `pair` frame. It also checks that a plain
 * `hello` and a plain POST /pair are refused. At the end it unpairs itself on the Mac side and checks that the
 * connection is closed and the token refused.
 *
 *   node dist/cli.js --control-port 7790 daemon --port 7799 &
 *   node scripts/smoke.mjs --port 7799 --control-port 7790
 */
import { createHmac, randomBytes } from "node:crypto";
import { statSync } from "node:fs";
import WebSocket from "ws";
import { phoneStart } from "../dist/relay/e2e.js";

const arg = (name, dflt) => { const i = process.argv.indexOf(`--${name}`); return i === -1 ? dflt : process.argv[i + 1]; };
const PORT = Number(arg("port", "7788"));
const CONTROL = Number(arg("control-port", "7789"));
const NAME = "smoke";
const ID = `gr-${NAME}`;
const ctl = (method, path, body) => fetch(`http://127.0.0.1:${CONTROL}${path}`, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : null }).then((r) => r.json());
const fail = (msg) => { console.error("FAIL:", msg); process.exit(1); };

await ctl("DELETE", `/sessions/${ID}`).catch(() => {});
const created = await ctl("POST", "/sessions", { name: NAME, cwd: "/tmp", agent: "shell" });
if (created.id !== ID) fail(`create: ${JSON.stringify(created)}`);
console.log("created", created.id, created.status);

const client = { name: "smoke", platform: "test", version: "0" };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const health = await fetch(`http://127.0.0.1:${PORT}/health`).then((r) => r.json());
if (health.e2e !== 1 || !health.key) fail(`the daemon does not advertise encryption: ${JSON.stringify(health)}`);
const daemonKey = Buffer.from(health.key, "base64");

/** A socket that has done the handshake. `first` is sent sealed once it is up; `onFrame` gets each decrypted frame. */
function encrypted(first, onFrame, onClose = () => {}) {
  const socket = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  const start = phoneStart(daemonKey);
  let channel = null;
  const send = (f) => socket.send(channel.seal(JSON.stringify(f)));
  socket.on("open", () => socket.send(JSON.stringify(start.hello)));
  socket.on("close", (code) => onClose(code));
  socket.on("message", (raw) => {
    const text = raw.toString();
    if (channel) return onFrame(JSON.parse(channel.open(text)), send);
    if (text.includes('"type"')) fail(`the daemon answered the handshake in plain: ${text}`);
    channel = start.finish(JSON.parse(text));
    send(first);
  });
  return { socket, send };
}

/** One frame in plain, as a phone that predates encryption would send it. Resolves with the daemon's answer. */
function plain(frame) {
  return new Promise((resolve) => {
    const socket = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    socket.on("open", () => socket.send(JSON.stringify(frame)));
    socket.on("message", (raw) => resolve(JSON.parse(raw.toString())));
    socket.on("close", () => resolve(null));
  });
}

// Pair like a phone: check the typed code against the key, then send the code sealed.
const minted = await ctl("POST", "/pair-code");
const mac = createHmac("sha256", minted.code).update(Buffer.concat([Buffer.from("grenade pair check v1", "utf8"), daemonKey])).digest();
const check = String(mac.readUInt32BE(0) % 10000).padStart(4, "0");
if (minted.typed !== minted.code + check) fail(`typed code ${minted.typed} does not carry the check digits ${check} of this daemon's key`);
const plainPair = await fetch(`http://127.0.0.1:${PORT}/pair`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: "000000", client }) });
if (plainPair.status !== 426) fail(`plain POST /pair answered ${plainPair.status}, expected 426 (is the daemon running with --allow-plain-lan?)`);
const pair = await new Promise((resolve) => {
  const { socket } = encrypted({ type: "pair", protocol: 1, code: minted.code, client }, (f) => {
    socket.close();
    resolve(f);
  });
});
if (pair.type !== "paired" || !pair.token) fail(`pair: ${JSON.stringify(pair)}`);
console.log("paired with", pair.daemon.name, "(typed code", minted.typed + ", sealed)");
const refusedPlain = await plain({ type: "hello", protocol: 1, token: pair.token, client });
if (refusedPlain?.type !== "error" || refusedPlain.code !== "unsupported_protocol") fail(`a plain hello was not refused: ${JSON.stringify(refusedPlain)}`);
console.log("plain hello refused:", refusedPlain.code);

let closedWith = null;
let unpairing = false;
const { send } = encrypted({ type: "hello", protocol: 1, token: pair.token, client }, onFrame, (code) => (closedWith = code));
const statuses = [created.status];
let phase = "hello";
let history = { epoch: 0, oldest: 0, first: "", pages: 0 };
let attachment = Buffer.alloc(0);
const timer = setTimeout(() => fail(`timeout in phase ${phase}; statuses ${statuses.join(" → ")}`), 10000);

async function onFrame(f) {
  if (f.type === "error" && unpairing && f.code === "unauthorized") return console.log("told:", f.code, JSON.stringify(f.message));
  if (f.type === "error") fail(`error frame ${JSON.stringify(f)}`);
  if (f.type === "welcome") { console.log("welcome", f.daemon.id); phase = "subscribe"; send({ type: "subscribe", sessionId: ID }); send({ type: "ping", t: 7 }); }
  if (f.type === "pong") console.log("pong", f.t);
  if (f.type === "session.updated" && f.session.id === ID && statuses.at(-1) !== f.session.status) statuses.push(f.session.status);
  if (f.type === "screen" && phase === "subscribe") { phase = "input"; console.log("initial screen seq", f.seq, JSON.stringify(f.lines.slice(-1))); send({ type: "input", sessionId: ID, text: "echo hello-grenade", submit: true }); }
  if (f.type === "screen" && phase === "input" && f.lines.filter((l) => l.includes("hello-grenade")).length >= 2) {
    phase = "scroll";
    console.log("screen seq", f.seq, `${f.cols}x${f.rows}`, "cursor", JSON.stringify(f.cursor), "tail", JSON.stringify(f.lines.slice(-2)));
    send({ type: "input", sessionId: ID, text: "seq -f 'n%g' 1 3000", submit: true });
  }
  if (f.type === "screen" && phase === "scroll" && f.lines.includes("n3000")) {
    if (typeof f.start !== "number" || typeof f.epoch !== "number") fail(`screen without start/epoch: ${JSON.stringify({ start: f.start, epoch: f.epoch })}`);
    phase = "history";
    history = { epoch: f.epoch, oldest: f.start, first: f.lines[0], pages: 0 };
    console.log("scrolled screen start", f.start, "epoch", f.epoch, "first", JSON.stringify(f.lines[0]));
    send({ type: "history", sessionId: ID, before: f.start, count: 2000 });
  }
  if (f.type === "history" && phase === "history") {
    if (f.epoch !== history.epoch) fail(`history epoch ${f.epoch} != screen epoch ${history.epoch}`);
    const end = f.start + f.lines.length;
    if (f.lines.length === 0 || end < history.oldest) fail(`history gap: got ${f.start}..<${end}, wanted up to ${history.oldest}`);
    const rows = f.lines.slice(0, history.oldest - f.start);
    // The row just before the one we held must be the previous number, so pages join without a gap or overlap.
    const next = Number(history.first.slice(1));
    const last = rows.at(-1) ?? "";
    if (next > 1 && last !== `n${next - 1}`) fail(`history does not join: last ${JSON.stringify(last)} before ${JSON.stringify(history.first)}`);
    // Rows above n1 are the prompt and the commands typed before `seq`, so n1 is rarely the very first row.
    history = { ...history, oldest: f.start, first: rows[0] ?? history.first, pages: history.pages + 1, sawFirst: history.sawFirst || rows.includes("n1") };
    console.log("history page", history.pages, `${f.start}..<${end}`, JSON.stringify(rows[0]), "…", JSON.stringify(last));
    if (f.start > 0 && !history.sawFirst) return send({ type: "history", sessionId: ID, before: f.start, count: 2000 });
    if (!history.sawFirst) {
      // Reached the top of tmux history; n1 must be in it since 3000 < history-limit.
      fail(`reached the top without n1; oldest row ${JSON.stringify(history.first)}`);
    }
    phase = "attachment";
    attachment = randomBytes(1024 * 1024);
    send({ type: "attachment", id: "smoke-1", sessionId: ID, name: "shot (1).png", mime: "image/png", data: attachment.toString("base64") });
  }
  if (f.type === "attachment.saved" && phase === "attachment") {
    if (f.id !== "smoke-1" || f.sessionId !== ID) fail(`attachment.saved for the wrong upload: ${JSON.stringify(f)}`);
    if (f.bytes !== attachment.length) fail(`attachment.saved bytes ${f.bytes} != ${attachment.length}`);
    const size = statSync(f.path).size;
    if (size !== attachment.length) fail(`file ${f.path} is ${size} bytes, sent ${attachment.length}`);
    if (!f.path.endsWith("-shot-1.png") || !f.path.includes(`/attachments/${ID}/`)) fail(`unexpected attachment path ${f.path}`);
    console.log("attachment saved at", f.path, "bytes", f.bytes);
    phase = "settle";
    setTimeout(() => { send({ type: "seen", sessionId: ID }); setTimeout(finish, 400); }, 2200);
  }
}

/** Unpairs this script's token on the Mac side: the open connection must close, and a new one must be refused. */
async function unpair() {
  phase = "unpair";
  unpairing = true;
  const me = (await ctl("GET", "/devices")).find((d) => d.name === client.name && d.connected.includes("lan"));
  if (!me) fail("this connection is not in GET /devices as connected on the LAN");
  if (!me.sealed) fail("the device is not marked as encrypted");
  const gone = await ctl("DELETE", `/devices/${me.id}`);
  if (!gone.ok || gone.closed !== 1) fail(`unpair: ${JSON.stringify(gone)}`);
  for (let i = 0; i < 50 && closedWith === null; i++) await wait(20);
  if (closedWith !== 4001) fail(`the connection was not closed with 4001 after the unpair (got ${closedWith})`);
  let refused = null;
  encrypted({ type: "hello", protocol: 1, token: pair.token, client }, (f) => (refused = f));
  for (let i = 0; i < 50 && refused === null; i++) await wait(20);
  if (refused?.type !== "error" || refused.code !== "unauthorized") fail(`the unpaired token was not refused: ${JSON.stringify(refused)}`);
  console.log("unpaired", me.id, "→ connection closed, token refused");
}

async function finish() {
  await unpair();
  clearTimeout(timer);
  await ctl("DELETE", `/sessions/${ID}`);
  const left = await ctl("GET", "/sessions");
  console.log("status transitions:", statuses.join(" → "));
  const ok = statuses.includes("working") && statuses.includes("waiting") && statuses.at(-1) === "idle" && !left.some((s) => s.id === ID);
  console.log(ok ? "SMOKE OK" : "SMOKE FAILED");
  process.exit(ok ? 0 : 1);
}
