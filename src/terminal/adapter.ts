/**
 * What a Mac terminal has to do for the mirror (`mirror.ts`): open a tab that attaches to a session, find
 * it again, close it, and, when it can, split it for a group. One adapter per terminal: `iterm.ts`, `appleTerminal.ts`.
 */
import { execFile, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

export interface TabOf {
  id: string;
  title: string;
}

export interface TerminalAdapter {
  /** The name people know it by, for logs and messages. */
  readonly name: string;
  /** Can put a group's sessions side by side. Without it every session gets a window of its own and regrouping changes nothing. */
  readonly splits: boolean;
  /** Session ids that have a tab already (the daemon restarted, or tabs were opened before). */
  list(): Promise<string[]>;
  open(tab: TabOf): Promise<void>;
  /** Splits the pane of `nextTo`; opens a tab when it has none (closed by hand). Returns which it did. */
  split(tab: TabOf & { nextTo: string }): Promise<"split" | "tab">;
  /** Closes what the session has. Returns the count closed. */
  close(id: string): Promise<number>;
}

/** Absolute tmux path: a terminal's command session may have no shell profile, so PATH may lack Homebrew. */
export function resolveTmuxBin(): string {
  const fromEnv = process.env["TMUX_BIN"];
  if (fromEnv) return fromEnv;
  try {
    const found = execFileSync("/usr/bin/which", ["tmux"], { encoding: "utf8" }).trim();
    if (found) return found;
  } catch {
    // fall through
  }
  for (const candidate of ["/opt/homebrew/bin/tmux", "/usr/local/bin/tmux"]) if (existsSync(candidate)) return candidate;
  return "tmux";
}

// ---- AppleScript, shared by the two Apple-scriptable terminals -----------------

export function asString(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** The command a tab runs, as an AppleScript string: `tmux attach-session -t =<id>`. */
export function attachCommand(tmuxBin: string, id: string): string {
  const bin = tmuxBin.includes(" ") ? `"${tmuxBin}"` : tmuxBin; // asString escapes these quotes once
  return asString(`${bin} attach-session -t =${id}`);
}

/** One value per line, as the list scripts return them. */
export function parseLines(out: string): string[] {
  return out
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

export type ScriptRunner = (script: string) => Promise<string>;

export const runAppleScript: ScriptRunner = (script) =>
  new Promise((resolve, reject) => {
    const child = execFile("/usr/bin/osascript", ["-"], { timeout: 15_000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr.trim() || err.message));
      else resolve(stdout.trimEnd());
    });
    child.stdin?.end(script);
  });
