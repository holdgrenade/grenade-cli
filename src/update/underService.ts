/**
 * Is this process the service of `grenade service install`, which its manager starts again when it exits with a
 * failure code? Only then can the daemon restart itself into a new version. Pure.
 */
import { SERVICE_LABEL } from "../service/launchdPlist.js";
import { SERVICE_MARKER } from "../service/systemdUnit.js";

/** What the daemon exits with to be restarted into a new version: any failure code makes launchd or systemd start it again. */
export const RESTART_EXIT_CODE = 75;

/** launchd names its jobs in XPC_SERVICE_NAME. `startsWith`, so a test agent (`com.adamchew.grenade.daemon.test`) counts too. Terminals set other names, or "0". */
export function underLaunchd(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env["XPC_SERVICE_NAME"] ?? "").startsWith(SERVICE_LABEL);
}

/**
 * systemd puts the pid of a service's main process in SYSTEMD_EXEC_PID, and Grenade's unit carries its marker.
 * Both are inherited by everything the daemon starts (tmux, the agents), so the pid must be this process's own:
 * a `grenade daemon` typed in a Grenade session is not the service.
 */
export function underSystemd(env: NodeJS.ProcessEnv = process.env, pid: number = process.pid): boolean {
  return Boolean(env[SERVICE_MARKER]) && env["SYSTEMD_EXEC_PID"] === String(pid);
}

export function underService(env: NodeJS.ProcessEnv = process.env, pid: number = process.pid): boolean {
  return underLaunchd(env) || underSystemd(env, pid);
}
