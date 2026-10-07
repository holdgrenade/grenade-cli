/** Paths, identity and version for the daemon. Everything lives under ~/.grenade (override with GRENADE_HOME). */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, hostname } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);
export const VERSION: string = (require("../package.json") as { version: string }).version;

export const GRENADE_DIR = process.env["GRENADE_HOME"] ?? join(homedir(), ".grenade");

export const paths = {
  dir: GRENADE_DIR,
  tokens: join(GRENADE_DIR, "tokens.json"),
  pairingPause: join(GRENADE_DIR, "pairing-pause.json"),
  sessions: join(GRENADE_DIR, "sessions.json"),
  groups: join(GRENADE_DIR, "groups.json"),
  daemonId: join(GRENADE_DIR, "daemon-id"),
  log: join(GRENADE_DIR, "daemon.log"),
  relay: join(GRENADE_DIR, "relay.json"),
  e2eKey: join(GRENADE_DIR, "e2e-key"),
  attachments: join(GRENADE_DIR, "attachments"),
  push: join(GRENADE_DIR, "push.json"),
  pushDevices: join(GRENADE_DIR, "push-devices.json"),
  pushBoards: join(GRENADE_DIR, "push-boards.json"),
  update: join(GRENADE_DIR, "update.json"),
  terminal: join(GRENADE_DIR, "terminal.json"),
  conversations: join(GRENADE_DIR, "conversations.json"),
  voiceKeys: join(GRENADE_DIR, "voice-keys.json"),
  published: join(GRENADE_DIR, "published.json"),
  // Typed Talk: the day files and the work folder agents run in, and which agent answers.
  talk: join(GRENADE_DIR, "talk"),
  talkSettings: join(GRENADE_DIR, "talk.json"),
  // Claude Code keeps its settings, transcripts and process files in CLAUDE_CONFIG_DIR when that is set.
  claudeDir: process.env["CLAUDE_CONFIG_DIR"] ?? join(homedir(), ".claude"),
  claudeSettings: join(process.env["CLAUDE_CONFIG_DIR"] ?? join(homedir(), ".claude"), "settings.json"),
  // Codex keeps its config, hooks and rollouts in CODEX_HOME when that is set.
  codexDir: process.env["CODEX_HOME"] ?? join(homedir(), ".codex"),
  codexHooks: join(process.env["CODEX_HOME"] ?? join(homedir(), ".codex"), "hooks.json"),
};

export function ensureDir(): void {
  mkdirSync(GRENADE_DIR, { recursive: true });
}

/** Stable per-Mac daemon id, generated once. */
export function loadDaemonId(): string {
  ensureDir();
  if (existsSync(paths.daemonId)) return readFileSync(paths.daemonId, "utf8").trim();
  const id = `d_${randomBytes(4).toString("hex")}`;
  writeFileSync(paths.daemonId, id + "\n");
  return id;
}

/**
 * Human name shown on the phone. On macOS this is the computer name from Sharing ("Adam's MacBook Pro"),
 * which is stable. The mDNS hostname is the fallback, but macOS renumbers it (-2, -3, …) whenever it
 * meets a name conflict on a network, so it is not a good identity for people to read.
 */
export function defaultName(): string {
  if (process.platform === "darwin") {
    try {
      const name = execFileSync("/usr/sbin/scutil", ["--get", "ComputerName"], { encoding: "utf8", timeout: 2000 }).trim();
      if (name) return name;
    } catch {
      // fall through to the hostname
    }
  }
  return hostname().replace(/\.local$/i, "");
}
