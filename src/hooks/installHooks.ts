/**
 * Pure merge of Grenade's Claude Code hooks into a settings object (~/.claude/settings.json).
 * Idempotent: an existing Grenade hook is replaced, everything else is left untouched.
 */
import { PROMPT_HOOK_PATH, PROMPT_HOOK_TIMEOUT_S } from "@grenade/protocol";

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

interface HookEntry {
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
type Settings = Record<string, unknown> & { hooks?: Record<string, Matcher[]> };

const isGrenadeHook = (h: HookEntry) =>
  (typeof h.command === "string" && h.command.includes(HOOK_MARKER)) || (typeof h.url === "string" && h.url.includes(HOOK_MARKER));

export function mergeHooks(input: unknown, port: number): { settings: Settings; changed: boolean } {
  const settings: Settings = isObject(input) ? structuredClone(input) : {};
  const hooks = isObject(settings.hooks) ? (settings.hooks as Record<string, Matcher[]>) : {};
  settings.hooks = hooks;
  const command: HookEntry = { type: "command", command: hookCommand(port) };
  let changed = false;

  for (const [event, wanted] of [...HOOK_EVENTS.map((e) => [e, command] as const), [PROMPT_EVENT, promptHook(port)] as const]) {
    const matchers: Matcher[] = Array.isArray(hooks[event]) ? hooks[event] : [];
    hooks[event] = matchers;
    const ours = matchers.find((m) => (m.hooks ?? []).some(isGrenadeHook));
    if (ours) {
      const at = (ours.hooks ?? []).findIndex(isGrenadeHook);
      if (JSON.stringify(ours.hooks?.[at]) !== JSON.stringify(wanted)) {
        ours.hooks?.splice(at, 1, structuredClone(wanted));
        changed = true;
      }
    } else {
      matchers.push({ matcher: "", hooks: [structuredClone(wanted)] });
      changed = true;
    }
  }
  return { settings, changed };
}

export function removeHooks(input: unknown): { settings: Settings; changed: boolean } {
  const settings: Settings = isObject(input) ? structuredClone(input) : {};
  const hooks = isObject(settings.hooks) ? (settings.hooks as Record<string, Matcher[]>) : {};
  let changed = false;
  for (const [event, matchers] of Object.entries(hooks)) {
    if (!Array.isArray(matchers)) continue;
    const kept = matchers
      .map((m) => ({ ...m, hooks: (m.hooks ?? []).filter((h) => !isGrenadeHook(h)) }))
      .filter((m) => (m.hooks?.length ?? 0) > 0 || !matchers.some((o) => (o.hooks ?? []).some(isGrenadeHook)));
    if (kept.length !== matchers.length || kept.some((m, i) => m.hooks?.length !== matchers[i]?.hooks?.length)) changed = true;
    hooks[event] = kept;
  }
  return { settings, changed };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
