/**
 * `grenade setup`: the whole first run in one command. Checks what Grenade needs, offers the Claude Code hooks,
 * starts grenaded at login, offers the relay, and ends on the QR code for the phone. Every step that is already
 * done is skipped, so it is safe to run again.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Command } from "commander";
import { DEFAULT_PORT } from "@grenade/protocol";
import { paths } from "../config.js";
import type { Device } from "../daemon/devices.js";
import { mergeHooks } from "../hooks/installHooks.js";
import type { RelayStatus } from "../relay/relayLink.js";
import { serviceStatus } from "../service/launchd.js";
import { SERVICE_LABEL } from "../service/launchdPlist.js";
import { askYesNo } from "../setup/ask.js";
import { findRequirements } from "../setup/findRequirements.js";
import { addedHooks, hooksNotice } from "../setup/hooksNotice.js";
import { nextSteps } from "../setup/nextSteps.js";
import { pushNotice, type PushSetting } from "../setup/pushNotice.js";
import { problems } from "../setup/requirements.js";
import { showPairing } from "./pairCommand.js";
import { startService, type ServiceCommandDeps } from "./serviceCommand.js";

interface SetupOptions {
  yes?: boolean;
  label: string;
  hooks: boolean;
  service: boolean;
  relay: boolean;
  pair: boolean;
}

export function registerSetupCommand(program: Command, d: ServiceCommandDeps): void {
  program
    .command("setup")
    .description("set Grenade up on this Mac: hooks, start at login, relay, then pair your phone")
    .option("-y, --yes", "take the suggested answer to every question")
    .option("--no-hooks", "leave ~/.claude/settings.json alone")
    .option("--no-service", "do not start grenaded at login")
    .option("--no-relay", "do not turn on the relay")
    .option("--no-pair", "stop before pairing a phone")
    .option("--label <label>", "launchd label", SERVICE_LABEL)
    .action(async (o: SetupOptions) => {
      const ask = (question: string, unattended: boolean) => askYesNo(question, { defaultYes: true, assumeYes: o.yes === true, unattended });
      step(1, "What Grenade needs");
      await requirements(ask);
      step(2, "Claude Code hooks");
      if (o.hooks) await hooks(ask);
      else console.log("skipped (--no-hooks). The phone guesses the status from screen changes.");
      step(3, "Start at login");
      if (!(await daemon(d, o.service, o.label, ask))) return;
      step(4, "Reach this Mac from anywhere");
      if (o.relay) await relay(d, ask);
      else console.log("skipped (--no-relay). The phone reaches this Mac on the same Wi‑Fi only.");
      await push(d);
      step(5, "Pair your phone");
      if (!o.pair) return console.log("skipped (--no-pair). Pair later with: grenade pair");
      if (await pair(d, o.yes === true)) for (const line of nextSteps(findRequirements().iterm)) console.log(line);
      else process.exitCode = 1;
    });
}

type Ask = (question: string, unattended: boolean) => Promise<boolean>;

function step(n: number, title: string): void {
  console.log(`\n${n}/5  ${title}`);
}

async function requirements(ask: Ask): Promise<void> {
  for (const p of problems(findRequirements())) {
    console.log(p.message);
    if (!p.fix) {
      if (p.blocks) throw new Error("Setup cannot go on until that is fixed.");
      continue;
    }
    if (!(await ask(`Run \`${p.fix}\` now?`, false))) {
      if (p.blocks) throw new Error(`Setup cannot go on without it. Run: ${p.fix}`);
      console.log(`left out. Later: ${p.fix}`);
      continue;
    }
    const [command, ...args] = p.fix.split(" ");
    const ok = command !== undefined && spawnSync(command, args, { stdio: "inherit" }).status === 0;
    if (!ok && p.blocks) throw new Error(`\`${p.fix}\` failed.`);
    if (!ok) console.log(`\`${p.fix}\` failed; going on without it.`);
  }
  const found = findRequirements();
  const left = problems(found).filter((p) => p.blocks);
  if (left.length > 0) throw new Error(left.map((p) => p.message).join(" "));
  console.log(found.iterm ? "ok: macOS, Node, tmux and iTerm2 are in place" : "ok: macOS, Node and tmux are in place");
}

async function hooks(ask: Ask): Promise<void> {
  const current: unknown = existsSync(paths.claudeSettings) ? JSON.parse(readFileSync(paths.claudeSettings, "utf8")) : {};
  const { settings, changed } = mergeHooks(current, DEFAULT_PORT);
  if (!changed) return console.log(`ok: the hooks are already in ${paths.claudeSettings}`);
  for (const line of hooksNotice(paths.claudeSettings, addedHooks(current, settings))) console.log(line);
  console.log("");
  // Nobody to ask means nobody agreed: a settings file is only changed with a yes or --yes.
  if (!(await ask("Add the hooks?", false))) return console.log("left alone. Add them later with: grenade install-hooks");
  mkdirSync(dirname(paths.claudeSettings), { recursive: true });
  writeFileSync(paths.claudeSettings, JSON.stringify(settings, null, 2) + "\n");
  console.log(`added the hooks to ${paths.claudeSettings}`);
}

/** Returns false when there is no daemon to go on with. */
async function daemon(d: ServiceCommandDeps, wanted: boolean, label: string, ask: Ask): Promise<boolean> {
  const answering = await d.control("GET", "/status").then(() => true).catch(() => false);
  const agent = await serviceStatus(label);
  if (agent.running && answering) {
    console.log("ok: grenaded starts at login and is running");
    return true;
  }
  if (answering) {
    console.log("grenaded is running in a terminal, so it stops when that window closes.");
    console.log("To start it at login instead: stop it there (Ctrl-C), then run: grenade service install");
    return true;
  }
  if (wanted && (await ask("Start grenaded at login and keep it running?", true))) {
    const s = await startService(d, { label });
    console.log(`ok: grenaded is running and starts at login (${s.plist})`);
    console.log("Take it out again with: grenade service remove");
    return true;
  }
  console.log("grenaded is not running, and the next steps need it. Start it in another window with: grenade daemon");
  console.log("Then run grenade setup again.");
  process.exitCode = 1;
  return false;
}

