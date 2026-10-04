#!/usr/bin/env node
/** The `grenade` CLI. Talks to a running daemon over the loopback control API. */
import { spawnSync } from "node:child_process";
import { AGENTS, isKnownAgent, type KnownAgent } from "./agents/agentCatalog.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { Command, InvalidArgumentError } from "commander";
import { CONTROL_PORT, DEFAULT_PORT, OFFICIAL_RELAY_URL, type Session } from "@grenade/protocol";
import { VERSION, paths } from "./config.js";
import { computerWord } from "./platform/computer.js";
import { ago, matchDevice, type Device } from "./daemon/devices.js";
import { showPairing } from "./cli/pairCommand.js";
import { registerPromptCommand } from "./cli/promptCommand.js";
import { registerPushCommand } from "./cli/pushCommand.js";
import { registerVoiceCommand } from "./cli/voiceCommand.js";
import { registerServiceCommand } from "./cli/serviceCommand.js";
import { registerSetupCommand } from "./cli/setupCommand.js";
import { registerUpdateCommand } from "./cli/updateCommand.js";
import { registerTerminalCommand } from "./cli/terminalCommand.js";
import { RESTART_EXIT_CODE, underService } from "./update/underService.js";
import { updateLine, updateNotice, type UpdateStatus } from "./update/versions.js";
import { startDaemon } from "./daemon/server.js";
import { isTerminalKind, type TerminalKind } from "./terminal/mirror.js";
import { mergeHooks, removeHooks } from "./hooks/installHooks.js";
import { removeCodexHooks } from "./hooks/installCodexHooks.js";
import { loadRelayConfig, normalizeRelayUrl, relayConfigFor, removeRelayConfig, saveRelayConfig } from "./relay/relayConfig.js";
import type { RelayStatus } from "./relay/relayLink.js";
import { sessionIdFor } from "./tmux/parse.js";

/** "Mac" on macOS, "computer" on Linux: what the commands call the machine grenaded runs on. */
const COMPUTER = computerWord();

const program = new Command()
  .name("grenade")
  .description("Control AI coding agents in your terminals from your phone.")
  .version(VERSION)
  .option("--control-port <port>", "daemon control port", parsePort, CONTROL_PORT);

const controlPort = (): number => program.opts<{ controlPort: number }>().controlPort;

program
  .command("daemon")
  .description("run grenaded in the foreground")
  .option("--port <port>", "WebSocket/HTTP port", parsePort, DEFAULT_PORT)
  .option("--name <name>", "name shown on the phone")
  .option("--no-advertise", "do not publish over Bonjour")
  .option("--terminal <kind>", "mirror sessions into terminal tabs: auto | iterm | terminal | none; pins it over `grenade terminal` (default: that setting, none unless set)", parseTerminal)
  .option("--no-summaries", "do not describe sessions with claude -p (Haiku)")
  .option("--no-relay", "do not connect to the relay, even when `grenade relay on` was run")
  .option("--allow-plain-lan", "accept phones that have not been updated to encrypt the Wi‑Fi connection")
  .action(async (o: { port: number; name?: string; advertise: boolean; terminal?: TerminalKind; summaries: boolean; relay: boolean; allowPlainLan?: boolean }) => {
    // As the service, an exit with a failure code brings the daemon back (launchd's KeepAlive, systemd's Restart=), now running what is on disk.
    const restart = underService() ? (installed: string) => void d.stop().then(() => process.exit(RESTART_EXIT_CODE)) : undefined;
    const d = await startDaemon({
      port: o.port,
      updates: { ...(process.argv[1] ? { program: process.argv[1] } : {}), ...(restart ? { restart } : {}) },
      controlPort: controlPort(),
      advertise: o.advertise,
      ...(o.allowPlainLan ? { allowPlainLan: true } : {}),
      ...deviceIdleFromEnv(),
      ...(o.relay ? {} : { relay: false }),
      ...(o.summaries ? {} : { summaries: false }),
      ...(o.name ? { name: o.name } : {}),
      ...(o.terminal ? { terminal: o.terminal } : {}),
    });
    const stop = () => void d.stop().then(() => process.exit(0));
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  });

