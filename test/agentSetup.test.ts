import { describe, expect, it } from "vitest";
import { AGENT_CHECKS, agentSetup, claudeSignedIn, codexSignedIn } from "../src/agents/agentSetup.js";
import { AGENTS } from "../src/agents/agentCatalog.js";

const check = (kind: string) => {
  const found = AGENT_CHECKS.find((c) => c.kind === kind);
  if (!found) throw new Error(`no check for ${kind}`);
  return found;
};

describe("claudeSignedIn", () => {
  it("reads loggedIn from `claude auth status --json`", () => {
    expect(claudeSignedIn({ code: 0, output: '{\n  "loggedIn": true,\n  "authMethod": "claude.ai"\n}\n' })).toBe(true);
    expect(claudeSignedIn({ code: 1, output: '{"loggedIn": false, "authMethod": "none"}\n' })).toBe(false);
  });

  it("says nothing for an answer that is not that JSON", () => {
    expect(claudeSignedIn({ code: 1, output: "error: unknown command 'auth'" })).toBeNull();
    expect(claudeSignedIn({ code: null, output: "" })).toBeNull();
    expect(claudeSignedIn({ code: 0, output: '{"loggedIn": "yes"}' })).toBeNull();
  });
});

describe("codexSignedIn", () => {
  it("reads `codex login status`", () => {
    expect(codexSignedIn({ code: 0, output: "Logged in using ChatGPT\n" })).toBe(true);
    expect(codexSignedIn({ code: 0, output: "\nLogged in using an API key - sk-…\n" })).toBe(true);
    expect(codexSignedIn({ code: 1, output: "Not logged in\n" })).toBe(false);
  });

  it("says nothing for an error", () => {
    expect(codexSignedIn({ code: 1, output: "Error loading configuration: CODEX_HOME points to …" })).toBeNull();
  });
});

describe("agentSetup", () => {
  it("is not signed in until it is installed", () => {
    const setup = agentSetup(check("claude"), "Claude Code", null, null, "brew");
    expect(setup).toEqual({
      kind: "claude",
      name: "Claude Code",
      installed: false,
      signedIn: null,
      install: "brew install --cask claude-code",
      signIn: "claude auth login",
    });
  });

  it("asks the agent once it is on PATH", () => {
    const setup = agentSetup(check("codex"), "Codex", "/opt/homebrew/bin/codex", { code: 1, output: "Not logged in" }, "brew");
    expect(setup.installed).toBe(true);
    expect(setup.signedIn).toBe(false);
    expect(setup.signIn).toBe("codex login");
  });

  it("installs without Homebrew too", () => {
    expect(check("claude").install(null)).toBe("curl -fsSL https://claude.ai/install.sh | bash");
    expect(check("codex").install("pacman")).toBe("npm install -g @openai/codex");
    expect(check("codex").install("brew")).toBe("brew install --cask codex");
  });

  it("checks every agent the daemon starts but the shell", () => {
    const needing = AGENTS.filter((a) => a.kind !== "shell").map((a) => a.kind);
    expect(AGENT_CHECKS.map((c) => c.kind)).toEqual(needing);
  });
});
