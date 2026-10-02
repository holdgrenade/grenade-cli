/** Thin async wrapper over the tmux binary. Every call is execFile with a timeout; nothing blocks the event loop. */
import { execFile } from "node:child_process";
import type { AgentKind, KeyName } from "@grenade/protocol";
import {
  GEOMETRY_FORMAT,
  agentCommand,
  buildHistory,
  buildScreen,
  historyRange,
  inputCommand,
  keyToTmux,
  parsePaneGeometry,
  parseSessionList,
  splitGeometry,
  tmuxEnv,
  type HistoryRows,
  type PaneGeometry,
  type Screen,
} from "./parse.js";
import { parsePidList, parsePsTable, processTree } from "./processes.js";

export class TmuxError extends Error {
  constructor(message: string, readonly args: string[]) {
    super(message);
    this.name = "TmuxError";
  }
}

export interface Tmux {
  listSessions(): Promise<string[]>;
  hasSession(id: string): Promise<boolean>;
  /** `resume`: a Claude Code conversation id to start a copy of (`agentCommand`). */
  newSession(opts: { id: string; cwd: string; agent: AgentKind; resume?: string | undefined }): Promise<void>;
  capture(id: string): Promise<Screen>;
  /** Up to `count` scrollback rows before history index `before`, and the pane geometry at that moment. */
  captureHistory(id: string, before: number, count: number): Promise<{ rows: HistoryRows; geo: PaneGeometry }>;
  /** Options Grenade sets at creation (mouse, blank fill), for a session made by an older daemon. */
  applySessionOptions(id: string): Promise<void>;
  sendText(id: string, text: string, submit: boolean): Promise<void>;
  sendKey(id: string, key: KeyName): Promise<void>;
  resize(id: string, cols: number, rows?: number): Promise<void>;
  /** Undo `resize`: the window follows the attached Mac terminals again. */
  releaseSize(id: string): Promise<void>;
  killSession(id: string): Promise<void>;
}

export interface TmuxOptions {
  bin?: string;
  timeoutMs?: number;
  cols?: number;
  rows?: number;
  /** Rows of scrollback tmux keeps for a new session. Fixed when the pane is created. */
  historyLimit?: number;
  /** After kill-session, how long leftover processes get between SIGTERM and SIGKILL. */
  killGraceMs?: number;
}

