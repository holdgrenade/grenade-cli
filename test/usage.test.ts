import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { claudeStatusLine, claudeStatusUsage, userStatusLineIn } from "../src/usage/claudeStatusLine.js";
import { codexUsageIn } from "../src/usage/codexUsage.js";
import { PlanLimits } from "../src/usage/planLimits.js";

/** What Claude Code 2.1.289 piped to a status line command after one reply (2026-10-05), cut to what is read. */
const STATUS_LINE = {
  session_id: "b5afc7f4-4c50-4f43-a03f-9f19e4e074bb",
  model: { id: "claude-opus-5-5", display_name: "Opus 5.5" },
  context_window: {
    total_input_tokens: 40116,
    total_output_tokens: 4,
    context_window_size: 1000000,
    current_usage: { input_tokens: 2, output_tokens: 4, cache_creation_input_tokens: 15064, cache_read_input_tokens: 25050 },
    used_percentage: 4,
    remaining_percentage: 96,
  },
  rate_limits: { five_hour: { used_percentage: 21, resets_at: 1791180000 }, seven_day: { used_percentage: 63, resets_at: 1791626400 } },
};

/** A `token_count` line of a Codex 0.160 rollout (2026-10-03). */
const TOKEN_COUNT = JSON.stringify({
  timestamp: "2026-10-03T03:21:03.513Z",
  type: "event_msg",
  payload: {
    type: "token_count",
    info: {
      total_token_usage: { input_tokens: 67433, cached_input_tokens: 54272, output_tokens: 540, total_tokens: 67973 },
      last_token_usage: { input_tokens: 21658, cached_input_tokens: 18176, output_tokens: 228, total_tokens: 21886 },
      model_context_window: 258400,
    },
    rate_limits: {
      limit_id: "codex",
      primary: { used_percent: 3.0, window_minutes: 43200, resets_at: 1793578575 },
      secondary: null,
      plan_type: "free",
    },
  },
});

const AT = "2026-10-05T04:32:00.000Z";

describe("claudeStatusUsage", () => {
  it("reads the context and both plan windows", () => {
    expect(claudeStatusUsage(STATUS_LINE, AT)).toEqual({
      context: { used: 40116, size: 1000000 },
      limits: [
        { agent: "claude", minutes: 300, usedPercent: 21, resetsAt: "2026-10-05T06:00:00.000Z", at: AT },
        { agent: "claude", minutes: 10080, usedPercent: 63, resetsAt: "2026-10-10T10:00:00.000Z", at: AT },
      ],
    });
  });

  it("has no limits on a plan that reports none, and falls back to the percentage", () => {
    const usage = claudeStatusUsage({ context_window: { context_window_size: 200000, used_percentage: 38 } }, AT);
    expect(usage).toEqual({ context: { used: 76000, size: 200000 }, limits: [] });
  });

  it("reads nothing from nothing", () => {
    expect(claudeStatusUsage(null, AT)).toEqual({ limits: [] });
    expect(claudeStatusUsage({ context_window: { context_window_size: 0 } }, AT)).toEqual({ limits: [] });
  });
});

describe("the status line command", () => {
  it("runs the user's own line with the same payload", () => {
    const line = claudeStatusLine(1, { command: "cat | wc -c | tr -d ' '", padding: 2 });
    expect(line.padding).toBe(2);
    const out = execFileSync("sh", ["-c", line.command as string], { input: "hello", env: { ...process.env, GRENADE_SESSION: "gr-test" } }).toString();
    expect(out.trim()).toBe("5");
  });

  it("prints nothing without one", () => {
    const line = claudeStatusLine(1);
    const out = execFileSync("sh", ["-c", line.command as string], { input: "{}", env: { ...process.env, GRENADE_SESSION: "gr-test" } }).toString();
    expect(out).toBe("");
  });

  it("takes the user's line from their settings, never Grenade's own", () => {
    expect(userStatusLineIn({ statusLine: { type: "command", command: "~/bin/line.sh", padding: 0 } })).toEqual({ command: "~/bin/line.sh", padding: 0 });
    expect(userStatusLineIn({ statusLine: claudeStatusLine(7788) })).toBeUndefined();
    expect(userStatusLineIn({})).toBeUndefined();
    expect(userStatusLineIn({ statusLine: { type: "command", command: " " } })).toBeUndefined();
  });
});

describe("codexUsageIn", () => {
  it("reads the last token_count", () => {
    expect(codexUsageIn(`{"type":"event_msg"}\n${TOKEN_COUNT}\n{"type":"response_item"}\n`)).toEqual({
      context: { used: 21886, size: 258400 },
      limits: [{ agent: "codex", minutes: 43200, usedPercent: 3, resetsAt: "2026-11-02T00:16:15.000Z", at: "2026-10-03T03:21:03.513Z" }],
    });
  });

  it("counts an older reset from the event's time", () => {
    const old = TOKEN_COUNT.replace('"resets_at":1793578575', '"resets_in_seconds":3600');
    expect(codexUsageIn(old)?.limits[0]?.resetsAt).toBe("2026-10-03T04:21:03.513Z");
  });

  it("is null without one", () => {
    expect(codexUsageIn('{"type":"event_msg","payload":{"type":"agent_message"}}\n')).toBeNull();
  });
});

describe("PlanLimits", () => {
  const limit = (agent: string, minutes: number, resetsAt: string) => ({ agent, minutes, usedPercent: 10, resetsAt, at: AT });

  it("lists every agent's windows, shortest first, without the ones that reset", () => {
    const limits = new PlanLimits();
    limits.record("claude", [limit("claude", 300, "2026-10-05T06:00:00Z"), limit("claude", 10080, "2026-10-10T10:00:00Z")]);
    limits.record("codex", [limit("codex", 300, "2026-10-05T05:00:00Z")]);
    expect(limits.list(Date.parse("2026-10-05T05:30:00Z")).map((l) => `${l.agent} ${l.minutes}`)).toEqual(["claude 300", "claude 10080"]);
    expect(limits.list(Date.parse(AT)).map((l) => `${l.agent} ${l.minutes}`)).toEqual(["claude 300", "codex 300", "claude 10080"]);
  });

  it("keeps the last reading when a report has none", () => {
    const limits = new PlanLimits();
    limits.record("claude", [limit("claude", 300, "2026-10-05T06:00:00Z")]);
    limits.record("claude", []);
    expect(limits.list(Date.parse(AT))).toHaveLength(1);
  });
});
