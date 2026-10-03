/**
 * On Linux, the tmux server must not be born inside grenaded's systemd service. The `new-session` that finds no
 * server forks one, in the unit of whoever ran it, and a tmux built with systemd support (Arch's, Fedora's) makes
 * every pane's scope `PartOf` that unit: `systemctl --user stop` or `restart` of the service then ends every agent
 * (seen 2026-10-03, tmux 3.7c under systemd 259). So the service runs `new-session` through
 * `systemd-run --user --scope`: a server it starts lives in a scope of its own, which nothing stops before logout;
 * when a server is already running the scope holds only the short-lived client and is gone at once. Pure.
 */
export const SYSTEMD_RUN = "systemd-run";

/** A unit name no other call takes: `grenade-tmux-<time>-<random>`. */
export function scopeUnit(now: number, random: number): string {
  return `grenade-tmux-${now.toString(36)}-${Math.floor(random * 0xffffff).toString(16)}`;
}

/** The tmux command as `systemd-run` runs it: same environment, same output, same exit code, another unit. */
export function scopedCommand(bin: string, args: string[], unit: string): { file: string; args: string[] } {
  return { file: SYSTEMD_RUN, args: ["--user", "--scope", "--quiet", "--collect", `--unit=${unit}`, "--description=tmux server for Grenade sessions", "--", bin, ...args] };
}

/** systemd-run itself could not do it (not there, or no user session to ask): tmux was never run, so run it plainly. */
export function scopeUnavailable(error: { code?: unknown }, stderr: string): boolean {
  return error.code === "ENOENT" || /^Failed to (start transient|connect to|create bus|get|find)/m.test(stderr);
}
