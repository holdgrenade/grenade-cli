/**
 * Tiny leveled logger: stderr plus an append-only file. No dependencies.
 *
 * Lines are written for people: a short sentence, then `key=value` details.
 * stderr gets a local clock time (and color on a TTY); daemon.log gets the full
 * ISO timestamp so it stays sortable and greppable.
 */
import { createWriteStream, type WriteStream } from "node:fs";

export type Level = "debug" | "info" | "warn" | "error";
const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export type LogData = Record<string, unknown>;

export interface Logger {
  debug(msg: string, data?: LogData): void;
  info(msg: string, data?: LogData): void;
  warn(msg: string, data?: LogData): void;
  error(msg: string, data?: LogData): void;
  close(): void;
}

export function createLogger(opts: { level?: Level; file?: string; stderr?: boolean; color?: boolean } = {}): Logger {
  const min = order[opts.level ?? "info"];
  const stream: WriteStream | undefined = opts.file ? createWriteStream(opts.file, { flags: "a", mode: 0o600 }) : undefined;
  const useStderr = opts.stderr ?? true;
  const color = opts.color ?? (process.stderr.isTTY === true && !process.env["NO_COLOR"]);
  const write = (level: Level, msg: string, data?: LogData) => {
    if (order[level] < min) return;
    const now = new Date();
    if (useStderr) process.stderr.write(formatLine({ level, msg, data, time: clockTime(now), color }) + "\n");
    stream?.write(formatLine({ level, msg, data, time: now.toISOString(), color: false }) + "\n");
  };
  return {
    debug: (m, d) => write("debug", m, d),
    info: (m, d) => write("info", m, d),
    warn: (m, d) => write("warn", m, d),
    error: (m, d) => write("error", m, d),
    close: () => stream?.end(),
  };
}

export const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {}, close() {} };

const ansi = { dim: "\x1b[2m", yellow: "\x1b[33m", red: "\x1b[31m", reset: "\x1b[0m" };
const tags: Record<Level, string> = { debug: "debug", info: "", warn: "warning", error: "error" };
const tagColor: Record<Level, string> = { debug: ansi.dim, info: "", warn: ansi.yellow, error: ansi.red };

/** Pure: one log line. Info has no level tag; the others say what they are. */
export function formatLine(l: { level: Level; msg: string; data?: LogData | undefined; time: string; color: boolean }): string {
  const paint = (code: string, s: string) => (l.color && code ? code + s + ansi.reset : s);
  const tag = tags[l.level] ? paint(tagColor[l.level], tags[l.level] + ": ") : "";
  const details = formatData(l.data);
  return `${paint(ansi.dim, l.time)}  ${tag}${l.msg}${details ? "  " + paint(ansi.dim, details) : ""}`;
}

/** Pure: `key=value` pairs, quoting values with spaces, skipping undefined. */
export function formatData(data: LogData | undefined): string {
  if (!data) return "";
  return Object.entries(data)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${formatValue(v)}`)
    .join(" ");
}

function formatValue(v: unknown): string {
  const s = v instanceof Error ? v.message : typeof v === "string" ? v : safeJson(v);
  return /[\s"=]/.test(s) || s === "" ? JSON.stringify(s) : s;
}

function clockTime(d: Date): string {
  return d.toTimeString().slice(0, 8);
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
}
