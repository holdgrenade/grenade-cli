/** Whether a socket's remote address is this Mac itself. Routes that only local processes may call check it. Pure. */
export function isLoopback(address: string | undefined): boolean {
  if (!address) return false;
  const a = address.startsWith("::ffff:") ? address.slice(7) : address;
  return a === "::1" || a === "127.0.0.1" || a.startsWith("127.");
}

/**
 * The Chrome extensions let through, by id: Grenade's own, fixed by the `key` in grenade-chrome's manifest
 * (`EXTENSION_KEY` in its `src/manifest.ts`). Any other extension, whatever it may reach, is refused. The Chrome Web
 * Store gives a listed extension its own id; it joins this list then.
 */
export const GRENADE_EXTENSION_IDS: readonly string[] = ["eiocljcomciaepiidgadhbbadmmnpdne"];

const EXTENSION_ORIGINS = new Set(GRENADE_EXTENSION_IDS.map((id) => `chrome-extension://${id}`));

/**
 * Whether a request came from a web page, or anything else a browser runs, and so is refused. The CLI, the apps and
 * the hooks send no `Origin`; Grenade's Chrome extension sends `chrome-extension://<its id>`. Every other `Origin` is
 * refused, whatever it says: `http:`, `https:`, the `null` of a sandboxed frame or a `file:` page, another extension.
 * A page must never drive the daemon, even from this Mac's own browser. Pure.
 */
export function fromWebPage(origin: string | string[] | undefined): boolean {
  if (origin === undefined) return false;
  const values = Array.isArray(origin) ? origin : [origin];
  return !values.every((v) => EXTENSION_ORIGINS.has(v.trim().toLowerCase()));
}

/**
 * Whether a request was addressed to this Mac by a loopback name. A page that points its own name at 127.0.0.1 (DNS
 * rebinding) reads replies as its own site, and a same-site GET carries no `Origin`; its `Host` is still its own name,
 * so the control API, which every client calls as `127.0.0.1`, answers no other. Pure.
 */
export function addressedToLoopback(host: string | undefined): boolean {
  if (!host) return false;
  const name = host.trim().toLowerCase().replace(/:\d+$/, "");
  return name === "127.0.0.1" || name === "localhost" || name === "[::1]";
}