program
  .command("status")
  .description("is the daemon running?")
  .action(async () => {
    const s = await control<DaemonStatus>("GET", "/status").catch(() => null);
    if (!s) return fail("grenaded is not running. Start it with: grenade daemon");
    console.log(`grenaded ${s.version} · ${s.name} (${s.id}) · up ${Math.round(s.uptimeMs / 1000)}s · ${s.sessions} session(s)`);
    console.log(`relay: ${relayLine(s.relayLink)}`);
    if (s.update) console.log(`update: ${updateLine(s.version, s.update)}`);
  });

program
  .command("pair")
  .description("show a QR code and a one-time code for the phone, and wait for it to pair")
  .option("--no-wait", "print them and return at once")
  .action(async (o: { wait: boolean }) => {
    // The typed code is printed with its check digits (`spacedCode(r.typed)`) by src/pairing/pairScreen.ts.
    if (!(await showPairing(control, { wait: o.wait }))) process.exitCode = 1;
  });

registerServiceCommand(program, { control, controlPort });
registerSetupCommand(program, { control, controlPort });
registerPushCommand(program, { control });
registerVoiceCommand(program, { control });
registerPromptCommand(program, { control });
registerUpdateCommand(program, { control });
registerTerminalCommand(program, { control });

// Like Claude Code: after a command, one line when a new version is out. Read from the daemon, which checks the tap.
program.hook("postAction", async (_program, action) => {
  if (!process.stderr.isTTY || NO_UPDATE_NOTICE.has(action.name()) || action.parent?.name() === "service") return;
  const s = await control<DaemonStatus>("GET", "/status", undefined, 500).catch(() => null);
  const line = s?.update ? updateNotice(s.version, s.update) : null;
  if (line) console.error(`\n${line}`);
});

program
  .command("devices")
  .description(`list the phones paired with this ${COMPUTER}`)
  .action(async () => {
    const list = await control<Device[]>("GET", "/devices");
    if (list.length === 0) return console.log("no phones paired. Pair one with: grenade pair");
    const now = Date.now();
    const width = Math.max(...list.map((d) => d.name.length), 4);
    console.log(`${"id".padEnd(11)} ${"name".padEnd(width)} ${"platform".padEnd(8)} ${"paired".padEnd(12)} ${"last seen".padEnd(12)} now`);
    for (const d of list) {
      const state = [d.connected.length ? `connected (${d.connected.map(routeName).join(", ")})` : "-", ...(d.sealed ? [] : ["not encrypted"])].join(" · ");
      console.log(`${d.id.padEnd(11)} ${d.name.padEnd(width)} ${d.platform.padEnd(8)} ${ago(d.pairedAt, now).padEnd(12)} ${ago(d.lastSeen, now).padEnd(12)} ${state}`);
    }
    console.log("\nRemove one with: grenade unpair <id or name>");
  });

program
  .command("unpair [device]")
  .description("end a phone's pairing: its token stops working at once, on Wi‑Fi and through the relay")
  .option("--all", "unpair every phone")
  .action(async (query: string | undefined, o: { all?: boolean }) => {
    if (o.all && query) throw new Error("name a device or use --all, not both");
    if (o.all) {
      const r = await control<{ removed: number; closed: number }>("DELETE", "/devices");
      return console.log(r.removed === 0 ? "no phones were paired" : `unpaired ${r.removed} phone(s), closed ${r.closed} connection(s)`);
    }
    if (!query) throw new Error("which phone? See them with: grenade devices (or unpair every phone with --all)");
    const match = matchDevice(query, await control<Device[]>("GET", "/devices"));
    if (!match.found) {
      if (match.candidates.length === 0) return fail(`no paired phone matches "${query}". See them with: grenade devices`);
      return fail(`"${query}" matches more than one phone. Use the id:\n${match.candidates.map((d) => `  ${d.id}  ${d.name}`).join("\n")}`);
    }
    const r = await control<{ closed: number }>("DELETE", `/devices/${encodeURIComponent(match.found.id)}`);
    console.log(`unpaired ${match.found.name} (${match.found.id}), closed ${r.closed} connection(s)`);
    console.log(`That phone can no longer reach this ${COMPUTER}. It forgets this ${COMPUTER} the next time it tries.`);
  });

