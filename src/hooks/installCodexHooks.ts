/**
 * Pure merge of Grenade's Codex hooks into Codex's hooks.json (~/.codex/hooks.json, PROTOCOL.md "Codex hooks").
 * Same shape and rules as the Claude Code settings (`installHooks.ts`). Codex runs a hook only after the user has
 * trusted it, against a hash of the hook, so the command must stay the same from one install to the next.
 */
import { mergeEntries, removeEntries, type HookEntry, type Settings } from "./installHooks.js";

/** Events that report status. Codex has no Notification and no StopFailure; Interrupt is Esc. */
export const CODEX_HOOK_EVENTS = ["UserPromptSubmit", "PreToolUse", "PostToolUse", "PermissionRequest", "Stop", "Interrupt", "SessionEnd"] as const;
export const CODEX_HOOK_MARKER = "/hooks/codex";

/**
 * Runs only inside a Grenade session, throws the daemon's answer away (Codex would read it as context or a decision)
 * and always succeeds. `-m 1`: Codex gives Interrupt and SessionEnd hooks one second.
 */
export function codexHookCommand(port: number): string {
  return `[ -z "$GRENADE_SESSION" ] || curl -s -m 1 -o /dev/null -X POST "http://127.0.0.1:${port}${CODEX_HOOK_MARKER}?session=$GRENADE_SESSION" -H 'content-type: application/json' --data-binary @- || true`;
}

const isGrenadeHook = (h: HookEntry) => typeof h.command === "string" && h.command.includes(CODEX_HOOK_MARKER);

export function mergeCodexHooks(input: unknown, port: number): { settings: Settings; changed: boolean } {
  const command: HookEntry = { type: "command", command: codexHookCommand(port) };
  return mergeEntries(input, CODEX_HOOK_EVENTS.map((e) => [e, command] as const), isGrenadeHook);
}

export function removeCodexHooks(input: unknown): { settings: Settings; changed: boolean } {
  return removeEntries(input, isGrenadeHook);
}
