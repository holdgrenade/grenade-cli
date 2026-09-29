/** The Mac's own IPv4 addresses, as reported to the relay. Pure over an `os.networkInterfaces()` result. */
import type { NetworkInterfaceInfo } from "node:os";

export const MAX_LOCAL_IPS = 16;

export function localIpv4(interfaces: NodeJS.Dict<NetworkInterfaceInfo[]>): string[] {
  const out: string[] = [];
  for (const list of Object.values(interfaces)) {
    for (const a of list ?? []) {
      // Node reports family as "IPv4" (newer) or 4 (18.0–18.3).
      const v4 = a.family === "IPv4" || (a.family as unknown) === 4;
      if (!v4 || a.internal || a.address.startsWith("169.254.")) continue;
      if (!out.includes(a.address)) out.push(a.address);
    }
  }
  return out.slice(0, MAX_LOCAL_IPS);
}
