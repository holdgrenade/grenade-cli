/**
 * Paired phones as the Mac's owner sees them (`grenade devices`, `grenade unpair`). Pure: the token store and the
 * live connections come in as plain data.
 */
import type { TokenRecord } from "./pairing.js";

export type Route = "lan" | "relay";

/** One paired phone, without its token. */
export interface Device {
  id: string;
  name: string;
  platform: string;
  version: string;
  pairedAt: string;
  lastSeen: string;
  /** Routes it is connected on right now, each once. */
  connected: Route[];
  /** It has connected encrypted, so plain connections from it are refused. */
  sealed: boolean;
}

export function deviceOf(record: TokenRecord, connected: Route[]): Device {
  return {
    id: record.id,
    name: record.client.name,
    platform: record.client.platform,
    version: record.client.version,
    pairedAt: record.issuedAt,
    lastSeen: record.lastSeen,
    connected: [...new Set(connected)].sort(),
    sealed: record.sealed === true,
  };
}

export type DeviceMatch = { found: Device } | { found: null; candidates: Device[] };

/**
 * The device a person meant by `query`: its id, else its exact name (any case), else the only one whose id or name
 * starts with it. More than one match is never guessed at: the candidates come back instead.
 */
export function matchDevice(query: string, devices: Device[]): DeviceMatch {
  const q = query.trim().toLowerCase();
  if (!q) return { found: null, candidates: [] };
  const tiers = [
    devices.filter((d) => d.id.toLowerCase() === q),
    devices.filter((d) => d.name.toLowerCase() === q),
    devices.filter((d) => d.id.toLowerCase().startsWith(q) || d.name.toLowerCase().startsWith(q)),
  ];
  for (const tier of tiers) {
    if (tier.length === 1 && tier[0]) return { found: tier[0] };
    if (tier.length > 1) return { found: null, candidates: tier };
  }
  return { found: null, candidates: [] };
}

/** "2 min ago", "3 days ago". For the device list. */
export function ago(iso: string, now: number): string {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)} h ago`;
  const days = Math.floor(s / 86_400);
  return days === 1 ? "1 day ago" : `${days} days ago`;
}