const relay = program.command("relay").description(`reach this ${COMPUTER} from anywhere through a relay (end-to-end encrypted)`);

relay
  .command("on [url]")
  .description(`connect this ${COMPUTER} to a relay (default ${OFFICIAL_RELAY_URL})`)
  .option("--key <key>", "registration key, for relays that require one")
  .action(async (rawUrl: string | undefined, o: { key?: string }) => {
    const url = normalizeRelayUrl(rawUrl ?? OFFICIAL_RELAY_URL);
    const config = relayConfigFor(url, o.key, loadRelayConfig(paths.relay));
    saveRelayConfig(paths.relay, config);
    console.log(`relay set to ${url} (this ${COMPUTER} is ${config.id} there)`);
    const reloaded = await control<RelayStatus>("POST", "/relay/reload").catch(() => null);
    if (!reloaded) return console.log("grenaded is not running; it connects on the next start: grenade daemon");
    if (reloaded.disabled) return console.log("grenaded runs with --no-relay; restart it without that flag to connect");
    const s = await waitForRelay();
    console.log(`relay: ${relayLine(s)}`);
    if (s.state === "online") console.log(`Phones paired with this ${COMPUTER} now reach it from any network, and a new phone can pair from anywhere: grenade pair`);
  });

relay
  .command("off")
  .description(`disconnect from the relay and forget this ${COMPUTER}'s relay id`)
  .action(async () => {
    removeRelayConfig(paths.relay);
    const reloaded = await control<RelayStatus>("POST", "/relay/reload").catch(() => null);
    console.log(reloaded ? `relay off: phones reach this ${COMPUTER} only on the same Wi‑Fi` : "relay off (grenaded is not running)");
  });

relay
  .command("status")
  .description(`is this ${COMPUTER} reachable through the relay?`)
  .action(async () => {
    const s = await control<DaemonStatus>("GET", "/status").catch(() => null);
    if (!s) {
      const c = loadRelayConfig(paths.relay);
      return console.log(c ? `relay ${c.url} (${c.id}) is set, but grenaded is not running` : "relay off. Turn it on with: grenade relay on");
    }
    const r = s.relayLink;
    if (r.state === "off") return console.log(`relay: ${relayLine(r)}`);
    console.log(`relay    ${r.url} (this ${COMPUTER} is ${r.id})`);
    console.log(`state    ${r.state}${r.since ? ` since ${new Date(r.since).toLocaleTimeString()}` : ""}${r.lastError && r.state !== "online" ? ` · ${r.lastError}` : ""}`);
    console.log(`public   ${r.publicIp ?? "-"}`);
    console.log(`local    ${r.localIps?.join(", ") || "-"}`);
    console.log(`phones   ${r.phones} connected through the relay`);
  });

program
  .command("new <name>")
  .description("start an agent in a new tmux session")
  .requiredOption("--cwd <dir>", "working directory")
  .option("--agent <agent>", "claude | codex | shell", parseAgent, "claude")
  .option("--with <session>", "join that session's group instead of the folder's")
  .option("--alone", "start in a group of its own instead of joining the folder's")
  .action(async (name: string, o: { cwd: string; agent: KnownAgent; with?: string; alone?: boolean }) => {
    if (o.with && o.alone) throw new Error("use --with or --alone, not both");
    const group = o.with ? (await findSession(o.with)).group : undefined;
    let s = await control<Session>("POST", "/sessions", { name, cwd: resolveDir(o.cwd), agent: o.agent, group });
    if (o.alone) s = await control<Session>("PUT", `/sessions/${encodeURIComponent(s.id)}/group`, { group: null });
    console.log(`started ${s.id} (${s.agent}) in ${s.cwd}, group ${s.group}\nattach from a terminal with: grenade open ${name}`);
  });

