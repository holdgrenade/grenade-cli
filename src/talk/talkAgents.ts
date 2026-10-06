/**
 * How each agent answers one turn of typed Talk headless, and how its answer is read. Pure, tested; `talkRunner.ts`
 * spawns what these build. Which agents can answer, and how, is the daemon's own business (PROTOCOL.md "Talk by text").
 *
 * Both run in a private work folder (`<GRENADE_HOME>/talk/work`), so no project's CLAUDE.md or AGENTS.md is read,
 * with Grenade's MCP server as their only tools:
 * - Claude Code: `claude -p --output-format json --tools "" --strict-mcp-config --mcp-config <json>
 *   --allowedTools mcp__grenade --setting-sources "" --append-system-prompt <instructions>`, then `--session-id <uuid>`
 *   on the conversation's first turn and `--resume <uuid>` after. No built-in tool, no settings (so no hooks), no
 *   other MCP server. The words go in on stdin; the answer is the JSON's `result`.
 * - Codex: `codex exec --json --skip-git-repo-check --ignore-user-config -s read-only --disable <tools> -C <work>`
 *   with the MCP server given by `-c mcp_servers.grenade.*` (its tools approved, since nobody can approve in exec),
 *   then `codex exec resume … <thread id>`. No shell, no apps, no browser, no user config (so no other MCP server and
 *   no hooks). The words go in on stdin (`-`); the answer is the last `agent_message` of the JSONL, the thread id is
 *   `thread.started`'s.
 */
import { ENV_PORT, ENV_SECRET, ENV_TURN, SERVER_NAME } from "./talkMcp.js";

/** The agents that can answer typed Talk, in the order `AGENTS` lists them. */
export const TALK_AGENT_KINDS = ["claude", "codex"] as const;
export type TalkAgentKind = (typeof TALK_AGENT_KINDS)[number];

export function isTalkAgentKind(kind: string): kind is TalkAgentKind {
  return (TALK_AGENT_KINDS as readonly string[]).includes(kind);
}

/** How the agent starts Grenade's MCP server: `node <cli.js> talk-mcp`. */
export interface McpLaunch {
  command: string;
  args: string[];
}

/** One turn: the conversation it continues (none: a new one) and what it is told. */
export interface TalkTurnSpec {
  /** Claude Code: the session id Grenade chose. Codex: the thread id Codex gave. */
  conversation: string | undefined;
  /** Claude Code only: the id a new conversation takes. */
  newConversation?: string | undefined;
  mcp: McpLaunch;
  instructions: string;
  workDir: string;
}

/** Codex's tools that are not Grenade's, turned off for a Talk turn. */
export const CODEX_DISABLED_FEATURES = ["shell_tool", "unified_exec", "apps", "plugins", "browser_use", "computer_use", "in_app_browser", "image_generation", "multi_agent", "goals"];

export function claudeTalkArgs(spec: TalkTurnSpec): string[] {
  const mcpConfig = JSON.stringify({ mcpServers: { [SERVER_NAME]: { command: spec.mcp.command, args: spec.mcp.args } } });
  const conversation = spec.conversation ? ["--resume", spec.conversation] : ["--session-id", spec.newConversation ?? ""];
  return [
    "-p",
    "--output-format", "json",
    "--tools", "",
    "--strict-mcp-config",
    "--mcp-config", mcpConfig,
    "--allowedTools", `mcp__${SERVER_NAME}`,
    "--setting-sources", "",
    "--append-system-prompt", spec.instructions,
    ...conversation,
  ];
}

export function codexTalkArgs(spec: TalkTurnSpec): string[] {
  const config = [
    `mcp_servers.${SERVER_NAME}.command=${tomlString(spec.mcp.command)}`,
    `mcp_servers.${SERVER_NAME}.args=[${spec.mcp.args.map(tomlString).join(", ")}]`,
    // Codex hands an MCP server only the variables it is told to.
    `mcp_servers.${SERVER_NAME}.env_vars=[${[ENV_PORT, ENV_TURN, ENV_SECRET].map(tomlString).join(", ")}]`,
    // Nobody can approve a tool call in exec: Grenade's own are approved, and checked by the daemon.
    `mcp_servers.${SERVER_NAME}.default_tools_approval_mode="approve"`,
    `developer_instructions=${tomlString(spec.instructions)}`,
  ].flatMap((c) => ["-c", c]);
  const disabled = CODEX_DISABLED_FEATURES.flatMap((f) => ["--disable", f]);
  const common = ["--json", "--skip-git-repo-check", "--ignore-user-config", ...disabled, ...config];
  if (spec.conversation) return ["exec", "resume", ...common, "-c", 'sandbox_mode="read-only"', spec.conversation, "-"];
  return ["exec", ...common, "-s", "read-only", "-C", spec.workDir, "-"];
}

