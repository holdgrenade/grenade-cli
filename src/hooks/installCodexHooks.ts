/**
 * Grenade's Codex hooks (PROTOCOL.md "Codex hooks"). Nothing is written to ~/.codex: the daemon passes the hooks as
 * `-c` flags to the Codex it starts (`codexHookFlags`), so they exist only in Grenade's sessions. Codex runs a hook
 * only after the user has trusted it, against a hash of the hook, so the flags must be the same for every session
 * (the session id comes from `$GRENADE_SESSION` at run time) and should not change from one release to the next.
 * `removeCodexHooks` takes out the hooks.json entries that CLI 1.0.23 wrote there, which would now post twice.
 */
import { removeEntries, type HookEntry, type Settings } from "./installHooks.js";
import { shellQuote } from "./shellQuote.js";

/** Events that report status, in a fixed order. Codex has no Notification and no StopFailure; Interrupt is Esc. */
export const CODEX_HOOK_EVENTS = ["UserPromptSubmit", "PreToolUse", "PostToolUse", "PermissionRequest", "Stop", "Interrupt", "SessionEnd"] as const;
export const CODEX_HOOK_MARKER = "/hooks/codex";

/** Throws the daemon's answer away (Codex would read it as context or a decision) and always succeeds. `-m 1`: Codex gives Interrupt and SessionEnd one second. */
export function codexHookCommand(port: number): string {
  return `curl -s -m 1 -o /dev/null -X POST "http://127.0.0.1:${port}${CODEX_HOOK_MARKER}?session=$GRENADE_SESSION" -H 'content-type: application/json' --data-binary @- || true`;
}

/** `-c hooks.<Event>=[…]` for every event, quoted for the shell tmux runs the agent in. */
export function codexHookFlags(port: number): string {
  const handler = `[{matcher="",hooks=[{type="command",command=${tomlString(codexHookCommand(port))}}]}]`;
  return CODEX_HOOK_EVENTS.map((event) => `-c ${shellQuote(`hooks.${event}=${handler}`)}`).join(" ");
}

function tomlString(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

const isGrenadeHook = (h: HookEntry) => typeof h.command === "string" && h.command.includes(CODEX_HOOK_MARKER);

export function removeCodexHooks(input: unknown): { settings: Settings; changed: boolean } {
  return removeEntries(input, isGrenadeHook);
}
