/** Is this process the launchd agent of `grenade service install`? launchd names its jobs in XPC_SERVICE_NAME. */
import { SERVICE_LABEL } from "../service/launchdPlist.js";

/** What the daemon exits with to be restarted into a new version: any failure code makes launchd start it again. */
export const RESTART_EXIT_CODE = 75;

/** `startsWith`, so a test agent (`com.adamchew.grenade.daemon.test`) counts too. Terminals set other names, or "0". */
export function underLaunchd(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env["XPC_SERVICE_NAME"] ?? "").startsWith(SERVICE_LABEL);
}
