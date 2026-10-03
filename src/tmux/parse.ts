/** Pure helpers around tmux: parsing its output and mapping protocol values to tmux arguments. No I/O. */
import type { AgentKind, Cursor, KeyName } from "@grenade/protocol";

export const SESSION_PREFIX = "gr-";
export const LAST_LINE_MAX = 200;

/** `tmux list-sessions -F '#{session_name}'` → names. Empty when no server is running. */
export function parseSessionList(out: string): string[] {
  return out
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

export interface PaneGeometry {
  cursor: Cursor;
  cols: number;
  rows: number;
  /** Rows in the pane's scrollback above the visible pane. */
  historySize: number;
  /** The pane is on the alternate screen (a full-screen app); it has no scrollback of its own. */
  alternate: boolean;
}

/** `display-message -p` format that `parsePaneGeometry` reads. */
export const GEOMETRY_FORMAT = "#{cursor_y} #{cursor_x} #{pane_width} #{pane_height} #{history_size} #{alternate_on}";

/** `display-message -p GEOMETRY_FORMAT` → geometry. */
export function parsePaneGeometry(out: string): PaneGeometry {
  const parts = out.trim().split(/\s+/).map((n) => Number.parseInt(n, 10));
  const [y, x, w, h, hs, alt] = parts;
  if (parts.length < 6 || parts.some((n) => Number.isNaN(n))) {
    throw new Error(`unexpected display-message output: ${JSON.stringify(out)}`);
  }
  return {
    cursor: { row: y ?? 0, col: x ?? 0 },
    cols: Math.max(1, w ?? 1),
    rows: Math.max(1, h ?? 1),
    historySize: Math.max(0, hs ?? 0),
    alternate: alt === 1,
  };
}

/**
 * Output of `display-message -p GEOMETRY_FORMAT ; capture-pane -p …` run as one tmux command, so both describe the same
 * instant → the geometry line and the capture dump.
 */
export function splitGeometry(out: string): { geo: PaneGeometry; dump: string } {
  const nl = out.indexOf("\n");
  return { geo: parsePaneGeometry(nl < 0 ? out : out.slice(0, nl)), dump: nl < 0 ? "" : out.slice(nl + 1) };
}

export interface Screen {
  /** Plain text rows. */
  lines: string[];
  /** The same rows with their SGR color sequences kept, for clients that draw colors. */
  styled: string[];
  cursor: Cursor;
  cols: number;
  rows: number;
  /** History index of `lines[0]` (0 = the oldest row tmux still holds). See PROTOCOL.md "Scrollback". */
  start: number;
  historySize: number;
  alternate: boolean;
}

/** CSI sequences (`ESC [ … final`), OSC sequences (`ESC ] … BEL` or `ESC ] … ESC \\`, e.g. hyperlinks) and lone two-byte escapes. */
const ANSI = /\x1b\[[0-?]*[ -\/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;

export function stripAnsi(s: string): string {
  return s.replace(ANSI, "");
}

/** Splits a capture-pane dump into rows: trailing spaces and the final newline removed, SGR kept. */
function captureRows(capture: string): string[] {
  const raw = capture.replace(/\r/g, "").split("\n").map((l) => l.replace(/\s+$/, ""));
  if (raw.length > 0 && raw[raw.length - 1] === "") raw.pop(); // trailing newline from capture-pane
  return raw;
}

/**
 * Turns a `capture-pane -p -e` dump (the visible pane) plus the pane geometry into a Screen.
 * Trailing blank lines are dropped, so `lines[0]` has history index `historySize`. A dump that
 * also holds rows above the pane (`-S -N`) still works: the last `rows` captured lines are the
 * visible pane, the rows above it are the newest scrollback, and the first one has history index
 * `historySize - (count - rows)`. No `-J`: rows must be the pane's own rows for history indexes to line up.
 */
export function buildScreen(capture: string, geo: PaneGeometry): Screen {
  const raw = captureRows(capture);
  const visibleStart = Math.max(0, raw.length - geo.rows);
  const absoluteRow = visibleStart + geo.cursor.row;
  const lines = trimTrailingEmpty(raw.map((l) => stripAnsi(l).replace(/\s+$/, "")));
  const styled = raw.slice(0, lines.length);
  const row = Math.min(Math.max(0, absoluteRow), Math.max(0, lines.length - 1));
  const start = Math.max(0, geo.historySize - visibleStart);
  return { lines, styled, cursor: { row, col: geo.cursor.col }, cols: geo.cols, rows: geo.rows, start, historySize: geo.historySize, alternate: geo.alternate };
}

/** Rows of scrollback: a dump of `capture-pane -p -e -S a -E b`, whose first row has history index `start`. */
export interface HistoryRows {
  start: number;
  lines: string[];
  styled: string[];
}

/** Scrollback rows keep their blank lines: they are real rows and indexes must stay contiguous. */
export function buildHistory(capture: string, start: number): HistoryRows {
  const styled = captureRows(capture);
  return { start, lines: styled.map((l) => stripAnsi(l).replace(/\s+$/, "")), styled };
}

/**
 * Which rows to capture for "up to `count` rows before history index `before`", as capture-pane `-S`/`-E` offsets
 * (0 = top of the visible pane, negative = scrollback). Null when there is nothing older.
 */
export function historyRange(before: number, count: number, historySize: number): { start: number; from: number; to: number } | null {
  const end = Math.min(before, historySize);
  const start = Math.max(0, end - count);
  if (end <= start) return null;
  return { start, from: start - historySize, to: end - 1 - historySize };
}

export function trimTrailingEmpty(lines: string[]): string[] {
  let end = lines.length;
  while (end > 0 && (lines[end - 1] ?? "").trim() === "") end--;
  return lines.slice(0, end);
}

export function lastNonEmptyLine(lines: string[]): string {
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = (lines[i] ?? "").trim();
    if (l) return l.slice(0, LAST_LINE_MAX);
  }
  return "";
}

/** "My Project!" → "my-project". Always non-empty. */
export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return slug || "session";
}

/**
 * A working directory as typed on a phone or CLI → an absolute path, or null.
 * Expands a leading `~` to `home`; anything still relative is rejected because the daemon's own cwd means nothing to the user.
 */
export function expandCwd(cwd: string, home: string): string | null {
  const t = cwd.trim();
  const abs = t === "~" ? home : t.startsWith("~/") ? home + t.slice(1) : t;
  if (!abs.startsWith("/")) return null;
  const clean = abs.replace(/\/+/g, "/");
  return clean.length > 1 ? clean.replace(/\/$/, "") : clean;
}

export function sessionIdFor(name: string): string {
  return SESSION_PREFIX + slugify(name);
}

export function isGrenadeSession(tmuxName: string): boolean {
  return tmuxName.startsWith(SESSION_PREFIX);
}

const KEY_MAP: Record<KeyName, string> = {
  enter: "Enter",
  "ctrl-c": "C-c",
  "ctrl-d": "C-d",
  escape: "Escape",
  tab: "Tab",
  up: "Up",
  down: "Down",
  backspace: "BSpace",
};

export function keyToTmux(key: KeyName): string {
  return KEY_MAP[key];
}

/**
 * The tmux command that puts `text` into the pane `target`. One line is typed as it is (`send-keys -l`). Text with a
 * line break is pasted instead, as one bracketed paste (`paste-buffer -p`, `-r` keeps each LF): typed, every newline
 * would press Enter and send the first line on its own, while Claude Code, Codex and the shell all take a pasted newline
 * as part of the input. CRLF and a lone CR become LF. The buffer is deleted after the paste (`-d`).
 */
export function inputCommand(target: string, text: string): string[] {
  if (!/[\r\n]/.test(text)) return ["send-keys", "-t", target, "-l", "--", text];
  const lines = text.replace(/\r\n?/g, "\n");
  return [
    "set-buffer", "-b", INPUT_BUFFER, "--", lines, ";",
    "paste-buffer", "-p", "-r", "-d", "-b", INPUT_BUFFER, "-t", target,
  ];
}

const INPUT_BUFFER = "grenade-input";

/** What an agent starts with: Grenade's hooks (`claudeHookFlags`, `codexHookFlags`), already quoted for the shell. */
export interface AgentFlags {
  claude?: string | undefined;
  codex?: string | undefined;
}

/** The program launched inside the tmux session for an agent kind. */
export function agentCommand(agent: AgentKind, shell = process.env["SHELL"] ?? "/bin/zsh", resume?: string, flags: AgentFlags = {}): string {
  const claude = flags.claude ? `claude ${flags.claude}` : "claude";
  switch (agent) {
    case "claude":
      // A copy of the conversation (PROTOCOL.md "Conversations"): the original transcript is never written to. The
      // id is checked by the protocol (letters, digits, dashes), and again here because tmux hands this to a shell.
      if (resume === undefined) return claude;
      if (!/^[A-Za-z0-9-]{1,64}$/.test(resume)) throw new Error(`not a conversation id: ${resume}`);
      return `${claude} --resume ${resume} --fork-session`;
    case "codex":
      return flags.codex ? `codex ${flags.codex}` : "codex";
    case "shell":
      return shell;
  }
}

/**
 * The environment the daemon runs tmux in: without TMUX and TMUX_PANE. A daemon started inside a tmux pane inherits
 * both, and tmux would then aim untargeted commands at that pane and that server.
 */
export function tmuxEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const { TMUX: _tmux, TMUX_PANE: _pane, ...rest } = env;
  return { ...rest, TMUX: "" };
}
