/**
 * What it takes for this computer to run each agent, for the Mac app's first run (`GET /agents` on the control API):
 * whether the agent's program is on the daemon's PATH (a session starts it from there), whether it is signed in, and
 * the commands that install it and sign it in, for the app to run in a terminal. Pure: `findAgentSetup.ts` looks.
 * The shell needs nothing, so it is not here. A new agent gets a check here as well as its entry in `agentCatalog.ts`.
 */
import type { PackageTool } from "../setup/requirements.js";

/** One agent as the control API reports it. */
export interface AgentSetup {
  kind: string;
  name: string;
  /** Its program is on the daemon's PATH, so a session can start it. */
  installed: boolean;
  /** What the agent says about its sign-in. Null when it is not installed or did not say. */
  signedIn: boolean | null;
  /** A command that installs it, for a terminal. */
  install: string;
  /** A command that signs it in, for a terminal. */
  signIn: string;
}

/** What the agent's status command printed (stdout and stderr together) and how it exited. Null code: it did not finish. */
export interface StatusResult {
  code: number | null;
  output: string;
}

export interface AgentCheck {
  kind: string;
  /** The program a session starts (`agentCommand`). */
  command: string;
  /** Asks the agent whether it is signed in, without changing anything. */
  statusArgs: string[];
  signedIn(result: StatusResult): boolean | null;
  install(tool: PackageTool | null): string;
  signIn: string;
}

/** `claude auth status --json`: `{"loggedIn": true, …}`, exit 1 when signed out. */
export function claudeSignedIn(result: StatusResult): boolean | null {
  const json = result.output.slice(result.output.indexOf("{"), result.output.lastIndexOf("}") + 1);
  try {
    const parsed: unknown = JSON.parse(json);
    if (typeof parsed === "object" && parsed !== null && "loggedIn" in parsed && typeof parsed.loggedIn === "boolean") return parsed.loggedIn;
  } catch {
    // Not JSON: an older Claude Code, or an error. Say nothing.
  }
  return null;
}

/** `codex login status`: "Logged in using ChatGPT" (or an API key), else "Not logged in". */
export function codexSignedIn(result: StatusResult): boolean | null {
  if (/not logged in/i.test(result.output)) return false;
  if (/logged in/i.test(result.output)) return true;
  return null;
}

export const AGENT_CHECKS: readonly AgentCheck[] = [
  {
    kind: "claude",
    command: "claude",
    statusArgs: ["auth", "status", "--json"],
    signedIn: claudeSignedIn,
    // Homebrew's bin is on the PATH the daemon was installed with; the native installer's ~/.local/bin may not be.
    install: (tool) => (tool === "brew" ? "brew install --cask claude-code" : "curl -fsSL https://claude.ai/install.sh | bash"),
    signIn: "claude auth login",
  },
  {
    kind: "codex",
    command: "codex",
    statusArgs: ["login", "status"],
    signedIn: codexSignedIn,
    install: (tool) => (tool === "brew" ? "brew install --cask codex" : "npm install -g @openai/codex"),
    signIn: "codex login",
  },
];

/** One agent's setup, from where its program was found (null: not on PATH) and what its status command said. */
export function agentSetup(check: AgentCheck, name: string, program: string | null, status: StatusResult | null, tool: PackageTool | null): AgentSetup {
  const installed = program !== null;
  return {
    kind: check.kind,
    name,
    installed,
    signedIn: installed && status ? check.signedIn(status) : null,
    install: check.install(tool),
    signIn: check.signIn,
  };
}
