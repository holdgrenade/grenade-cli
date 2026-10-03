/**
 * Grenade's Claude Code hooks. The daemon starts Claude Code with them (`claudeHookFlags`: `--settings`), so a session
 * Grenade starts reports without any file being touched. `grenade install-hooks` also merges them into
 * ~/.claude/settings.json, for a `claude` typed by hand in a Grenade shell; Claude Code runs a hook that is in both once.
 * Idempotent: an existing Grenade hook is replaced, everything else is left untouched.
 * `mergeEntries` / `removeEntries` do the same for Codex's hooks.json (`installCodexHooks.ts`).
 */
import { PROMPT_HOOK_PATH, PROMPT_HOOK_TIMEOUT_S } from "@grenade/protocol";
import { shellQuote } from "./shellQuote.js";

/** Events that report status: a command that posts the payload and does not wait. */
export const HOOK_EVENTS = ["UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure", "Notification", "Stop", "StopFailure", "SessionEnd"] as const;
/** The event Claude Code holds open while a phone answers the prompt (PROTOCOL.md "Prompt hook"). */
export const PROMPT_EVENT = "PermissionRequest";
export const HOOK_MARKER = "/hooks/claude";

export function hookCommand(port: number): string {
  return `curl -s -m 2 -X POST "http://127.0.0.1:${port}/hooks/claude?session=$GRENADE_SESSION" -H 'content-type: application/json' --data-binary @-`;
}

/** An HTTP hook, because a command cannot be held open for hours and an HTTP hook tells the daemon when it lets go. */
export function promptHook(port: number): HookEntry {
  return {
    type: "http",
    url: `http://127.0.0.1:${port}${PROMPT_HOOK_PATH}`,
    timeout: PROMPT_HOOK_TIMEOUT_S,
    headers: { "X-Grenade-Session": "$GRENADE_SESSION" },
    allowedEnvVars: ["GRENADE_SESSION"],
  };
}

export interface HookEntry {
  type: string;
  command?: string;
  url?: string;
  [k: string]: unknown;
}
interface Matcher {
  matcher?: string;
  hooks?: HookEntry[];
  [k: string]: unknown;
}
export type Settings = Record<string, unknown> & { hooks?: Record<string, Matcher[]> };

const isGrenadeHook = (h: HookEntry) =>
  (typeof h.command === "string" && h.command.includes(HOOK_MARKER)) || (typeof h.url === "string" && h.url.includes(HOOK_MARKER));

export function mergeHooks(input: unknown, port: number): { settings: Settings; changed: boolean } {
  const command: HookEntry = { type: "command", command: hookCommand(port) };
  return mergeEntries(input, [...HOOK_EVENTS.map((e) => [e, command] as const), [PROMPT_EVENT, promptHook(port)] as const], isGrenadeHook);
}

/** `--settings '<the hooks as JSON>'`, quoted for the shell tmux runs the agent in. */
export function claudeHookFlags(port: number): string {
  return `--settings ${shellQuote(JSON.stringify(mergeHooks({}, port).settings))}`;
}

export function removeHooks(input: unknown): { settings: Settings; changed: boolean } {
  return removeEntries(input, isGrenadeHook);
}

/**
 * Puts each wanted hook entry under its event, replacing the one `isOurs` recognizes or adding a matcher for it.
 * Shared by the Claude Code settings and Codex's `hooks.json`, which have the same shape.
 */
export function mergeEntries(input: unknown, wanted: ReadonlyArray<readonly [string, HookEntry]>, isOurs: (h: HookEntry) => boolean): { settings: Settings; changed: boolean } {
  const settings: Settings = isObject(input) ? structuredClone(input) : {};
  const hooks = isObject(settings.hooks) ? (settings.hooks as Record<string, Matcher[]>) : {};
  settings.hooks = hooks;
  let changed = false;

  for (const [event, entry] of wanted) {
    const matchers: Matcher[] = Array.isArray(hooks[event]) ? hooks[event] : [];
    hooks[event] = matchers;
    const ours = matchers.find((m) => (m.hooks ?? []).some(isOurs));
    if (ours) {
      const at = (ours.hooks ?? []).findIndex(isOurs);
      if (JSON.stringify(ours.hooks?.[at]) !== JSON.stringify(entry)) {
        ours.hooks?.splice(at, 1, structuredClone(entry));
        changed = true;
      }
    } else {
      matchers.push({ matcher: "", hooks: [structuredClone(entry)] });
      changed = true;
    }
  }
  return { settings, changed };
}

/** Takes out every hook entry `isOurs` recognizes, and the matchers left empty by it. */
export function removeEntries(input: unknown, isOurs: (h: HookEntry) => boolean): { settings: Settings; changed: boolean } {
  const settings: Settings = isObject(input) ? structuredClone(input) : {};
  const hooks = isObject(settings.hooks) ? (settings.hooks as Record<string, Matcher[]>) : {};
  let changed = false;
  for (const [event, matchers] of Object.entries(hooks)) {
    if (!Array.isArray(matchers)) continue;
    const kept = matchers
      .map((m) => ({ ...m, hooks: (m.hooks ?? []).filter((h) => !isOurs(h)) }))
      .filter((m) => (m.hooks?.length ?? 0) > 0 || !matchers.some((o) => (o.hooks ?? []).some(isOurs)));
    if (kept.length !== matchers.length || kept.some((m, i) => m.hooks?.length !== matchers[i]?.hooks?.length)) changed = true;
    hooks[event] = kept;
  }
  return { settings, changed };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
