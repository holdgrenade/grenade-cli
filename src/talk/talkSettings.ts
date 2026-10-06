/**
 * `<GRENADE_HOME>/talk.json` (mode 0600): which agent answers typed Talk, as the owner chose it (`talk.agent`,
 * `grenade talk agent`), and the agent conversation the day's turns continue. Anything malformed reads as nothing.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

export interface TalkConversation {
  /** The day it belongs to, "2026-10-05": a new day starts a new one. */
  date: string;
  agent: string;
  /** Claude Code's session id, or Codex's thread id. */
  id: string;
}

export interface TalkSettings {
  agent?: string;
  conversation?: TalkConversation;
}

export function loadTalkSettings(path: string): TalkSettings {
  if (!existsSync(path)) return {};
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const settings: TalkSettings = {};
    if (typeof raw["agent"] === "string") settings.agent = raw["agent"];
    const c = raw["conversation"] as Record<string, unknown> | undefined;
    if (c && typeof c["date"] === "string" && typeof c["agent"] === "string" && typeof c["id"] === "string") settings.conversation = { date: c["date"], agent: c["agent"], id: c["id"] };
    return settings;
  } catch {
    return {};
  }
}

export function saveTalkSettings(path: string, settings: TalkSettings): void {
  const temp = `${path}.tmp`;
  writeFileSync(temp, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, path);
}
