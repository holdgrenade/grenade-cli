/** The daemon's long-term X25519 key: `~/.grenade/e2e-key` (base64 of the raw 32 bytes, mode 0600), made on first start. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { generateX25519, privateRaw, x25519FromRaw, type X25519Pair } from "./e2e.js";

export function loadOrCreateE2EKey(path: string): X25519Pair {
  if (existsSync(path)) {
    const raw = Buffer.from(readFileSync(path, "utf8").trim(), "base64");
    if (raw.length === 32) return x25519FromRaw(raw);
  }
  const pair = generateX25519();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, privateRaw(pair.privateKey).toString("base64") + "\n", { mode: 0o600 });
  return pair;
}
