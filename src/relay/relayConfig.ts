/**
 * `~/.grenade/relay.json`: which relay this Mac uses and its identity there (PROTOCOL.md "Identity").
 * `relayConfigFor` and the URL helpers are pure; load/save/remove own the file.
 */
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { DaemonInfo } from "@grenade/protocol";

export interface RelayConfig {
  /** Base URL, `https://…` (or `http://` for local testing), no trailing slash. */
  url: string;
  /** Registration key, for relays that require one. */
  key?: string;
  /** This Mac's address on the relay: `r_` + 32 hex. */
  id: string;
  /** Proves the id is ours: 64 hex. The relay keeps only its SHA-256. */
  secret: string;
}

/** Accepts `relay.example.com`, `https://relay.example.com/`, `wss://…`; returns `https://relay.example.com`. */
export function normalizeRelayUrl(input: string): string {
  let s = input.trim();
  if (!/^[a-z]+:\/\//i.test(s)) s = `https://${s}`;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    throw new Error(`not a relay URL: ${input}`);
  }
  const scheme = { "https:": "https:", "wss:": "https:", "http:": "http:", "ws:": "http:" }[u.protocol];
  if (!scheme || !u.hostname) throw new Error(`not a relay URL: ${input}`);
  const path = u.pathname.replace(/\/+$/, "");
  return `${scheme}//${u.host}${path}`;
}

/** `https://relay.example.com` + `/v1/daemon` → `wss://relay.example.com/v1/daemon`. */
export function relayWsUrl(base: string, path: string): string {
  return base.replace(/^http/, "ws") + path;
}

/** Keeps the id and secret while the URL stays the same; a new relay gets a new identity. */
export function relayConfigFor(
  url: string,
  key: string | undefined,
  previous: RelayConfig | null,
  random: (bytes: number) => string = (n) => randomBytes(n).toString("hex"),
): RelayConfig {
  const same = previous?.url === url;
  const id = same && previous ? previous.id : `r_${random(16)}`;
  const secret = same && previous ? previous.secret : random(32);
  const k = key ?? (same ? previous?.key : undefined);
  return k ? { url, key: k, id, secret } : { url, id, secret };
}

/** Sets or clears `info.relay` in place, so every later pair reply and welcome carries it. */
export function applyRelayInfo(info: DaemonInfo, config: RelayConfig | null): void {
  if (config) info.relay = { url: config.url, id: config.id };
  else delete info.relay;
}

export function loadRelayConfig(path: string): RelayConfig | null {
  if (!existsSync(path)) return null;
  try {
    const j = JSON.parse(readFileSync(path, "utf8")) as Partial<RelayConfig>;
    if (typeof j.url !== "string" || !/^r_[0-9a-f]{32}$/.test(j.id ?? "") || !/^[0-9a-f]{64}$/.test(j.secret ?? "")) return null;
    const c: RelayConfig = { url: j.url, id: j.id as string, secret: j.secret as string };
    if (typeof j.key === "string" && j.key) c.key = j.key;
    return c;
  } catch {
    return null;
  }
}

export function saveRelayConfig(path: string, config: RelayConfig): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
}

export function removeRelayConfig(path: string): void {
  rmSync(path, { force: true });
}
