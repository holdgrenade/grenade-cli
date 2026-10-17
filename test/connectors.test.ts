import { describe, expect, it } from "vitest";
import { ConnectorsFrame } from "@grenade/protocol";
import { connectorsFrom, mcpServersIn, stateOfWords } from "../src/connectors/mcpList.js";
import { ConnectorReader } from "../src/connectors/connectorReader.js";

// What `claude mcp list` (Claude Code 2.1) printed on a Mac with claude.ai's connectors and the engineering plugin.
const LISTED = `Checking MCP server health…

claude.ai Slack: https://mcp.slack.com/mcp - ✔ Connected
claude.ai Linear: https://mcp.linear.app/mcp - ! Needs authentication
plugin:pdf-viewer:pdf: npx -y @modelcontextprotocol/server-pdf --stdio - ✔ Connected
plugin:engineering:slack: https://mcp.slack.com/mcp (HTTP) - ! Needs authentication
plugin:engineering:linear: https://mcp.linear.app/mcp (HTTP) - ✔ Connected
plugin:engineering:gmail:  (HTTP) - - Not configured
paper: http://127.0.0.1:29979/mcp (HTTP) - ✘ Failed to connect — ECONNREFUSED: Unable to connect
`;

describe("mcpServersIn", () => {
  it("reads each server line's name, address and state, colons in the name and dashes in a command included", () => {
    const servers = mcpServersIn(LISTED);
    expect(servers).toHaveLength(7);
    expect(servers[0]).toEqual({ name: "claude.ai Slack", target: "https://mcp.slack.com/mcp", state: "connected" });
    expect(servers[2]).toEqual({ name: "plugin:pdf-viewer:pdf", target: "npx -y @modelcontextprotocol/server-pdf --stdio", state: "connected" });
    expect(servers[5]).toEqual({ name: "plugin:engineering:gmail", target: "(HTTP)", state: "off" });
    expect(servers[6]?.state).toBe("failed");
  });

  it("skips the heading and blank lines", () => {
    expect(mcpServersIn("Checking MCP server health…\n\nNo MCP servers configured.\n")).toEqual([]);
  });

  it("reads a state it does not know as failed", () => {
    expect(stateOfWords("Pending approval")).toBe("failed");
  });
});

describe("connectorsFrom", () => {
  it("gives each connector the best state among the servers at its address", () => {
    expect(connectorsFrom(mcpServersIn(LISTED))).toEqual([
      { id: "linear", name: "Linear", agent: "claude", state: "connected", server: "plugin:engineering:linear", manage: "https://claude.ai/settings/connectors" },
      { id: "slack", name: "Slack", agent: "claude", state: "connected", server: "claude.ai Slack", manage: "https://claude.ai/settings/connectors" },
    ]);
  });

  it("lists a connector with no server as off, without a server name", () => {
    expect(connectorsFrom([])).toEqual([
      { id: "linear", name: "Linear", agent: "claude", state: "off", manage: "https://claude.ai/settings/connectors" },
      { id: "slack", name: "Slack", agent: "claude", state: "off", manage: "https://claude.ai/settings/connectors" },
    ]);
  });

  it("knows a command-line server by its name", () => {
    const [linear] = connectorsFrom([{ name: "linear", target: "npx -y linear-mcp", state: "connected" }]);
    expect(linear?.state).toBe("connected");
  });

  it("makes frames the protocol takes", () => {
    const frame = { type: "connectors", connectors: connectorsFrom(mcpServersIn(LISTED)), at: new Date(0).toISOString() };
    expect(ConnectorsFrame.safeParse(frame).success).toBe(true);
  });
});

describe("ConnectorReader", () => {
  it("answers from a fresh reading, and reads again when asked to refresh or after a minute", async () => {
    let runs = 0;
    let now = 1_000_000;
    const reader = new ConnectorReader(async () => (runs++, LISTED), () => now);
    await reader.read();
    await reader.read();
    expect(runs).toBe(1);
    await reader.read(true);
    expect(runs).toBe(2);
    now += 61_000;
    await reader.read();
    expect(runs).toBe(3);
  });

  it("runs one reading for requests that come while it reads", async () => {
    let runs = 0;
    let finish: (out: string) => void = () => {};
    const reader = new ConnectorReader(() => (runs++, new Promise((r) => (finish = r))));
    const a = reader.read(true);
    const b = reader.read(true);
    finish(LISTED);
    expect(await a).toBe(await b);
    expect(runs).toBe(1);
  });

  it("says what went wrong, lists nothing, and tries again on the next request", async () => {
    let runs = 0;
    const reader = new ConnectorReader(async () => {
      runs++;
      throw new Error("Claude Code is not installed on this Mac.");
    });
    const frame = await reader.read();
    expect(frame.connectors).toEqual([]);
    expect(frame.problem).toBe("Claude Code is not installed on this Mac.");
    expect(ConnectorsFrame.safeParse(frame).success).toBe(true);
    await reader.read();
    expect(runs).toBe(2);
  });
});