async function relay(d: ServiceCommandDeps, ask: Ask): Promise<void> {
  const link = (await d.control<{ relayLink: RelayStatus }>("GET", "/status")).relayLink;
  if (link.disabled) return console.log("grenaded runs with --no-relay. The phone reaches this Mac on the same Wi‑Fi only.");
  if (link.state !== "off") return console.log(`ok: the relay is ${link.state} (${link.url ?? ""})`);
  console.log("Through a relay the phone reaches this Mac from any network, and can pair from anywhere.");
  console.log("The relay learns this Mac's name and IP addresses and when it is online. It never sees a screen,");
  console.log("a prompt or a session name: everything between phone and Mac is end-to-end encrypted.");
  console.log("");
  // The relay is someone else's server: only a person's yes, or --yes, turns it on.
  if (!(await ask("Turn on the Grenade relay?", false))) return console.log("left off. Turn it on later with: grenade relay on");
  const program = process.argv[1];
  if (!program) throw new Error("cannot tell where the grenade command is installed");
  const r = spawnSync(process.execPath, [program, "--control-port", String(d.controlPort()), "relay", "on"], { stdio: "inherit" });
  if (r.status !== 0) console.log("The relay did not come on. Try again later with: grenade relay on");
}

/** Says what the daemon does about push notifications. It changes nothing: `grenade push` does. */
async function push(d: ServiceCommandDeps): Promise<void> {
  // A daemon that predates push notifications has no such route, and nothing to say.
  const setting = await d.control<PushSetting>("GET", "/push").catch(() => null);
  if (!setting) return;
  console.log("");
  for (const line of pushNotice(setting)) console.log(line);
}

async function pair(d: ServiceCommandDeps, assumeYes: boolean): Promise<boolean> {
  const devices = await d.control<Device[]>("GET", "/devices");
  if (devices.length > 0) {
    console.log(`Already paired: ${devices.map((x) => x.name).join(", ")}`);
    const another = await askYesNo("Pair another phone?", { defaultYes: false, assumeYes, unattended: false });
    if (!another) return true;
  }
  return showPairing(d.control, { wait: true });
}
