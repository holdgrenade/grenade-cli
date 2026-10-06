/**
 * `grenade talk-mcp`: the MCP server typed Talk's agent runs as its only tools (PROTOCOL.md "Talk by text"). A
 * minimal stdio server, JSON-RPC 2.0 with one message per line: `initialize`, `notifications/initialized`,
 * `tools/list`, `tools/call` and `ping`; anything else with an id is "method not found". It holds no rule and no
 * state: each call goes to the daemon's loopback control API (`POST /talk/tool`) with the turn's id and secret, which
 * the daemon gave the agent's run in the environment and checks on every call.
 */
import { createInterface } from "node:readline";
import { TALK_TOOLS } from "./talkToolDefs.js";

/** Where the server finds the daemon and its turn. Set by the daemon for the agent's run (`talkMcpEnv`). */
export const ENV_PORT = "GRENADE_TALK_PORT";
export const ENV_TURN = "GRENADE_TALK_TURN";
export const ENV_SECRET = "GRENADE_TALK_SECRET";

export const SERVER_NAME = "grenade";
/** Spoken when a client asks for no version. */
const DEFAULT_PROTOCOL_VERSION = "2025-06-18";

/** What a tool call came back as. */
export interface ToolReply {
  text: string;
  isError: boolean;
}

export type ToolCaller = (name: string, args: Record<string, unknown>) => Promise<ToolReply>;

type JsonRpcId = string | number | null;

function reply(id: JsonRpcId, result: unknown): object {
  return { jsonrpc: "2.0", id, result };
}

function failure(id: JsonRpcId, code: number, message: string): object {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

/** The answer to one message, or null for a notification. Pure but for `call`. */
export async function handleMcpMessage(message: unknown, call: ToolCaller, version: string): Promise<object | null> {
  if (typeof message !== "object" || message === null || Array.isArray(message)) return failure(null, -32600, "Invalid Request");
  const m = message as { id?: unknown; method?: unknown; params?: unknown };
  const id: JsonRpcId = typeof m.id === "string" || typeof m.id === "number" ? m.id : null;
  const isNotification = m.id === undefined;
  if (typeof m.method !== "string") return isNotification ? null : failure(id, -32600, "Invalid Request");
  const params = (typeof m.params === "object" && m.params !== null ? m.params : {}) as Record<string, unknown>;
  switch (m.method) {
    case "initialize":
      return reply(id, {
        protocolVersion: typeof params["protocolVersion"] === "string" ? params["protocolVersion"] : DEFAULT_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version },
      });
    case "ping":
      return reply(id, {});
    case "tools/list":
      return reply(id, { tools: TALK_TOOLS });
    case "tools/call": {
      const name = params["name"];
      if (typeof name !== "string") return failure(id, -32602, "tools/call needs a name");
      const args = typeof params["arguments"] === "object" && params["arguments"] !== null ? (params["arguments"] as Record<string, unknown>) : {};
      const result = await call(name, args).catch((e: unknown): ToolReply => ({ text: JSON.stringify({ error: e instanceof Error ? e.message : String(e) }), isError: true }));
      return reply(id, { content: [{ type: "text", text: result.text }], isError: result.isError });
    }
    default:
      return isNotification ? null : failure(id, -32601, `Method not found: ${m.method}`);
  }
}

/** Calls the daemon's `POST /talk/tool` for the turn named in `env`. */
export function daemonToolCaller(env: NodeJS.ProcessEnv, fetcher: typeof fetch = fetch): ToolCaller {
  const port = Number(env[ENV_PORT]);
  const turn = env[ENV_TURN] ?? "";
  const secret = env[ENV_SECRET] ?? "";
  return async (name, args) => {
    if (!Number.isInteger(port) || port <= 0) return { text: JSON.stringify({ error: "Grenade did not say where to reach it." }), isError: true };
    let res: Response;
    try {
      res = await fetcher(`http://127.0.0.1:${port}/talk/tool`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ turn, secret, name, arguments: args }),
      });
    } catch {
      return { text: JSON.stringify({ error: "Grenade is not running." }), isError: true };
    }
    const body = (await res.json().catch(() => ({}))) as { text?: unknown; isError?: unknown; message?: unknown };
    if (!res.ok || typeof body.text !== "string") {
      return { text: JSON.stringify({ error: typeof body.message === "string" ? body.message : `Grenade refused the call (${res.status}).` }), isError: true };
    }
    return { text: body.text, isError: body.isError === true };
  };
}

/** Serves MCP on stdin and stdout until stdin ends. */
export function runTalkMcp(version: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const call = daemonToolCaller(env);
  const lines = createInterface({ input: process.stdin });
  const pending = new Set<Promise<void>>();
  const write = (message: object) => process.stdout.write(`${JSON.stringify(message)}\n`);
  lines.on("line", (line) => {
    if (!line.trim()) return;
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      write(failure(null, -32700, "Parse error"));
      return;
    }
    const done = handleMcpMessage(message, call, version).then((answer) => {
      if (answer) write(answer);
    });
    pending.add(done);
    void done.finally(() => pending.delete(done));
  });
  return new Promise((resolve) => lines.on("close", () => void Promise.all(pending).then(() => resolve())));
}
