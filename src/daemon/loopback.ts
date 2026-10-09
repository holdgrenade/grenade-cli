/** Whether a socket's remote address is this Mac itself. Routes that only local processes may call check it. Pure. */
export function isLoopback(address: string | undefined): boolean {
  if (!address) return false;
  const a = address.startsWith("::ffff:") ? address.slice(7) : address;
  return a === "::1" || a === "127.0.0.1" || a.startsWith("127.");
}

/**
 * Whether a request came from a web page. Browsers send an `Origin` on every cross-site request, and a page's can be
 * `http:`, `https:`, `file:` or the literal `null` (a sandboxed frame, a redirect). The CLI, the apps and the hooks
 * send none and the Chrome extension's is `chrome-extension:`, so those are the only ones let through: a page must
 * never drive the daemon, even from this Mac's own browser, whatever origin its browser gives it. Pure.
 */
export function fromWebPage(origin: string | string[] | undefined): boolean {
  const value = Array.isArray(origin) ? origin[0] : origin;
  if (value === undefined) return false;
  return !/^chrome-extension:/i.test(value.trim());
}
