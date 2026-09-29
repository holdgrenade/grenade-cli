/**
 * The check digits of a typed pairing code (PROTOCOL.md "Key check for typed codes"): they tie the 6-digit code to
 * this daemon's key, so a phone can tell the Mac from an impostor before it sends anything. Pure.
 */
import { createHmac } from "node:crypto";
import { PAIR_CHECK_MESSAGE } from "@grenade/protocol";

/** Four digits from the code and the daemon's raw 32-byte public key. */
export function pairCheck(code: string, daemonKey: Buffer): string {
  const mac = createHmac("sha256", code).update(Buffer.concat([Buffer.from(PAIR_CHECK_MESSAGE, "utf8"), daemonKey])).digest();
  return String(mac.readUInt32BE(0) % 10_000).padStart(4, "0");
}

/** What the Mac shows and a person types: the code, then its check digits. */
export function typedCode(code: string, daemonKey: Buffer): string {
  return code + pairCheck(code, daemonKey);
}

/** "4829137343" → "482 913 7343". */
export function spacedCode(typed: string): string {
  return [typed.slice(0, 3), typed.slice(3, 6), typed.slice(6)].filter(Boolean).join(" ");
}
