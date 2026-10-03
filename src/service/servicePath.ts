/**
 * The PATH the service runs with: the login shell's, then the usual homes of node, tmux and claude in case the
 * shell profile did not run (a failed capture), without duplicates and without empty entries. launchd's and
 * systemd's own PATH are bare, and agents started in tmux inherit the daemon's. Pure.
 */
import { join } from "node:path";

export function servicePath(loginPath: string | undefined, home: string, nodeDir: string): string {
  const fallback = [nodeDir, "/opt/homebrew/bin", "/usr/local/bin", join(home, ".local", "bin"), "/usr/bin", "/bin", "/usr/sbin", "/sbin"];
  const seen = new Set<string>();
  return [...(loginPath ?? "").split(":"), ...fallback].filter((p) => p.startsWith("/") && !seen.has(p) && seen.add(p)).join(":");
}
