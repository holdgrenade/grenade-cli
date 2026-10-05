/**
 * Pure: Claude Code's status line (PROTOCOL.md "Usage"). Claude Code pipes a JSON payload to its status line command
 * after each update; it is the one place it says how full the context is by its own count and how much of a Pro or
 * Max plan is used. Grenade starts Claude Code with a status line command of its own (`claudeStatusLineCommand`) that
 * posts the payload to the daemon and then runs the user's own status line, if they have one, with the same payload.
 */
import type { PlanLimit, SessionContext } from "@grenade/protocol";
import { shellQuote } from "../hooks/shellQuote.js";

export const STATUS_LINE_PATH = "/hooks/claude/status";

/** The user's own status line, as their Claude Code settings have it. */
export interface UserStatusLine {
  command: string;
  padding?: number;
}

/**
 * The status line Grenade starts Claude Code with: the payload goes to the daemon in the background (never holding up
 * the line), then to the user's own command, whose output is the line. Without one the line stays empty, as before.
 */
export function claudeStatusLine(port: number, user?: UserStatusLine): Record<string, unknown> {
  const post = `curl -s -m 2 -X POST "http://127.0.0.1:${port}${STATUS_LINE_PATH}?session=$GRENADE_SESSION" -H 'content-type: application/json' --data-binary @-`;
  const report = `(printf '%s' "$in" | ${post} >/dev/null 2>&1 &)`;
  const command = user ? `in=$(cat); ${report}; printf '%s' "$in" | sh -c ${shellQuote(user.command)}` : `in=$(cat); ${report}`;
  return { type: "command", command, ...(user?.padding !== undefined ? { padding: user.padding } : {}) };
}

/** A status line in Claude Code settings that is the user's, not Grenade's. */
export function userStatusLineIn(settings: unknown): UserStatusLine | undefined {
  const line = (settings as { statusLine?: { type?: unknown; command?: unknown; padding?: unknown } } | null)?.statusLine;
  if (!line || line.type !== "command" || typeof line.command !== "string" || !line.command.trim()) return undefined;
  if (line.command.includes(STATUS_LINE_PATH)) return undefined;
  return { command: line.command, ...(typeof line.padding === "number" ? { padding: line.padding } : {}) };
}

/** Claude Code's names for its plan windows, and their lengths in minutes. Others (a spend limit) are left out. */
const WINDOWS: Record<string, number> = { five_hour: 300, seven_day: 10080 };

export interface StatusLineUsage {
  context?: SessionContext;
  limits: PlanLimit[];
}

/**
 * What a status line payload says: the context (`context_window`: tokens in it now, out of `context_window_size`) and
 * the plan windows (`rate_limits`: `used_percentage`, `resets_at` in Unix seconds), read `at` (ISO 8601).
 */
export function claudeStatusUsage(payload: unknown, at: string): StatusLineUsage {
  const p = (payload ?? {}) as { context_window?: unknown; rate_limits?: unknown };
  const limits: PlanLimit[] = [];
  if (isObject(p.rate_limits)) {
    for (const [name, minutes] of Object.entries(WINDOWS)) {
      const w = p.rate_limits[name];
      if (!isObject(w) || typeof w.used_percentage !== "number") continue;
      const resetsAt = typeof w.resets_at === "number" ? new Date(w.resets_at * 1000).toISOString() : undefined;
      limits.push({ agent: "claude", minutes, usedPercent: clampPercent(w.used_percentage), ...(resetsAt ? { resetsAt } : {}), at });
    }
  }
  const context = contextIn(p.context_window);
  return { ...(context ? { context } : {}), limits };
}

function contextIn(window: unknown): SessionContext | undefined {
  if (!isObject(window)) return undefined;
  const size = window.context_window_size;
  if (typeof size !== "number" || !(size >= 1)) return undefined;
  const usage = window.current_usage;
  if (isObject(usage)) {
    const used = tokens(usage.input_tokens) + tokens(usage.cache_creation_input_tokens) + tokens(usage.cache_read_input_tokens);
    if (used > 0) return { used, size: Math.round(size) };
  }
  if (typeof window.used_percentage === "number") return { used: Math.round((clampPercent(window.used_percentage) / 100) * size), size: Math.round(size) };
  return undefined;
}

const tokens = (v: unknown) => (typeof v === "number" && v > 0 ? Math.round(v) : 0);
const clampPercent = (v: number) => Math.max(0, Math.min(100, v));

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
