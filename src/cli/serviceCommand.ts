/** `grenade service install | remove | status`: grenaded as a launchd agent that starts at login and restarts when it dies. */
import type { Command } from "commander";
import { CONTROL_PORT } from "@grenade/protocol";
import { paths } from "../config.js";
import { installService, removeService, serviceStatus, type ServiceStatus } from "../service/launchd.js";
import { SERVICE_LABEL } from "../service/launchdPlist.js";
import type { Control } from "./controlClient.js";

/** Settings of the daemon that live in the environment. The agent gets the ones set when it is installed. */
const PASSED_ON = ["GRENADE_HOME", "GRENADE_LOG", "GRENADE_TERMINAL", "GRENADE_SUMMARIES", "GRENADE_DEVICE_IDLE_DAYS", "GRENADE_UPDATE_CHECK", "TMUX_BIN", "TMUX_TMPDIR", "CLAUDE_BIN", "CLAUDE_CONFIG_DIR"];
const START_WAIT_MS = 15_000;

export interface ServiceCommandDeps {
  control: Control;
  controlPort(): number;
}

export function registerServiceCommand(program: Command, d: ServiceCommandDeps): void {
  const service = program.command("service").description("start grenaded at login and keep it running (a launchd agent)");

  service
    .command("install [daemonOptions...]")
    .description("install and start the agent; options after -- go to `grenade daemon` (for example: -- --terminal none)")
    .option("--label <label>", "launchd label", SERVICE_LABEL)
    .action(async (daemonOptions: string[], o: { label: string }) => {
      const s = await startService(d, { label: o.label, daemonOptions });
      console.log(`grenaded starts at login and restarts if it stops (${s.plist})`);
      console.log(s.running ? `running now, pid ${s.pid ?? "?"}` : "launchd has it but it is not running yet; see: grenade service status");
    });

  service
    .command("remove")
    .description("stop the agent and delete its file; sessions keep running in tmux")
    .option("--label <label>", "launchd label", SERVICE_LABEL)
    .action(async (o: { label: string }) => {
      const removed = await removeService(o.label);
      console.log(removed ? "removed: grenaded no longer starts at login. Your sessions are still running in tmux." : "nothing to remove: the agent was not installed");
    });

  service
    .command("status")
    .description("is the agent installed and running?")
    .option("--label <label>", "launchd label", SERVICE_LABEL)
    .action(async (o: { label: string }) => {
      const s = await serviceStatus(o.label);
      const answering = await d.control("GET", "/status").then(() => true).catch(() => false);
      for (const line of serviceLines(s, answering)) console.log(line);
    });
}

/**
 * Installs the agent and waits until the daemon answers. Refuses while a daemon started by hand holds the ports:
 * launchd would start a second one that fails, every 10 seconds.
 */
export async function startService(d: ServiceCommandDeps, o: { label?: string; daemonOptions?: string[] } = {}): Promise<ServiceStatus> {
  const label = o.label ?? SERVICE_LABEL;
  const before = await serviceStatus(label);
  const answering = await d.control("GET", "/status").then(() => true).catch(() => false);
  if (answering && !before.running) {
    throw new Error("grenaded is already running in a terminal. Stop it there (Ctrl-C), then run this again.");
  }
  const port = d.controlPort();
  const env: Record<string, string> = {};
  for (const name of PASSED_ON) {
    const value = process.env[name];
    if (value) env[name] = value;
  }
  const program = process.argv[1];
  if (!program) throw new Error("cannot tell where the grenade command is installed");
  await installService({
    label,
    program,
    args: [...(port === CONTROL_PORT ? [] : ["--control-port", String(port)]), "daemon", ...(o.daemonOptions ?? [])],
    env,
    logDir: paths.dir,
  });
  const deadline = Date.now() + START_WAIT_MS;
  while (Date.now() < deadline) {
    if (await d.control("GET", "/status").then(() => true).catch(() => false)) return serviceStatus(label);
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`grenaded did not start within ${START_WAIT_MS / 1000} s. Look at ${paths.dir}/launchd.log and ${paths.log}`);
}

/** What `grenade service status` prints. Pure. */
export function serviceLines(s: ServiceStatus, daemonAnswers: boolean): string[] {
  if (!s.installed && !s.loaded) {
    return [
      "not installed: grenaded does not start at login. Install it with: grenade service install",
      daemonAnswers ? "grenaded is running now, started by hand" : "grenaded is not running",
    ];
  }
  const lines = [`installed  ${s.installed ? s.plist : "no file, but launchd still has the job; run: grenade service remove"}`];
  if (!s.loaded) lines.push("state      not loaded; it starts at the next login, or now with: grenade service install");
  else if (s.running) lines.push(`state      running, pid ${s.pid ?? "?"}${daemonAnswers ? "" : " (not answering yet)"}`);
  else lines.push(`state      not running${s.lastExit === undefined ? "" : `, last exit code ${s.lastExit}`}; launchd starts it again within 10 s`);
  lines.push(`label      ${s.label}`);
  return lines;
}
