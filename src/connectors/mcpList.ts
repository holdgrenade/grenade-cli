/**
 * Pure: the connectors (PROTOCOL.md "Connectors") in what `claude mcp list` prints. One line per MCP server,
 * `<name>: <address or command> - <mark> <state words>`; the name may hold colons (`plugin:engineering:slack`) but
 * not a colon and a space, and the state is the first " - <mark> <words>" after it (a command's own dashes are
 * followed by a flag, never by a mark and a word). Each connector of the catalog takes the best state of the servers that match it.
 */
import { CONNECTOR_CONNECTED, CONNECTOR_FAILED, CONNECTOR_NEEDS_AUTH, CONNECTOR_OFF, type ConnectorInfo } from "@grenade/protocol";

/** One MCP server as `claude mcp list` lists it. */
export interface McpServer {
  name: string;
  target: string;
  state: string;
}

/** A connector Grenade shows, whether or not it is configured, and how a server is recognized as it. */
export interface ConnectorKind {
  id: string;
  name: string;
  agent: string;
  /** The hosts of its MCP server's address (`mcp.linear.app`). */
  hosts: readonly string[];
  /** Where the owner connects it: claude.ai's connector settings, which reach Claude Code on every signed-in computer. */
  manage: string;
}

const CLAUDE_AI_CONNECTORS = "https://claude.ai/settings/connectors";

/** The connectors this daemon knows, in the order a client shows them. */
export const CONNECTOR_KINDS: readonly ConnectorKind[] = [
  { id: "linear", name: "Linear", agent: "claude", hosts: ["mcp.linear.app"], manage: CLAUDE_AI_CONNECTORS },
  { id: "slack", name: "Slack", agent: "claude", hosts: ["mcp.slack.com"], manage: CLAUDE_AI_CONNECTORS },
];

/** Best first: when several servers match a connector, the first of these among them wins. */
const RANK = [CONNECTOR_CONNECTED, CONNECTOR_NEEDS_AUTH, CONNECTOR_FAILED, CONNECTOR_OFF];

/** The protocol's state for the words after a server's mark. "Pending approval" and anything new read as `failed`. */
export function stateOfWords(words: string): string {
  const w = words.toLowerCase();
  if (w.startsWith("connected")) return CONNECTOR_CONNECTED;
  if (w.startsWith("needs authentication")) return CONNECTOR_NEEDS_AUTH;
  if (w.startsWith("not configured") || w.startsWith("disabled")) return CONNECTOR_OFF;
  return CONNECTOR_FAILED;
}

/** Every server line of `claude mcp list`'s output; the heading ("Checking MCP server health…") and blanks are skipped. */
export function mcpServersIn(output: string): McpServer[] {
  const servers: McpServer[] = [];
  for (const raw of output.split("\n")) {
    const line = raw.trim();
    const colon = line.indexOf(": ");
    if (colon <= 0) continue;
    // " - ", the mark (✔ ! ✘ - ⏸, itself a dash for "Not configured"), a space, then words that start with a letter.
    const state = /^(.*?)\s+-\s+\S\s+([A-Za-z].*)$/.exec(line.slice(colon + 2));
    if (!state) continue;
    servers.push({ name: line.slice(0, colon), target: (state[1] ?? "").trim(), state: stateOfWords(state[2] ?? "") });
  }
  return servers;
}

/** The host of a server's address, or none for a command line. */
function hostOf(target: string): string | undefined {
  const url = target.split(/\s/)[0] ?? "";
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

/** Whether `server` is `kind`'s: by its address's host, else (a command line) by its name holding the connector's id. */
function matches(kind: ConnectorKind, server: McpServer): boolean {
  const host = hostOf(server.target);
  if (host) return kind.hosts.some((h) => host === h || host.endsWith(`.${h}`));
  return server.name.toLowerCase().split(/[^a-z0-9]+/).includes(kind.id);
}

/** Each kind with the best state of the servers that match it, `off` without a server. */
export function connectorsFrom(servers: readonly McpServer[], kinds: readonly ConnectorKind[] = CONNECTOR_KINDS): ConnectorInfo[] {
  return kinds.map((kind) => {
    const best = servers
      .filter((s) => matches(kind, s))
      .sort((a, b) => rank(a.state) - rank(b.state))[0];
    const info: ConnectorInfo = { id: kind.id, name: kind.name, agent: kind.agent, state: best?.state ?? CONNECTOR_OFF, manage: kind.manage };
    if (best && best.state !== CONNECTOR_OFF) info.server = best.name.slice(0, 120);
    return info;
  });
}

function rank(state: string): number {
  const i = RANK.indexOf(state);
  return i === -1 ? RANK.length : i;
}
