/** Whether a socket's remote address is this Mac itself. Routes that only local processes may call check it. Pure. */
export function isLoopback(address: string | undefined): boolean {
  if (!address) return false;
  const a = address.startsWith("::ffff:") ? address.slice(7) : address;
  return a === "::1" || a === "127.0.0.1" || a.startsWith("127.");
}

/**
 * Whether a request came from a web page: browsers send an `Origin` on every cross-site request, and a page's is
 * `http:` or `https:`. The CLI, the apps and the hooks send none; the Chrome extension's is `chrome-extension:`.
 * A page must never drive the daemon, even from this Mac's own browser. Pure.
 *
 * SECURITY: treat the literal string `null` (which browsers send for sandboxed iframes and some file:// requests)
 * as coming from a web page and refuse it. Previously only http/https were checked, leaving `Origin: null` able to
 * drive the control API. This tightens that check to block those cases while allowing chrome-extension:// origins.
 */
export function fromWebPage(origin: string | string[] | undefined): boolean {
  const value = Array.isArray(origin) ? origin[0] : origin;
  if (value === undefined) return false;
  const v = value.trim();
  if (v.toLowerCase() === "null") return true;
  return /^https?:/i.test(v);
}