/** A TOML basic string. JSON's escapes are TOML's. */
function tomlString(value: string): string {
  return JSON.stringify(value);
}

/** What a turn came back as: the answer and the conversation to continue, or why there is none. */
export type TalkOutcome = { text: string; conversation: string | undefined } | { failure: TalkFailure; detail: string };
export type TalkFailure = "notInstalled" | "signedOut" | "failed" | "timeout";

const SIGNED_OUT = /not logged in|log ?in|login|sign(ed)? ?in|api key|authenticat|unauthori[sz]ed|\b401\b|credential/i;

/** Claude Code's `--output-format json` answer. */
export function claudeOutcome(stdout: string, stderr: string, code: number | null): TalkOutcome {
  const json = lastJsonObject(stdout);
  if (json && json["type"] === "result" && json["is_error"] !== true && typeof json["result"] === "string") {
    return { text: json["result"].trim(), conversation: typeof json["session_id"] === "string" ? json["session_id"] : undefined };
  }
  const detail = (typeof json?.["result"] === "string" ? json["result"] : "") || stderr.trim() || stdout.trim() || `claude exited with ${code}`;
  return { failure: SIGNED_OUT.test(detail) ? "signedOut" : "failed", detail };
}

/** Codex's `exec --json` events: the last agent message of the turn, and the thread it is in. */
export function codexOutcome(stdout: string, stderr: string, code: number | null): TalkOutcome {
  let thread: string | undefined;
  let text: string | undefined;
  let error: string | undefined;
  let completed = false;
  for (const line of stdout.split("\n")) {
    const event = parseObject(line);
    if (!event) continue;
    const item = event["item"] as Record<string, unknown> | undefined;
    if (event["type"] === "thread.started" && typeof event["thread_id"] === "string") thread = event["thread_id"];
    else if (event["type"] === "item.completed" && item?.["type"] === "agent_message" && typeof item["text"] === "string") text = item["text"];
    else if (event["type"] === "turn.completed") completed = true;
    else if (event["type"] === "turn.failed") error = messageOf(event["error"]) ?? "the turn failed";
    else if (event["type"] === "error") error = messageOf(event) ?? error;
  }
  if (completed && !error) return { text: (text ?? "").trim(), conversation: thread };
  const detail = error ?? (stderr.trim() || `codex exited with ${code}`);
  return { failure: SIGNED_OUT.test(detail) ? "signedOut" : "failed", detail };
}

function messageOf(value: unknown): string | undefined {
  return typeof value === "object" && value !== null && typeof (value as { message?: unknown }).message === "string" ? (value as { message: string }).message : undefined;
}

function parseObject(line: string): Record<string, unknown> | null {
  if (!line.trim().startsWith("{")) return null;
  try {
    const value: unknown = JSON.parse(line);
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** The whole of stdout as one JSON object, else its last line that is one. */
function lastJsonObject(stdout: string): Record<string, unknown> | null {
  const whole = parseObject(stdout.trim());
  if (whole) return whole;
  const lines = stdout.trim().split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const parsed = parseObject(lines[i]!);
    if (parsed) return parsed;
  }
  return null;
}

/** The sentence a `failed` row says, for the owner. `computer` is "Mac" or "computer". */
export function failureSentence(agentName: string, failure: TalkFailure, detail: string, computer = "Mac"): string {
  switch (failure) {
    case "notInstalled":
      return `${agentName} is not installed on this ${computer}. Install it, or choose another agent for Talk.`;
    case "signedOut":
      return `${agentName} is not signed in on this ${computer}. ${agentName === "Codex" ? "Run codex login" : "Run claude"} in a terminal to sign in.`;
    case "timeout":
      return `${agentName} took longer than 5 minutes and was stopped. Nothing more was done.`;
    case "failed": {
      const line = detail.replace(/\s+/g, " ").trim();
      return `${agentName} could not answer${line ? `: ${line.length > 200 ? `${line.slice(0, 199)}…` : line}` : "."}`;
    }
  }
}

/** The sentence a `failed` row says when no agent that can answer is installed. */
export function noAgentSentence(computer = "Mac"): string {
  return `No agent that can answer Talk is installed on this ${computer}. Install Claude Code or Codex.`;
}
