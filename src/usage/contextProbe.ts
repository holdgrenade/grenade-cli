/**
 * What a folder loads into a Claude Code session before the user types (PROTOCOL.md "Usage", "Where it goes"):
 * `claude` started in the folder with the user's settings but no hooks, asked over stream-json for its context usage
 * (`get_context_usage`, `detail: "summary"`, which counts locally and calls no API), and stopped. No prompt is sent and
 * no conversation is saved. The answer's parsing and what a session's context is made of from it are pure.
 */
import { spawn } from "node:child_process";
import { CONTEXT_PART_MESSAGES, CONTEXT_PARTS_MAX, type ContextPart, type SessionContext } from "@grenade/protocol";

const PROBE_TIMEOUT_MS = 20_000;

/** What the probe keeps of Claude Code's answer. */
export interface ContextProbeAnswer {
  /** The categories in the window that are not the conversation, with tokens, in Claude Code's order. */
  fixed: ContextPart[];
  /** The window it measured against, and where it compacts in it; `compacts` false when auto-compact is off. */
  window: number;
  threshold?: number;
  /** The tokens it keeps for compacting. */
  buffer?: number;
  compacts: boolean;
  /** The memory files it loaded, absolute: a change to one measures again. */
  memoryFiles: string[];
}

interface Category {
  id?: unknown;
  name?: unknown;
  tokens?: unknown;
  kind?: unknown;
}

/** Claude Code's `get_context_usage` answer, as the probe keeps it; undefined for one it cannot read. */
export function probeAnswerOf(response: unknown): ContextProbeAnswer | undefined {
  const r = (response ?? {}) as {
    categories?: unknown;
    rawMaxTokens?: unknown;
    autoCompactThreshold?: unknown;
    isAutoCompactEnabled?: unknown;
    memoryFiles?: unknown;
  };
  if (!Array.isArray(r.categories) || typeof r.rawMaxTokens !== "number" || r.rawMaxTokens < 1) return undefined;
  const fixed: ContextPart[] = [];
  let buffer: number | undefined;
  for (const c of r.categories as Category[]) {
    if (typeof c?.name !== "string" || typeof c.tokens !== "number" || c.tokens < 0) continue;
    const id = typeof c.id === "string" && c.id ? c.id : c.name.toLowerCase().replace(/[^a-z0-9]+/g, "_").slice(0, 32);
    if (c.kind === "buffer") buffer = (buffer ?? 0) + Math.round(c.tokens);
    if (c.kind !== "used" || id === CONTEXT_PART_MESSAGES || c.tokens === 0) continue;
    fixed.push({ id: id.slice(0, 32), name: c.name.slice(0, 60), tokens: Math.round(c.tokens) });
  }
  const memoryFiles = Array.isArray(r.memoryFiles)
    ? (r.memoryFiles as { path?: unknown }[]).flatMap((m) => (typeof m?.path === "string" ? [m.path] : []))
    : [];
  return {
    fixed: fixed.slice(0, CONTEXT_PARTS_MAX - 1),
    window: Math.round(r.rawMaxTokens),
    ...(typeof r.autoCompactThreshold === "number" && r.autoCompactThreshold > 0 ? { threshold: Math.round(r.autoCompactThreshold) } : {}),
    ...(buffer !== undefined ? { buffer } : {}),
    compacts: r.isAutoCompactEnabled !== false,
    memoryFiles,
  };
}

/**
 * A session's context with what it holds: the folder's fixed parts, then the conversation as the rest of `used`
 * (never below 0), and where it compacts: the measured threshold when the session's window is the one measured, else
 * the window less the buffer.
 */
export function withParts(context: SessionContext, answer: ContextProbeAnswer | undefined): SessionContext {
  const plain: SessionContext = { used: context.used, size: context.size };
  if (!answer) return plain;
  const fixedSum = answer.fixed.reduce((sum, p) => sum + p.tokens, 0);
  const parts = [...answer.fixed, { id: CONTEXT_PART_MESSAGES, name: "Messages", tokens: Math.max(0, context.used - fixedSum) }];
  let compactsAt: number | undefined;
  if (answer.compacts) {
    if (answer.window === context.size && answer.threshold !== undefined) compactsAt = answer.threshold;
    else if (answer.buffer !== undefined && context.size > answer.buffer) compactsAt = context.size - answer.buffer;
  }
  return { ...plain, parts, ...(compactsAt !== undefined ? { compactsAt } : {}) };
}

/** Starts `claude` in `cwd`, asks for its context usage before any prompt, and stops it. Rejects on a failure or 20 s. */
export function probeContext(bin: string, cwd: string): Promise<ContextProbeAnswer> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    // Never reported as one of Grenade's sessions.
    delete env["GRENADE_SESSION"];
    const child = spawn(
      bin,
      ["--output-format", "stream-json", "--verbose", "--input-format", "stream-json", "--settings", JSON.stringify({ disableAllHooks: true })],
      { cwd, env, stdio: ["pipe", "pipe", "ignore"] },
    );
    let settled = false;
    const finish = (error: Error | undefined, answer?: ContextProbeAnswer) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      if (error) reject(error);
      else resolve(answer!);
    };
    const timer = setTimeout(() => finish(new Error("claude did not answer for its context in time")), PROBE_TIMEOUT_MS);
    timer.unref?.();
    let buffered = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffered += chunk;
      for (let i = buffered.indexOf("\n"); i >= 0; i = buffered.indexOf("\n")) {
        const line = buffered.slice(0, i);
        buffered = buffered.slice(i + 1);
        let message: { type?: unknown; response?: { request_id?: unknown; subtype?: unknown; response?: unknown; error?: unknown } };
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message.type !== "control_response" || message.response?.request_id !== "grenade-context") continue;
        if (message.response.subtype !== "success") return finish(new Error(String(message.response.error ?? "claude refused")));
        const answer = probeAnswerOf(message.response.response);
        return answer ? finish(undefined, answer) : finish(new Error("claude's context answer could not be read"));
      }
    });
    child.on("error", (e) => finish(e));
    child.on("exit", () => finish(new Error("claude stopped before it answered")));
    const ask = (request_id: string, request: object) => child.stdin.write(`${JSON.stringify({ request_id, type: "control_request", request })}\n`);
    child.stdin.on("error", () => {});
    ask("grenade-init", { subtype: "initialize" });
    ask("grenade-context", { subtype: "get_context_usage", detail: "summary" });
  });
}
