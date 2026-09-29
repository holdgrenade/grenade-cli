/** POST /hooks/claude?session=<id>: Claude Code hook payloads become session status. */
import { ClaudeHookEvent, statusForClaudeHook, waitingForClaudeHook, type WaitingFor } from "@grenade/protocol";
import type { Logger } from "../log.js";

export interface HookRegistryPort {
  applyHook(id: string, status: "waiting" | "working" | "idle" | "gone", waitingFor?: WaitingFor): boolean;
}

export interface HookResult {
  status: number;
  body: { ok: boolean; reason?: string; applied?: string };
}

/**
 * `onPrompt` receives the user's prompt from an applied `UserPromptSubmit`, for the session summary.
 * `onTranscript` receives the transcript path of any applied hook, to read the session's model from.
 * `onAsked` receives the `message` of a hook that left the session waiting for an answer, for its push.
 */
export function handleClaudeHook(
  registry: HookRegistryPort,
  sessionParam: string | null,
  rawBody: string,
  log: Logger,
  onPrompt?: (sessionId: string, prompt: string) => void,
  onTranscript?: (sessionId: string, path: string) => void,
  onAsked?: (sessionId: string, message: string) => void,
): HookResult {
  if (!sessionParam) return { status: 202, body: { ok: true, reason: "no session param; not a grenade session" } };
  let json: unknown;
  try {
    json = JSON.parse(rawBody || "{}");
  } catch {
    return { status: 400, body: { ok: false, reason: "body is not JSON" } };
  }
  const parsed = ClaudeHookEvent.safeParse(json);
  if (!parsed.success) return { status: 400, body: { ok: false, reason: "not a hook payload" } };
  const status = statusForClaudeHook(parsed.data.hook_event_name, parsed.data.notification_type);
  if (!status) return { status: 202, body: { ok: true, reason: `event ${parsed.data.hook_event_name} carries no status` } };
  const waitingFor = waitingForClaudeHook(parsed.data.hook_event_name, parsed.data.notification_type) ?? undefined;
  if (!registry.applyHook(sessionParam, status, waitingFor)) return { status: 404, body: { ok: false, reason: `unknown session ${sessionParam}` } };
  if (parsed.data.prompt !== undefined) onPrompt?.(sessionParam, parsed.data.prompt);
  if (parsed.data.transcript_path) onTranscript?.(sessionParam, parsed.data.transcript_path);
  if (waitingFor === "answer" && parsed.data.message) onAsked?.(sessionParam, parsed.data.message);
  log.debug(`Claude hook ${parsed.data.hook_event_name}`, { session: sessionParam, status });
  return { status: 200, body: { ok: true, applied: status } };
}