program
  .command("group <name> <with>")
  .description("move a session into the group of another session (name the session itself with --at to reorder)")
  .option("--at <position>", "place it at this position in the group, 1 = first (default: last)")
  .action(async (name: string, other: string, o: { at?: string }) => {
    const group = (await findSession(other)).group;
    if (!group) throw new Error(`${other} has no group`);
    const at = o.at === undefined ? undefined : Number(o.at);
    if (at !== undefined && (!Number.isInteger(at) || at < 1)) throw new Error("--at must be a whole number from 1");
    const body = at === undefined ? { group } : { group, index: at - 1 };
    const s = await control<Session>("PUT", `/sessions/${encodeURIComponent(idFor(name))}/group`, body);
    console.log(`${s.id} is now in group ${s.group}${s.order === undefined ? "" : ` at position ${s.order + 1}`}`);
  });

program
  .command("ungroup <name>")
  .description("move a session out of its group into one of its own")
  .action(async (name: string) => {
    const s = await control<Session>("PUT", `/sessions/${encodeURIComponent(idFor(name))}/group`, { group: null });
    console.log(`${s.id} is now on its own (group ${s.group})`);
  });

program
  .command("ls")
  .description("list sessions")
  .action(async () => {
    const list = await control<Session[]>("GET", "/sessions");
    if (list.length === 0) return console.log("no sessions. Start one with: grenade new <name> --cwd <dir>");
    // Group mates are listed together, groups in order of their oldest session.
    const firstSeen = new Map<string, string>();
    for (const s of [...list].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
      const g = s.group ?? s.id;
      if (!firstSeen.has(g)) firstSeen.set(g, s.createdAt);
    }
    const key = (s: Session) => `${firstSeen.get(s.group ?? s.id)}|${s.group ?? s.id}|${s.createdAt}`;
    for (const s of [...list].sort((a, b) => key(a).localeCompare(key(b)))) {
      console.log(`${s.status.padEnd(8)} ${(s.group ?? "-").padEnd(9)} ${s.id.padEnd(24)} ${s.agent.padEnd(7)} ${s.cwd}  ${s.lastLine}`);
    }
  });

program
  .command("open <name>")
  .description("attach your terminal to a session (detach with Ctrl-b d)")
  .action((name: string) => {
    const id = name.startsWith("gr-") ? name : sessionIdFor(name);
    const r = spawnSync("tmux", ["attach-session", "-t", `=${id}`], { stdio: "inherit" });
    process.exit(r.status ?? 1);
  });

program
  .command("kill <name>")
  .description("end a session")
  .action(async (name: string) => {
    const id = name.startsWith("gr-") ? name : sessionIdFor(name);
    await control("DELETE", `/sessions/${encodeURIComponent(id)}`);
    console.log(`killed ${id}`);
  });

program
  .command("install-hooks")
  .description("also let a claude typed by hand in a Grenade shell report to grenaded (edits ~/.claude/settings.json); sessions Grenade starts have the hooks already")
  .option("--port <port>", "daemon port the hooks post to", parsePort, DEFAULT_PORT)
  .option("--print", "print the resulting settings instead of writing")
  .option("--remove", "remove Grenade hooks")
  .action((o: { port: number; print?: boolean; remove?: boolean }) => {
    const current = existsSync(paths.claudeSettings) ? JSON.parse(readFileSync(paths.claudeSettings, "utf8")) : {};
    const { settings, changed } = o.remove ? removeHooks(current) : mergeHooks(current, o.port);
    if (o.print) return console.log(JSON.stringify(settings, null, 2));
    if (o.remove) removeOldCodexHooks();
    if (!changed) return console.log(`nothing to do: ${paths.claudeSettings} already up to date`);
    mkdirSync(dirname(paths.claudeSettings), { recursive: true });
    writeFileSync(paths.claudeSettings, JSON.stringify(settings, null, 2) + "\n");
    console.log(`${o.remove ? "removed Grenade hooks from" : "installed Grenade hooks in"} ${paths.claudeSettings}`);
  });

/** CLI 1.0.23 wrote Codex hooks to ~/.codex/hooks.json; Codex gets them at launch now. */
function removeOldCodexHooks(): void {
  if (!existsSync(paths.codexHooks)) return;
  const { settings, changed } = removeCodexHooks(JSON.parse(readFileSync(paths.codexHooks, "utf8")));
  if (!changed) return;
  writeFileSync(paths.codexHooks, JSON.stringify(settings, null, 2) + "\n");
  console.log(`removed Grenade hooks from ${paths.codexHooks}`);
}

