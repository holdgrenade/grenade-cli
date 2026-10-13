/**
 * Moves the launchd agent off its old label (LEGACY_SERVICE_LABEL) onto SERVICE_LABEL, from inside the old agent.
 * An installed daemon updates itself and launchd starts the new version under the label it was installed with, so the
 * first daemon of a CLI that knows the new label is the one to move. It does so before it opens a port: it writes its
 * own plist again under the new label, starts that agent (which takes the ports), deletes the old plist and boots its
 * own job out. Sessions keep running in tmux, as at any restart. Remove this file with LEGACY_SERVICE_LABEL.
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { launchctl, statusOf, uid } from "./launchd.js";
import { LEGACY_SERVICE_LABEL, SERVICE_LABEL, domainTarget, plistPath, relabelPlist, serviceTarget } from "./launchdPlist.js";

/**
 * True when this process was the old agent and the new one has taken over: the caller exits at once (with 0, so
 * launchd does not start the old job again if the bootout has not reached it yet). False in every other case, and
 * when anything goes wrong, so the daemon starts as it always did.
 */
export async function moveLegacyAgent(o: { env?: NodeJS.ProcessEnv; pid?: number; from?: string; to?: string } = {}): Promise<boolean> {
  const { env = process.env, pid = process.pid, from = LEGACY_SERVICE_LABEL, to = SERVICE_LABEL } = o;
  if (process.platform !== "darwin" || env["XPC_SERVICE_NAME"] !== from) return false;
  try {
    // Sessions inherit XPC_SERVICE_NAME, so a `grenade daemon` typed in one is not the agent: only the job's own pid is.
    const legacy = await statusOf(from);
    if (legacy.pid !== pid || !existsSync(legacy.file)) return false;
    const text = relabelPlist(readFileSync(legacy.file, "utf8"), from, to);
    if (!text) return false;
    if (!(await statusOf(to)).loaded) {
      const next = plistPath(homedir(), to);
      writeFileSync(next, text, { mode: 0o644 });
      await launchctl(["enable", serviceTarget(uid(), to)]).catch(() => undefined);
      try {
        await launchctl(["bootstrap", domainTarget(uid()), next]);
      } catch (e) {
        rmSync(next, { force: true });
        throw e;
      }
    }
    rmSync(legacy.file, { force: true });
  } catch (e) {
    console.error(`grenaded: could not move the agent to ${to}, running as ${from}: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
  // launchd stops this process here (SIGTERM); AbandonProcessGroup keeps launchctl alive to finish.
  await launchctl(["bootout", serviceTarget(uid(), from)]).catch(() => undefined);
  return true;
}
