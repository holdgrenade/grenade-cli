#!/usr/bin/env node
/**
 * Acts as a PHONE reaching a daemon through a relay: checks presence, opens /v1/connect/<id>, does the
 * end-to-end handshake (PROTOCOL.md "End-to-end encryption"), sends a sealed hello, and expects a sealed welcome
 * and session list. Node's crypto and `ws` only.
 *
 * Pair locally first (like a phone on the same Wi‑Fi: the code goes in a sealed `pair` frame), then go through the relay:
 *   node scripts/relay-smoke.mjs --port 7799 --control-port 7790
 * Or with what a phone already stored:
 *   node scripts/relay-smoke.mjs --relay http://127.0.0.1:8787 --id r_… --token grt_… --key <daemon public key, base64>
 */
import { createCipheriv, createDecipheriv, createHash, createHmac, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync } from "node:crypto";
import WebSocket from "ws";

const arg = (name) => { const i = process.argv.indexOf(`--${name}`); return i === -1 ? undefined : process.argv[i + 1]; };
const fail = (msg) => { console.error("FAIL:", msg); process.exit(1); };

let relay = arg("relay"), id = arg("id"), token = arg("token"), key = arg("key");
if (!token) {
  const port = Number(arg("port") ?? "7788"), control = Number(arg("control-port") ?? "7789");
  const { code } = await fetch(`http://127.0.0.1:${control}/pair-code`, { method: "POST" }).then((r) => r.json());
  const health = await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.json());
  const { phoneStart } = await import("../dist/relay/e2e.js");
  const pair = await new Promise((resolve) => {
    const lan = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const start = phoneStart(Buffer.from(health.key, "base64"));
    let channel = null;
    lan.on("open", () => lan.send(JSON.stringify(start.hello)));
    lan.on("message", (data) => {
      if (channel) { lan.close(); return resolve(JSON.parse(channel.open(data.toString()))); }
      channel = start.finish(JSON.parse(data.toString()));
      lan.send(channel.seal(JSON.stringify({ type: "pair", protocol: 1, code, client: { name: "relay-smoke", platform: "test", version: "0" } })));
    });
  });
  if (pair.type !== "paired") fail(`pair: ${JSON.stringify(pair)}`);
  if (!pair.daemon.relay) fail("the daemon has no relay set (grenade relay on <url>)");
  ({ token } = pair);
  key = pair.daemon.key;
  relay ??= pair.daemon.relay.url;
  id = pair.daemon.relay.id;
  console.log("paired locally with", pair.daemon.name, "→ relay", relay, id);
}
if (!relay || !id || !token || !key) fail("need --relay --id --token --key, or --port/--control-port to pair locally");
relay = relay.replace(/\/+$/, "");

const access = createHmac("sha256", token).update("grenade relay access v1").digest("hex");
console.log("access hash", createHash("sha256").update(access).digest("hex").slice(0, 12) + "…");
const auth = { authorization: `Bearer ${access}` };

// Presence: the relay may need a moment after pairing to get the new access hash.
let presence;
for (let i = 0; i < 20; i++) {
  const r = await fetch(`${relay}/v1/presence/${id}`, { headers: auth });
  if (r.ok) { presence = await r.json(); break; }
  if (i === 19) fail(`presence: HTTP ${r.status} ${await r.text()}`);
  await new Promise((res) => setTimeout(res, 250));
}
console.log("presence", JSON.stringify(presence));
if (!presence.online) fail("daemon is offline on the relay");

// X25519 + HKDF + ChaCha20-Poly1305, as in PROTOCOL.md.
const pubKey = (raw) => createPublicKey({ key: { kty: "OKP", crv: "X25519", x: raw.toString("base64url") }, format: "jwk" });
const { privateKey: ce } = generateKeyPairSync("x25519");
const cePub = Buffer.from(createPublicKey(ce).export({ format: "jwk" }).x, "base64url");
const dsPub = Buffer.from(key, "base64");
const nonce = (n) => { const b = Buffer.alloc(12); b.writeBigUInt64BE(BigInt(n), 4); return b; };
let send = 0, recv = 0, sendKey, recvKey;
const seal = (text) => { const c = createCipheriv("chacha20-poly1305", sendKey, nonce(send++), { authTagLength: 16 }); return Buffer.concat([c.update(text, "utf8"), c.final(), c.getAuthTag()]).toString("base64"); };
const open = (b64) => { const b = Buffer.from(b64, "base64"); const d = createDecipheriv("chacha20-poly1305", recvKey, nonce(recv++), { authTagLength: 16 }); d.setAuthTag(b.subarray(-16)); return Buffer.concat([d.update(b.subarray(0, -16)), d.final()]).toString("utf8"); };

const ws = new WebSocket(`${relay.replace(/^http/, "ws")}/v1/connect/${id}`, { headers: auth });
const timer = setTimeout(() => fail("no welcome within 10 s"), 10_000);
ws.on("unexpected-response", (_req, res) => fail(`connect refused: HTTP ${res.statusCode}`));
ws.on("error", (e) => fail(`socket: ${e.message}`));
ws.on("close", (code, reason) => fail(`closed ${code} ${reason}`));
ws.on("open", () => ws.send(JSON.stringify({ e2e: 1, e: cePub.toString("base64") })));
let welcomed = false;
ws.on("message", (data) => {
  const text = data.toString();
  if (!sendKey) {
    const reply = JSON.parse(text);
    const dePub = Buffer.from(reply.e, "base64");
    const ikm = Buffer.concat([diffieHellman({ privateKey: ce, publicKey: pubKey(dsPub) }), diffieHellman({ privateKey: ce, publicKey: pubKey(dePub) })]);
    const okm = Buffer.from(hkdfSync("sha256", ikm, Buffer.concat([cePub, dsPub, dePub]), "grenade e2e v1", 64));
    sendKey = okm.subarray(0, 32);
    recvKey = okm.subarray(32);
    ws.send(seal(JSON.stringify({ type: "hello", protocol: 1, token, client: { name: "relay-smoke", platform: "test", version: "0" } })));
    return;
  }
  const frame = JSON.parse(open(text));
  if (frame.type === "error") fail(`daemon error: ${frame.code} ${frame.message}`);
  if (frame.type === "welcome") { welcomed = true; console.log("welcome (decrypted)", JSON.stringify(frame.daemon)); }
  if (frame.type === "sessions" && welcomed) {
    console.log("sessions", frame.sessions.length);
    clearTimeout(timer);
    ws.removeAllListeners("close");
    ws.close();
    console.log("RELAY SMOKE OK");
    process.exit(0);
  }
});
