/** POST /hooks/codex?session=<id>: Codex hook payloads become session status (PROTOCOL.md "Codex hooks"). */
import { CodexHookEvent, statusForCodexHook, waitingForCodexHook } from "@grenade/protocol";
import type { Logger } from "../log.js";
import type { HookRegistryPort, HookResult } from "./hooks.js";

export interface CodexHookListeners {
  /** The user's prompt from an applied `UserPromptSubmit`, for the summary and the activity. */
  onPrompt?: (sessionId: string, prompt: string) => void;
  /** The rollout path of any applied hook, and the hook's event, to read the activity from. */
  onTranscript?: (sessionId: string, path: string, event: string) => void;
  /** The model slug the payload names. */
  onModel?: (sessionId: string, model: string) => void;
}

export function handleCodexHook(registry: HookRegistryPort, sessionParam: string | null, rawBody: string, log: Logger, on: CodexHookListeners = {}): HookResult {
  if (!sessionParam) return { status: 202, body: { ok: true, reason: "no session param; not a grenade session" } };
  let json: unknown;
  try {
    json = JSON.parse(rawBody || "{}");
  } catch {
    return { status: 400, body: { ok: false, reason: "body is not JSON" } };
  }
  const parsed = CodexHookEvent.safeParse(json);
  if (!parsed.success) return { status: 400, body: { ok: false, reason: "not a hook payload" } };
  const event = parsed.data.hook_event_name;
  const status = statusForCodexHook(event);
  if (!status) return { status: 202, body: { ok: true, reason: `event ${event} carries no status` } };
  if (!registry.applyHook(sessionParam, status, waitingForCodexHook(event) ?? undefined)) return { status: 404, body: { ok: false, reason: `unknown session ${sessionParam}` } };
  if (parsed.data.model) on.onModel?.(sessionParam, parsed.data.model);
  if (parsed.data.prompt !== undefined) on.onPrompt?.(sessionParam, parsed.data.prompt);
  if (parsed.data.transcript_path) on.onTranscript?.(sessionParam, parsed.data.transcript_path, event);
  log.debug(`Codex hook ${event}`, { session: sessionParam, status });
  return { status: 200, body: { ok: true, applied: status } };
}
