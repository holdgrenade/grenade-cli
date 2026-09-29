/**
 * POST /hooks/claude/prompt: Claude Code's `PermissionRequest` hook, held open until a phone answers the prompt
 * or it is dealt with on the Mac (PROTOCOL.md "Prompt hook"). Every answer is a 200: anything else shows up in
 * Claude Code as a hook error, and an empty 200 simply leaves the prompt to the terminal.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { PROMPT_HOOK_SESSION_HEADER, type PromptFrame } from "@grenade/protocol";
import type { Logger } from "../log.js";
import type { PromptStore, Respond } from "../prompts/promptStore.js";
import { readBody, sendJson } from "./http.js";

export interface PromptHookDeps {
  prompts: PromptStore;
  /** Applies the event like any other hook (status, `waitingFor`, push). False when the session is unknown. */
  applyHook(sessionId: string, rawBody: string): boolean;
  log: Logger;
}

/** The session and body of a hook request become an open prompt, or null when the request is answered at once. */
export function openPromptFromHook(d: PromptHookDeps, sessionId: string | undefined, rawBody: string, respond: Respond): PromptFrame | null {
  if (!sessionId) return null; // a Claude Code that Grenade did not start
  let payload: unknown;
  try {
    payload = JSON.parse(rawBody || "{}");
  } catch {
    d.log.debug("A prompt hook's body was not JSON", { session: sessionId });
    return null;
  }
  if (!d.applyHook(sessionId, rawBody)) {
    d.log.debug("A prompt hook named a session the daemon does not know", { session: sessionId });
    return null;
  }
  const frame = d.prompts.open(sessionId, payload, respond);
  if (frame) d.log.debug(`Claude Code is asking: ${frame.kind}`, { session: sessionId, prompt: frame.promptId, tool: frame.tool });
  return frame;
}

export async function handlePromptHook(req: IncomingMessage, res: ServerResponse, d: PromptHookDeps): Promise<void> {
  const header = req.headers[PROMPT_HOOK_SESSION_HEADER];
  const sessionId = (Array.isArray(header) ? header[0] : header)?.trim() || undefined;
  const respond: Respond = (reply) => {
    if (res.writableEnded || res.destroyed) return;
    if (reply) sendJson(res, 200, reply);
    else res.writeHead(200, { "content-length": 0 }).end();
  };
  const frame = openPromptFromHook(d, sessionId, await readBody(req), respond);
  if (!frame) return respond(null);
  // Closed before the answer went out: Claude Code let go of the request.
  res.on("close", () => {
    if (!res.writableFinished) d.prompts.dropped(frame.promptId);
  });
}

/** A hook that reached `/hooks/claude`: it may mean an open prompt was dealt with on the Mac. */
export function closePromptsByHook(prompts: PromptStore, sessionId: string | null, rawBody: string): void {
  if (!sessionId) return;
  try {
    const json = JSON.parse(rawBody || "{}") as { hook_event_name?: unknown; tool_name?: unknown };
    if (typeof json.hook_event_name !== "string") return;
    prompts.closeByHook(sessionId, json.hook_event_name, typeof json.tool_name === "string" ? json.tool_name : undefined);
  } catch {
    // Not JSON: `handleClaudeHook` has answered that already.
  }
}
