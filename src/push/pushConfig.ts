/**
 * `~/.grenade/push.json`: whether this Mac sends push notifications and through which relay's push route
 * (PROTOCOL.md "Which route a daemon uses"). No file means `auto`: on while this Mac uses a relay for remote
 * access, off otherwise, so a Mac that talks to no relay does not start to because of push.
 * `pushGatewayFor` is pure; load/save own the file.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { OFFICIAL_RELAY_URL } from "@grenade/protocol";
import { normalizeRelayUrl, type RelayConfig } from "../relay/relayConfig.js";
import { AT_MAC_MS } from "./pushPolicy.js";

/** What the user chose: `on` and `off` were asked for (`grenade push on|off`); `auto` follows remote access. */
export type PushMode = "on" | "off" | "auto";

export interface PushConfig {
  /** True after `grenade push on`, false after `grenade push off`. Absent: on while this Mac uses a relay. */
  enabled?: boolean;
  /** A push route other than the default: the base URL of a relay. */
  url?: string;
  /** That relay's registration key, when it requires one. */
  key?: string;
  /** Hold pushes while the Mac was used within this many seconds. 0 never holds. */
  atMacSeconds?: number;
}

export const DEFAULT_PUSH_CONFIG: PushConfig = {};

export function pushMode(config: PushConfig): PushMode {
  return config.enabled === undefined ? "auto" : config.enabled ? "on" : "off";
}

export interface PushGateway {
  /** Base URL of the relay whose push route takes the pushes. */
  url: string;
  key?: string;
}

/**
 * Where pushes go, or null when none are sent. Off when turned off, and when nobody chose (`auto`) on a Mac
 * without a relay. Otherwise the chosen route, else the relay this Mac uses for remote access, else (only after
 * `grenade push on`) the main relay.
 */
export function pushGatewayFor(config: PushConfig, relay: RelayConfig | null): PushGateway | null {
  const mode = pushMode(config);
  if (mode === "off" || (mode === "auto" && !relay)) return null;
  if (config.url) return config.key ? { url: config.url, key: config.key } : { url: config.url };
  if (relay) return relay.key ? { url: relay.url, key: relay.key } : { url: relay.url };
  return { url: OFFICIAL_RELAY_URL };
}

export function atMacMs(config: PushConfig): number {
  return config.atMacSeconds === undefined ? AT_MAC_MS : Math.max(0, config.atMacSeconds) * 1000;
}

/** `grenade push on [url] [--key K]`: keeps the hold time; a URL replaces the route, no URL goes back to the default. */
export function pushConfigOn(previous: PushConfig, url: string | undefined, key: string | undefined): PushConfig {
  const next: PushConfig = { enabled: true };
  if (url) {
    next.url = normalizeRelayUrl(url);
    const k = key ?? (previous.url === next.url ? previous.key : undefined);
    if (k) next.key = k;
  }
  if (previous.atMacSeconds !== undefined) next.atMacSeconds = previous.atMacSeconds;
  return next;
}

export function loadPushConfig(path: string): PushConfig {
  if (!existsSync(path)) return { ...DEFAULT_PUSH_CONFIG };
  try {
    const j = JSON.parse(readFileSync(path, "utf8")) as Partial<PushConfig>;
    const c: PushConfig = typeof j.enabled === "boolean" ? { enabled: j.enabled } : {};
    if (typeof j.url === "string" && j.url) c.url = j.url;
    if (typeof j.key === "string" && j.key) c.key = j.key;
    if (typeof j.atMacSeconds === "number" && Number.isFinite(j.atMacSeconds) && j.atMacSeconds >= 0) c.atMacSeconds = j.atMacSeconds;
    return c;
  } catch {
    return { ...DEFAULT_PUSH_CONFIG };
  }
}

export function savePushConfig(path: string, config: PushConfig): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
}
