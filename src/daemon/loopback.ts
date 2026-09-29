/** Whether a socket's remote address is this Mac itself. Routes that only local processes may call check it. Pure. */
export function isLoopback(address: string | undefined): boolean {
  if (!address) return false;
  const a = address.startsWith("::ffff:") ? address.slice(7) : address;
  return a === "::1" || a === "127.0.0.1" || a.startsWith("127.");
}