program.parseAsync(process.argv).catch((e: unknown) => fail(e instanceof Error ? e.message : String(e)));

// ---- helpers ------------------------------------------------------------------

interface DaemonStatus {
  id: string;
  name: string;
  version: string;
  uptimeMs: number;
  sessions: number;
  relayLink: RelayStatus;
  /** Absent from a daemon older than 0.1.11. */
  update?: UpdateStatus;
}

/** Commands after which no update line is printed: they say it themselves, or never return. */
const NO_UPDATE_NOTICE = new Set(["daemon", "open", "update", "status"]);

function routeName(route: "lan" | "relay"): string {
  return route === "lan" ? "Wi‑Fi" : "relay";
}

/** `GRENADE_DEVICE_IDLE_DAYS`: unpair phones unseen for that many days (default 90, 0 never). */
function deviceIdleFromEnv(): { deviceIdleMs?: number } {
  const raw = process.env["GRENADE_DEVICE_IDLE_DAYS"];
  if (raw === undefined || raw === "") return {};
  const days = Number(raw);
  if (!Number.isFinite(days) || days < 0) throw new Error("GRENADE_DEVICE_IDLE_DAYS must be a number of days, 0 for never");
  return { deviceIdleMs: days * 24 * 60 * 60 * 1000 };
}

function relayLine(r: RelayStatus): string {
  if (r.disabled) return "off (daemon started with --no-relay)";
  if (r.state === "off") return `off · phones reach this ${COMPUTER} on the same Wi‑Fi only (grenade relay on)`;
  if (r.state === "online") return `online · ${r.url} · public IP ${r.publicIp ?? "unknown"} · ${r.phones} phone(s) through it`;
  return `${r.state} · ${r.url}${r.lastError ? ` · ${r.lastError}` : ""}`;
}

/** After a reload, give the link a few seconds to come online (or be refused) before reporting. */
async function waitForRelay(): Promise<RelayStatus> {
  let s = (await control<DaemonStatus>("GET", "/status")).relayLink;
  for (let i = 0; i < 16 && s.state === "connecting"; i++) {
    await new Promise((r) => setTimeout(r, 500));
    s = (await control<DaemonStatus>("GET", "/status")).relayLink;
  }
  return s;
}

function idFor(name: string): string {
  return name.startsWith("gr-") ? name : sessionIdFor(name);
}

async function findSession(name: string): Promise<Session> {
  const id = idFor(name);
  const s = (await control<Session[]>("GET", "/sessions")).find((x) => x.id === id);
  if (!s) throw new Error(`no session ${id}`);
  return s;
}

async function control<T = unknown>(method: string, path: string, body?: unknown, timeoutMs?: number): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`http://127.0.0.1:${controlPort()}${path}`, {
      method,
      headers: body ? { "content-type": "application/json" } : {},
      body: body ? JSON.stringify(body) : null,
      ...(timeoutMs ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
    });
  } catch {
    throw new Error("grenaded is not running. Start it with: grenade daemon");
  }
  const json = (await res.json()) as T & { error?: string; message?: string };
  if (!res.ok) throw new Error(json.message ?? json.error ?? `HTTP ${res.status}`);
  return json;
}

function parseTerminal(v: string): TerminalKind {
  if (isTerminalKind(v)) return v;
  throw new InvalidArgumentError("expected auto, iterm, terminal or none");
}

function parsePort(v: string): number {
  const n = Number.parseInt(v, 10);
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new InvalidArgumentError("not a port");
  return n;
}

function parseAgent(v: string): KnownAgent {
  if (isKnownAgent(v)) return v;
  throw new InvalidArgumentError(`agent must be ${AGENTS.map((a) => a.kind).join(", ")}`);
}

function resolveDir(dir: string): string {
  const abs = dir.startsWith("~") ? dir.replace(/^~/, process.env["HOME"] ?? "") : dir;
  const full = abs.startsWith("/") ? abs : `${process.cwd()}/${abs}`;
  if (!existsSync(full)) throw new Error(`directory not found: ${full}`);
  return full;
}

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}
