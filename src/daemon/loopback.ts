/** Whether a socket's remote address is this Mac itself. Routes that only local processes may call check it. Pure. */
export function isLoopback(address: string | undefined): boolean {
  if (!address) return false;
  const a = address.startsWith("::ffff:") ? address.slice(7) : address;
  return a === "::1" || a === "127.0.0.1" || a.startsWith("127.");
}

/** The one `Origin` let through: the Chrome extension's, a single `chrome-extension://<id>`. */
const EXTENSION_ORIGIN = /^chrome-extension:\/\/[a-z0-9]+$/i;

/**
 * Whether a request came from a web page, and so is refused. The CLI, the apps and the hooks send no `Origin`; the
 * Chrome extension's is `chrome-extension://<id>`. Every other `Origin` is a browser's, whatever it says: `http:`,
 * `https:`, the `null` of a sandboxed frame or a `file:` page, or one not thought of yet. A page must never drive the
 * daemon, even from this Mac's own browser. Pure.
 */
export function fromWebPage(origin: string | string[] | undefined): boolean {
  if (origin === undefined) return false;
  const values = Array.isArray(origin) ? origin : [origin];
  return !values.every((v) => EXTENSION_ORIGIN.test(v.trim()));
}
