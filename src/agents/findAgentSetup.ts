/** Looks at this computer for what `agentSetup.ts` reports: each agent's program on PATH, and its own sign-in status. */
import { execFile } from "node:child_process";
import { findOnPath } from "../platform/findOnPath.js";
import { packageTool } from "../setup/findRequirements.js";
import { agentInfo } from "./agentCatalog.js";
import { AGENT_CHECKS, agentSetup, type AgentCheck, type AgentSetup, type StatusResult } from "./agentSetup.js";

/** A status command that takes longer than this says nothing. */
const STATUS_TIMEOUT_MS = 8000;

let looking: Promise<AgentSetup[]> | null = null;

/** Every agent's setup. Calls that come while a look is under way share it: the Mac app asks every few seconds. */
export function findAgentSetup(): Promise<AgentSetup[]> {
  looking ??= look().finally(() => {
    looking = null;
  });
  return looking;
}

async function look(): Promise<AgentSetup[]> {
  const tool = packageTool(process.platform);
  return Promise.all(
    AGENT_CHECKS.map(async (check) => {
      const program = programOf(check);
      const status = program ? await runStatus(program, check.statusArgs) : null;
      return agentSetup(check, agentInfo(check.kind)?.name ?? check.kind, program, status, tool);
    }),
  );
}

/** Where a session would find the agent: on PATH, or `CLAUDE_BIN` for Claude Code. */
function programOf(check: AgentCheck): string | null {
  const fromEnv = check.kind === "claude" ? process.env["CLAUDE_BIN"] : undefined;
  return fromEnv || findOnPath(check.command);
}

function runStatus(program: string, args: string[]): Promise<StatusResult> {
  // Never as a session: a hook it fired would report to the daemon.
  const env = { ...process.env };
  delete env["GRENADE_SESSION"];
  return new Promise((resolve) => {
    execFile(program, args, { timeout: STATUS_TIMEOUT_MS, env, encoding: "utf8" }, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === "number" ? error.code : null) : 0;
      resolve({ code: error?.killed ? null : code, output: `${stdout}\n${stderr}` });
    });
  });
}