export function createTmux(opts: TmuxOptions = {}): Tmux {
  const bin = opts.bin ?? process.env["TMUX_BIN"] ?? "tmux";
  const timeout = opts.timeoutMs ?? 3000;
  const cols = opts.cols ?? 120;
  const rows = opts.rows ?? 40;
  const historyLimit = opts.historyLimit ?? 50_000;
  const killGraceMs = opts.killGraceMs ?? 2000;

  const run = (args: string[]): Promise<string> =>
    new Promise((resolve, reject) => {
      execFile(bin, args, { timeout, maxBuffer: 4 * 1024 * 1024, env: tmuxEnv(process.env) }, (err, stdout, stderr) => {
        if (err) reject(new TmuxError((stderr || err.message).trim(), args));
        else resolve(stdout);
      });
    });

  /** Exact-match targets: `=id` for session commands, `=id:` for pane commands (capture, send-keys, display). */
  const session = (id: string) => `=${id}`;
  const pane = (id: string) => `=${id}:`;

  /** Every pid running under the session's panes (shells, agents, and whatever they started). */
  const sessionProcessTree = async (id: string): Promise<number[]> => {
    const roots = parsePidList(await run(["list-panes", "-s", "-t", session(id), "-F", "#{pane_pid}"]));
    const table = parsePsTable(await exec("ps", ["-A", "-o", "pid=,ppid="], timeout));
    return processTree(table, roots);
  };

  const isNoServer = (e: unknown) =>
    e instanceof TmuxError && /no server running|No such file or directory|error connecting/i.test(e.message);

  return {
    async listSessions() {
      try {
        return parseSessionList(await run(["list-sessions", "-F", "#{session_name}"]));
      } catch (e) {
        if (isNoServer(e)) return [];
        throw e;
      }
    },
    async hasSession(id) {
      try {
        await run(["has-session", "-t", session(id)]);
        return true;
      } catch {
        return false;
      }
    },
    async newSession({ id, cwd, agent, resume }) {
      // history-limit only applies to panes created after it is set, so the session starts on a placeholder shell,
      // gets its options, then respawn-pane starts the agent in a pane that has the big history. `mouse on` lets the
      // wheel scroll tmux history in the iTerm mirror. A blank fill-character hides tmux's dots in the part of a Mac
      // terminal that lies outside a phone-width window. One tmux command, so nothing runs in between. Every command
      // after new-session names its target: an untargeted one falls on the pane in TMUX_PANE when the daemon was
      // started inside tmux, and respawn-pane -k would then kill that pane's agent and leave this session a bare shell.
      const env = ["-c", cwd, "-e", `GRENADE_SESSION=${id}`];
      await run([
        "new-session", "-d", "-s", id, ...env, "-x", String(cols), "-y", String(rows), ";",
        "set-option", "-t", pane(id), "history-limit", String(historyLimit), ";",
        "set-option", "-t", pane(id), "mouse", "on", ";",
        "set-option", "-w", "-t", pane(id), "fill-character", " ", ";",
        "respawn-pane", "-k", "-t", pane(id), ...env, agentCommand(agent, undefined, resume),
      ]);
    },
    async capture(id) {
      // The visible pane only, never the scrollback above it: Claude Code repaints its transcript in place on every
      // width change, and each earlier paint stays in tmux history, so rows above the pane repeat what the pane shows.
      // A phone gets older rows through `history` when the reader scrolls up. Geometry and rows in one tmux command,
      // so the history index of the first row is exact.
      const out = await run([
        "display-message", "-p", "-t", pane(id), GEOMETRY_FORMAT, ";",
        "capture-pane", "-p", "-e", "-t", pane(id),
      ]);
      const { geo, dump } = splitGeometry(out);
      return buildScreen(dump, geo);
    },
    async captureHistory(id, before, count) {
      const probe = parsePaneGeometry(await run(["display-message", "-p", "-t", pane(id), GEOMETRY_FORMAT]));
      const range = historyRange(before, count, probe.historySize);
      if (!range) return { rows: { start: Math.min(before, probe.historySize), lines: [], styled: [] }, geo: probe };
      const out = await run([
        "display-message", "-p", "-t", pane(id), GEOMETRY_FORMAT, ";",
        "capture-pane", "-p", "-e", "-S", String(range.from), "-E", String(range.to), "-t", pane(id),
      ]);
      const { geo, dump } = splitGeometry(out);
      // Offsets are relative to the visible pane, so rows that scrolled in since the probe shift what we got.
      const start = Math.max(0, geo.historySize + range.from);
      return { rows: buildHistory(dump, start), geo };
    },
    async applySessionOptions(id) {
      await run([
        "set-option", "-t", pane(id), "mouse", "on", ";",
        "set-option", "-w", "-t", pane(id), "fill-character", " ",
      ]);
    },
    async sendText(id, text, submit) {
      if (text.length > 0) await run(inputCommand(pane(id), text));
      if (submit) await run(["send-keys", "-t", pane(id), "Enter"]);
    },
    async sendKey(id, key) {
      await run(["send-keys", "-t", pane(id), keyToTmux(key)]);
    },
    async resize(id, cols, rows) {
      // resize-window switches the window to a manual size, so it stays put while no client is attached.
      const size = rows === undefined ? ["-x", String(cols)] : ["-x", String(cols), "-y", String(rows)];
      await run(["resize-window", "-t", pane(id), ...size]);
    },
    async releaseSize(id) {
      // -A drops the manual size: the window fits the largest attached client, or keeps its size when none is.
      await run(["resize-window", "-A", "-t", pane(id)]);
    },
    async killSession(id) {
      // Collect the pane's process tree first: once tmux is gone, survivors are reparented to launchd and untraceable.
      const tree = await sessionProcessTree(id).catch(() => []);
      await run(["kill-session", "-t", session(id)]);
      terminate(tree, killGraceMs);
    },
  };
}

function exec(file: string, args: string[], timeout: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });
}

/** SIGTERM whatever is still alive, then SIGKILL anything that ignored it. Never blocks the caller. */
function terminate(pids: number[], graceMs: number): void {
  const signal = (sig: NodeJS.Signals) => pids.filter((pid) => {
    try {
      process.kill(pid, sig);
      return true;
    } catch {
      return false; // already exited
    }
  });
  if (signal("SIGTERM").length === 0) return;
  setTimeout(() => signal("SIGKILL"), graceMs).unref();
}
