/** Pure: a Codex session's context and its plan windows, read from its rollout (PROTOCOL.md "Usage"). */
import type { PlanLimit, SessionContext } from "@grenade/protocol";

export interface CodexUsage {
  context?: SessionContext;
  limits: PlanLimit[];
}

/**
 * The last `token_count` event in Codex rollout JSONL: the context (`last_token_usage.total_tokens` out of
 * `model_context_window`) and the plan windows (`rate_limits.primary` and `secondary`: `used_percent`,
 * `window_minutes`, `resets_at` in Unix seconds, or `resets_in_seconds` from the event's time in older Codex).
 */
export function codexUsageIn(jsonl: string): CodexUsage | null {
  const lines = jsonl.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (!line.includes('"token_count"')) continue;
    const entry = parse(line) as { timestamp?: unknown; payload?: { type?: unknown; info?: unknown; rate_limits?: unknown } } | null;
    if (entry?.payload?.type !== "token_count") continue;
    const at = typeof entry.timestamp === "string" && !Number.isNaN(Date.parse(entry.timestamp)) ? new Date(entry.timestamp).toISOString() : new Date().toISOString();
    const info = (entry.payload.info ?? {}) as { last_token_usage?: { total_tokens?: unknown }; model_context_window?: unknown };
    const used = info.last_token_usage?.total_tokens;
    const size = info.model_context_window;
    const context = typeof used === "number" && typeof size === "number" && size >= 1 ? { used: Math.max(0, Math.round(used)), size: Math.round(size) } : undefined;
    const limits: PlanLimit[] = [];
    const rl = (entry.payload.rate_limits ?? {}) as Record<string, unknown>;
    for (const key of ["primary", "secondary"]) {
      const w = rl[key] as { used_percent?: unknown; window_minutes?: unknown; resets_at?: unknown; resets_in_seconds?: unknown } | null | undefined;
      if (!w || typeof w.used_percent !== "number" || typeof w.window_minutes !== "number" || w.window_minutes < 1) continue;
      const resets =
        typeof w.resets_at === "number" ? w.resets_at * 1000 : typeof w.resets_in_seconds === "number" ? Date.parse(at) + w.resets_in_seconds * 1000 : undefined;
      limits.push({
        agent: "codex",
        minutes: Math.round(w.window_minutes),
        usedPercent: Math.max(0, Math.min(100, w.used_percent)),
        ...(resets !== undefined ? { resetsAt: new Date(resets).toISOString() } : {}),
        at,
      });
    }
    return { ...(context ? { context } : {}), limits };
  }
  return null;
}


function parse(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}
