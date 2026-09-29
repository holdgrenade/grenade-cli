/**
 * End-to-end encryption between a phone and this daemon through a relay (PROTOCOL.md "End-to-end encryption").
 * Pure: node:crypto only, no I/O, randomness injectable. The relay only ever sees `SealedChannel` output.
 */
import {
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  type KeyObject,
} from "node:crypto";
import { E2E_INFO, type E2EHello } from "@grenade/protocol";

const PKCS8_X25519_PREFIX = Buffer.from("302e020100300506032b656e04220420", "hex");
const TAG_BYTES = 16;

export interface X25519Pair {
  privateKey: KeyObject;
  /** Raw 32-byte public key. */
  publicKey: Buffer;
}

/** A private key from its raw 32 bytes. */
export function x25519FromRaw(raw: Buffer): X25519Pair {
  if (raw.length !== 32) throw new Error("an X25519 private key is 32 bytes");
  const privateKey = createPrivateKey({ key: Buffer.concat([PKCS8_X25519_PREFIX, raw]), format: "der", type: "pkcs8" });
  return { privateKey, publicKey: publicRaw(privateKey) };
}

export function generateX25519(): X25519Pair {
  const { privateKey } = generateKeyPairSync("x25519");
  return { privateKey, publicKey: publicRaw(privateKey) };
}

/** Raw 32 bytes of a private key, for storing it. */
export function privateRaw(key: KeyObject): Buffer {
  return Buffer.from(key.export({ format: "jwk" }).d as string, "base64url");
}

function publicRaw(key: KeyObject): Buffer {
  return Buffer.from(createPublicKey(key).export({ format: "jwk" }).x as string, "base64url");
}

function dh(own: KeyObject, theirs: Buffer): Buffer {
  if (theirs.length !== 32) throw new Error("an X25519 public key is 32 bytes");
  const publicKey = createPublicKey({ key: { kty: "OKP", crv: "X25519", x: theirs.toString("base64url") }, format: "jwk" });
  return diffieHellman({ privateKey: own, publicKey });
}

/** HKDF over both DH results; returns the two direction keys. */
function deriveKeys(ikm: Buffer, phoneEphemeral: Buffer, daemonStatic: Buffer, daemonEphemeral: Buffer) {
  const okm = Buffer.from(hkdfSync("sha256", ikm, Buffer.concat([phoneEphemeral, daemonStatic, daemonEphemeral]), E2E_INFO, 64));
  return { phoneToDaemon: okm.subarray(0, 32), daemonToPhone: okm.subarray(32, 64) };
}

/**
 * Daemon side: answers a phone's `{e2e:1, e}` with its own ephemeral key and returns the sealed channel.
 * Throws on a malformed key; the caller closes the pipe.
 */
export function daemonAccept(phoneHello: E2EHello, staticKey: X25519Pair, ephemeral: X25519Pair = generateX25519()) {
  const phoneEphemeral = Buffer.from(phoneHello.e, "base64");
  const ikm = Buffer.concat([dh(staticKey.privateKey, phoneEphemeral), dh(ephemeral.privateKey, phoneEphemeral)]);
  const keys = deriveKeys(ikm, phoneEphemeral, staticKey.publicKey, ephemeral.publicKey);
  const reply: E2EHello = { e2e: 1, e: ephemeral.publicKey.toString("base64") };
  return { reply, channel: new SealedChannel(keys.daemonToPhone, keys.phoneToDaemon) };
}

/** Phone side, for tests and tools: the hello to send, then `finish` with the daemon's reply. */
export function phoneStart(daemonStaticPublic: Buffer, ephemeral: X25519Pair = generateX25519()) {
  const hello: E2EHello = { e2e: 1, e: ephemeral.publicKey.toString("base64") };
  const finish = (reply: E2EHello): SealedChannel => {
    const daemonEphemeral = Buffer.from(reply.e, "base64");
    const ikm = Buffer.concat([dh(ephemeral.privateKey, daemonStaticPublic), dh(ephemeral.privateKey, daemonEphemeral)]);
    const keys = deriveKeys(ikm, ephemeral.publicKey, daemonStaticPublic, daemonEphemeral);
    return new SealedChannel(keys.phoneToDaemon, keys.daemonToPhone);
  };
  return { hello, finish };
}

/**
 * ChaCha20-Poly1305 with an implicit counter nonce per direction (4 zero bytes, then a big-endian u64).
 * `open` expects the very next counter, so a dropped, replayed or reordered frame fails and stays failed.
 */
export class SealedChannel {
  private sent = 0n;
  private received = 0n;
  private broken = false;

  constructor(private readonly sendKey: Buffer, private readonly receiveKey: Buffer) {}

  seal(text: string): string {
    const c = createCipheriv("chacha20-poly1305", this.sendKey, nonce(this.sent++), { authTagLength: TAG_BYTES });
    return Buffer.concat([c.update(text, "utf8"), c.final(), c.getAuthTag()]).toString("base64");
  }

  /** Throws when the frame does not open; after that every frame fails. */
  open(sealed: string): string {
    if (this.broken) throw new Error("channel is broken");
    try {
      const body = Buffer.from(sealed, "base64");
      if (body.length < TAG_BYTES) throw new Error("frame too short");
      const d = createDecipheriv("chacha20-poly1305", this.receiveKey, nonce(this.received), { authTagLength: TAG_BYTES });
      d.setAuthTag(body.subarray(body.length - TAG_BYTES));
      const text = Buffer.concat([d.update(body.subarray(0, body.length - TAG_BYTES)), d.final()]).toString("utf8");
      this.received++;
      return text;
    } catch (e) {
      this.broken = true;
      throw e;
    }
  }
}

function nonce(counter: bigint): Buffer {
  const n = Buffer.alloc(12);
  n.writeBigUInt64BE(counter, 4);
  return n;
}
