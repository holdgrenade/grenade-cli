/** POST /hooks/claude?session=<id>: Claude Code hook payloads become session status. */
import {
  ClaudeHookEvent,
  claudeBackgroundStartIn,
  claudeBackgroundTasksIn,
  statusForClaudeHook,
  waitingForClaudeHook,
  type ReportedBackgroundTask,
  type WaitingFor,
} from "@grenade/protocol";
import type { Logger } from "../log.js";

export interface HookRegistryPort {
  /** `aside`: not the agent's own turn (a tool call inside a subagent), so it starts no turn and ends no background hold. */
  applyHook(id: string, status: "waiting" | "working" | "idle" | "gone", waitingFor?: WaitingFor, aside?: boolean): boolean;
  /** A turn ended with these tasks still running in the background: the session stays `working` (PROTOCOL.md "Background tasks"). */
  holdForBackground(id: string, tasks: readonly ReportedBackgroundTask[]): boolean;
  /** The agent has just started a background task with this id. */
  backgroundStarted(id: string, taskId: string): void;
}

export interface HookResult {
  status: number;
  body: { ok: boolean; reason?: string; applied?: string };
}

/**
 * `onPrompt` receives the user's prompt from an applied `UserPromptSubmit`, for the session summary.
 * `onTranscript` receives the transcript path of any applied hook, and the hook's event, to read the session's model and
 * activity from.
 * `onAsked` receives the `message` of a hook that left the session waiting for an answer, for its push.
 */
export function handleClaudeHook(
  registry: HookRegistryPort,
  sessionParam: string | null,
  rawBody: string,
  log: Logger,
  onPrompt?: (sessionId: string, prompt: string) => void,
  onTranscript?: (sessionId: string, path: string, event: string) => void,
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
  // A turn that ends with background tasks still running is not over: Claude Code starts another when they end.
  const running = parsed.data.hook_event_name === "Stop" ? claudeBackgroundTasksIn(parsed.data) : [];
  // A tool call inside a subagent (Claude Code's own side agents too) is not the session's turn: no `Stop` follows it.
  const aside = status === "working" && Boolean(parsed.data.agent_id);
  const applied =
    running.length > 0 ? registry.holdForBackground(sessionParam, running) : aside ? registry.applyHook(sessionParam, status, waitingFor, true) : registry.applyHook(sessionParam, status, waitingFor);
  if (!applied) return { status: 404, body: { ok: false, reason: `unknown session ${sessionParam}` } };
  const started = parsed.data.hook_event_name === "PostToolUse" ? claudeBackgroundStartIn(parsed.data) : null;
  if (started) registry.backgroundStarted(sessionParam, started);
  if (parsed.data.prompt !== undefined) onPrompt?.(sessionParam, parsed.data.prompt);
  if (parsed.data.transcript_path) onTranscript?.(sessionParam, parsed.data.transcript_path, parsed.data.hook_event_name);
  if (waitingFor === "answer" && parsed.data.message) onAsked?.(sessionParam, parsed.data.message);
  const shown = running.length > 0 ? "working" : status;
  log.debug(`Claude hook ${parsed.data.hook_event_name}`, { session: sessionParam, status: shown, ...(running.length > 0 ? { background: running.length } : {}), ...(aside ? { subagent: parsed.data.agent_id } : {}) });
  return { status: 200, body: { ok: true, applied: shown } };
}
