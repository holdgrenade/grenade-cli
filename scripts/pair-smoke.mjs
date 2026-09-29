#!/usr/bin/env node
/**
 * Acts as a PHONE that scanned the QR code of `grenade pair` (PROTOCOL.md "Pairing offer (QR code)"): reads the
 * offer, reaches the daemon the way the offer says, pairs with the offer's secret inside the encrypted channel,
 * then says hello with the new token. Node's crypto and `ws` only, so it checks the daemon against the protocol
 * and not against its own code.
 *
 *   node scripts/pair-smoke.mjs --control-port 7790                 # asks the daemon for an offer, pairs on this Mac
 *   node scripts/pair-smoke.mjs --control-port 7790 --via relay     # the same through the offer's relay
 *   node scripts/pair-smoke.mjs --offer 'grenade://pair?…' --via relay
 */
import { createCipheriv, createDecipheriv, createHmac, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync } from "node:crypto";
import WebSocket from "ws";

const arg = (name) => { const i = process.argv.indexOf(`--${name}`); return i === -1 ? undefined : process.argv[i + 1]; };
const fail = (msg) => { console.error("FAIL:", msg); process.exit(1); };
const client = { name: "pair-smoke", platform: "test", version: "0" };

const via = arg("via") ?? "lan";
let url = arg("offer");
if (!url) {
  const control = Number(arg("control-port") ?? "7789");
  const minted = await fetch(`http://127.0.0.1:${control}/pair-code`, { method: "POST" }).then((r) => r.json());
  if (!minted.offer) fail("the daemon gave no offer; is it older than pairing offers?");
  url = minted.offer;
}

// The offer, read the way a phone reads it: nothing here comes from the daemon's own code.
if (!url.startsWith("grenade://pair?")) fail(`not an offer: ${url}`);
const q = new URLSearchParams(url.slice("grenade://pair?".length));
if (q.get("v") !== "1") fail(`offer version ${q.get("v")}`);
const offer = {
  id: q.get("id"),
  name: q.get("n"),
  key: Buffer.from(q.get("k") ?? "", "base64url"),
  secret: q.get("s") ?? "",
  hosts: (q.get("h") ?? "").split(",").filter(Boolean),
  port: Number(q.get("p")),
  relay: q.get("r") && q.get("ri") ? { url: q.get("r"), id: q.get("ri") } : null,
};
if (offer.key.length !== 32) fail("the offer's key is not 32 bytes");
if (!/^[A-Za-z0-9_-]{22}$/.test(offer.secret)) fail("the offer's secret is not 22 base64url characters");
console.log(`offer from "${offer.name}" (${offer.id}), hosts ${offer.hosts.join(", ") || "none"}, port ${offer.port}, relay ${offer.relay?.url ?? "none"}`);

let socket;
if (via === "relay") {
  if (!offer.relay) fail("the offer has no relay (grenade relay on)");
  const access = createHmac("sha256", offer.secret).update("grenade relay access v1").digest("hex");
  socket = new WebSocket(`${offer.relay.url.replace(/^http/, "ws")}/v1/connect/${offer.relay.id}`, { headers: { authorization: `Bearer ${access}` } });
} else {
  // This Mac is always one of the places the daemon listens on, whatever the offer's hosts are.
  socket = new WebSocket(`ws://${arg("host") ?? "127.0.0.1"}:${offer.port}/ws`);
}

// X25519 + HKDF + ChaCha20-Poly1305, as in PROTOCOL.md, against the key FROM THE OFFER.
const pubKey = (raw) => createPublicKey({ key: { kty: "OKP", crv: "X25519", x: raw.toString("base64url") }, format: "jwk" });
const { privateKey: ce } = generateKeyPairSync("x25519");
const cePub = Buffer.from(createPublicKey(ce).export({ format: "jwk" }).x, "base64url");
const nonce = (n) => { const b = Buffer.alloc(12); b.writeBigUInt64BE(BigInt(n), 4); return b; };
let sent = 0, received = 0, sendKey, recvKey;
const seal = (text) => { const c = createCipheriv("chacha20-poly1305", sendKey, nonce(sent++), { authTagLength: 16 }); return Buffer.concat([c.update(text, "utf8"), c.final(), c.getAuthTag()]).toString("base64"); };
const open = (b64) => { const b = Buffer.from(b64, "base64"); const d = createDecipheriv("chacha20-poly1305", recvKey, nonce(received++), { authTagLength: 16 }); d.setAuthTag(b.subarray(-16)); return Buffer.concat([d.update(b.subarray(0, -16)), d.final()]).toString("utf8"); };

const timer = setTimeout(() => fail("not paired within 10 s"), 10_000);
socket.on("unexpected-response", (_req, res) => fail(`connect refused: HTTP ${res.statusCode}`));
socket.on("error", (e) => fail(`socket: ${e.message}`));
socket.on("close", (code, reason) => fail(`closed ${code} ${reason}`));
socket.on("open", () => socket.send(JSON.stringify({ e2e: 1, e: cePub.toString("base64") })));
let token;
socket.on("message", (data) => {
  const text = data.toString();
  if (!sendKey) {
    const dePub = Buffer.from(JSON.parse(text).e, "base64");
    const ikm = Buffer.concat([diffieHellman({ privateKey: ce, publicKey: pubKey(offer.key) }), diffieHellman({ privateKey: ce, publicKey: pubKey(dePub) })]);
    const okm = Buffer.from(hkdfSync("sha256", ikm, Buffer.concat([cePub, offer.key, dePub]), "grenade e2e v1", 64));
    sendKey = okm.subarray(0, 32);
    recvKey = okm.subarray(32);
    return socket.send(seal(JSON.stringify({ type: "pair", protocol: 1, secret: offer.secret, client })));
  }
  const frame = JSON.parse(open(text));
  if (frame.type === "error") fail(`daemon error: ${frame.code} ${frame.message}`);
  if (frame.type === "paired") {
    if (frame.daemon.key !== offer.key.toString("base64")) fail("the daemon answered with another key than the offer's");
    if (frame.daemon.id !== offer.id) fail("the daemon answered with another id than the offer's");
    token = frame.token;
    console.log(`paired via ${via}, token ${token.slice(0, 8)}…`);
    return socket.send(seal(JSON.stringify({ type: "hello", protocol: 1, token, client })));
  }
  if (frame.type === "welcome") console.log("welcome (decrypted)", JSON.stringify(frame.daemon));
  if (frame.type === "sessions" && token) {
    clearTimeout(timer);
    socket.removeAllListeners("close");
    socket.close();
    console.log("PAIR SMOKE OK");
    process.exit(0);
  }
});
