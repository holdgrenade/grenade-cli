/**
 * Which terminal the daemon mirrors sessions into: `~/.grenade/terminal.json` `{ "terminal": "iterm" }`
 * (`grenade terminal iterm`). A missing or unreadable file is `none`: the Mac app and the phone show every
 * session, so no window opens unless asked for. Read at every mirror event, so a change needs no restart.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { ensureDir, paths } from "../config.js";
import { isTerminalKind, type TerminalKind } from "./mirror.js";

export const DEFAULT_TERMINAL: TerminalKind = "none";

export function parseTerminalSetting(text: string | null): TerminalKind {
  if (text === null) return DEFAULT_TERMINAL;
  try {
    const t = (JSON.parse(text) as { terminal?: unknown }).terminal;
    return typeof t === "string" && isTerminalKind(t) ? t : DEFAULT_TERMINAL;
  } catch {
    return DEFAULT_TERMINAL;
  }
}

export function readTerminalSetting(file: string = paths.terminal): TerminalKind {
  try {
    return parseTerminalSetting(readFileSync(file, "utf8"));
  } catch {
    return parseTerminalSetting(null);
  }
}

export function writeTerminalSetting(kind: TerminalKind, file: string = paths.terminal): void {
  ensureDir();
  writeFileSync(file, JSON.stringify({ terminal: kind }, null, 2) + "\n");
}
