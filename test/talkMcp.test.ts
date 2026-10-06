/** Grenade's MCP server: the JSON-RPC messages it answers, and how it forwards a call to the daemon. */
import { describe, expect, it } from "vitest";
import { daemonToolCaller, handleMcpMessage, type ToolCaller } from "../src/talk/talkMcp.js";
import { TALK_TOOLS } from "../src/talk/talkToolDefs.js";

const calls: [string, Record<string, unknown>][] = [];
const call: ToolCaller = async (name, args) => {
  calls.push([name, args]);
  return { text: '{"sessions":[]}', isError: false };
};

describe("talkMcp", () => {
  it("answers initialize, ping and tools/list, and nothing for a notification", async () => {
    expect(await handleMcpMessage({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-11-25" } }, call, "1.0.52")).toEqual({
      jsonrpc: "2.0",
      id: 0,
      result: { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "grenade", version: "1.0.52" } },
    });
    expect(await handleMcpMessage({ jsonrpc: "2.0", method: "notifications/initialized" }, call, "1")).toBeNull();
    expect(await handleMcpMessage({ jsonrpc: "2.0", id: "p", method: "ping" }, call, "1")).toEqual({ jsonrpc: "2.0", id: "p", result: {} });
    const list = (await handleMcpMessage({ jsonrpc: "2.0", id: 1, method: "tools/list" }, call, "1")) as { result: { tools: { name: string }[] } };
    expect(list.result.tools.map((t) => t.name)).toEqual(["list_sessions", "read_session", "route_session", "send_to_session", "create_session", "ask_which"]);
    expect(list.result.tools).toEqual(TALK_TOOLS);
  });

  it("forwards a tool call and passes its answer back as text", async () => {
    calls.length = 0;
    const answer = await handleMcpMessage({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "list_sessions", arguments: { a: 1 } } }, call, "1");
    expect(calls).toEqual([["list_sessions", { a: 1 }]]);
    expect(answer).toEqual({ jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: '{"sessions":[]}' }], isError: false } });
    const thrown = (await handleMcpMessage({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "x" } }, async () => { throw new Error("down"); }, "1")) as { result: { isError: boolean } };
    expect(thrown.result.isError).toBe(true);
  });

  it("says method not found for anything else, as an error", async () => {
    // Claude Code probes with `server/discover` first, then falls back to `initialize`.
    expect(await handleMcpMessage({ jsonrpc: "2.0", id: "server-discover-probe-1", method: "server/discover" }, call, "1")).toMatchObject({ id: "server-discover-probe-1", error: { code: -32601 } });
    expect(await handleMcpMessage({ jsonrpc: "2.0", id: 4, method: "tools/call", params: {} }, call, "1")).toMatchObject({ error: { code: -32602 } });
    expect(await handleMcpMessage([1], call, "1")).toMatchObject({ error: { code: -32600 } });
  });

  it("calls the daemon's loopback route with the turn's id and secret", async () => {
    const seen: { url: string; body: unknown }[] = [];
    const fetcher = (async (url: string, init: RequestInit) => {
      seen.push({ url, body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify({ text: '{"state":"sent"}', isError: false }), { status: 200 });
    }) as unknown as typeof fetch;
    const caller = daemonToolCaller({ GRENADE_TALK_PORT: "7789", GRENADE_TALK_TURN: "t1", GRENADE_TALK_SECRET: "s" }, fetcher);
    expect(await caller("send_to_session", { handle: "api", text: "hi" })).toEqual({ text: '{"state":"sent"}', isError: false });
    expect(seen).toEqual([{ url: "http://127.0.0.1:7789/talk/tool", body: { turn: "t1", secret: "s", name: "send_to_session", arguments: { handle: "api", text: "hi" } } }]);
    const refused = daemonToolCaller({ GRENADE_TALK_PORT: "7789" }, (async () => new Response(JSON.stringify({ error: "forbidden", message: "This Talk turn is over." }), { status: 403 })) as unknown as typeof fetch);
    expect(await refused("list_sessions", {})).toEqual({ text: JSON.stringify({ error: "This Talk turn is over." }), isError: true });
    expect((await daemonToolCaller({}, fetcher)("list_sessions", {})).isError).toBe(true);
  });
});
