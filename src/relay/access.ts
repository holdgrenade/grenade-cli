/**
 * A phone proves to the relay that it paired with this Mac without showing its token (PROTOCOL.md "Identity").
 * The daemon uploads `accessHash` of every paired token; the phone sends `accessKey`. Pure.
 */
import { createHash, createHmac } from "node:crypto";
import { RELAY_ACCESS_MESSAGE } from "@grenade/protocol";

export function accessKey(token: string): string {
  return createHmac("sha256", token).update(RELAY_ACCESS_MESSAGE).digest("hex");
}

export function accessHash(token: string): string {
  return createHash("sha256").update(accessKey(token)).digest("hex");
}
