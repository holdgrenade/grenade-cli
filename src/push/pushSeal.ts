/**
 * Seals one push so that only the phone can read it and only this daemon can have written it
 * (PROTOCOL.md "Push encryption"). Pure: node:crypto only, the ephemeral key is injectable.
 */
import { createCipheriv, createHmac, createPublicKey, diffieHellman, hkdfSync, type KeyObject } from "node:crypto";
import { PUSH_COLLAPSE_MESSAGE, PUSH_INFO, type PushContent } from "@grenade/protocol";
import { generateX25519, type X25519Pair } from "../relay/e2e.js";

const TAG_BYTES = 16;
/** The key is used for one push, so the nonce never repeats under it. */
const NONCE = Buffer.alloc(12);

export interface SealedPush {
  /** The daemon's ephemeral public key for this push, base64. */
  e: string;
  /** base64(ciphertext ‖ tag). */
  c: string;
}

function dh(own: KeyObject, theirs: Buffer): Buffer {
  if (theirs.length !== 32) throw new Error("an X25519 public key is 32 bytes");
  const publicKey = createPublicKey({ key: { kty: "OKP", crv: "X25519", x: theirs.toString("base64url") }, format: "jwk" });
  return diffieHellman({ privateKey: own, publicKey });
}

/** `phoneKey` is the raw push key the phone registered. Throws on a malformed key. */
export function sealPush(content: PushContent, staticKey: X25519Pair, phoneKey: Buffer, ephemeral: X25519Pair = generateX25519()): SealedPush {
  return sealPushText(JSON.stringify(content), staticKey, phoneKey, ephemeral);
}

/** The same for exact bytes, so the test vectors can be reproduced. */
export function sealPushText(plaintext: string, staticKey: X25519Pair, phoneKey: Buffer, ephemeral: X25519Pair = generateX25519()): SealedPush {
  const ikm = Buffer.concat([dh(ephemeral.privateKey, phoneKey), dh(staticKey.privateKey, phoneKey)]);
  const salt = Buffer.concat([ephemeral.publicKey, staticKey.publicKey, phoneKey]);
  const key = Buffer.from(hkdfSync("sha256", ikm, salt, PUSH_INFO, 32));
  const cipher = createCipheriv("chacha20-poly1305", key, NONCE, { authTagLength: TAG_BYTES });
  const sealed = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final(), cipher.getAuthTag()]);
  return { e: ephemeral.publicKey.toString("base64"), c: sealed.toString("base64") };
}

/**
 * What lets a newer push for the same session replace the older one on the phone. It means nothing to the
 * relay: an HMAC of the session id under the pairing token. `subject` is the push id for a test push.
 */
export function collapseId(token: string, subject: string): string {
  return createHmac("sha256", token).update(PUSH_COLLAPSE_MESSAGE + subject, "utf8").digest("hex").slice(0, 32);
}
