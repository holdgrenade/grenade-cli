/** How each agent runs a Talk turn, how its answer is read, and the sentences a failure becomes. */
import { describe, expect, it } from "vitest";
import { CODEX_DISABLED_FEATURES, claudeOutcome, claudeTalkArgs, codexOutcome, codexTalkArgs, failureSentence, noAgentSentence, type TalkTurnSpec } from "../src/talk/talkAgents.js";

const spec: TalkTurnSpec = {
  conversation: undefined,
  newConversation: "37ef535d-5b97-4dd4-92bc-2e4ef94eaff5",
  mcp: { command: "/usr/local/bin/node", args: ["/opt/grenade/dist/cli.js", "talk-mcp"] },
  instructions: 'You are "Talk".\nBe brief.',
  workDir: "/Users/x/.grenade/talk/work",
};

/** The value after a flag. */
const after = (args: string[], flag: string) => args[args.indexOf(flag) + 1];

describe("talkAgents", () => {
  it("runs Claude Code with Grenade's tools only, a new conversation first and the same one after", () => {
    const args = claudeTalkArgs(spec);
    expect(args.slice(0, 3)).toEqual(["-p", "--output-format", "json"]);
    expect(after(args, "--tools")).toBe("");
    expect(args).toContain("--strict-mcp-config");
    expect(after(args, "--setting-sources")).toBe("");
    expect(after(args, "--allowedTools")).toBe("mcp__grenade");
    expect(JSON.parse(after(args, "--mcp-config")!)).toEqual({ mcpServers: { grenade: { command: "/usr/local/bin/node", args: ["/opt/grenade/dist/cli.js", "talk-mcp"] } } });
    expect(after(args, "--append-system-prompt")).toBe(spec.instructions);
    expect(args.slice(-2)).toEqual(["--session-id", spec.newConversation]);
    expect(claudeTalkArgs({ ...spec, conversation: "abc" }).slice(-2)).toEqual(["--resume", "abc"]);
    // Nothing in the arguments is secret: the turn's secret travels in the environment.
    expect(args.join(" ")).not.toContain("SECRET=");
  });

  it("runs Codex read-only with no tools but Grenade's, approved, and resumes its thread", () => {
    const args = codexTalkArgs(spec);
    expect(args.slice(0, 2)).toEqual(["exec", "--json"]);
    expect(args).toContain("--skip-git-repo-check");
    expect(args).toContain("--ignore-user-config");
    expect(after(args, "-s")).toBe("read-only");
    expect(after(args, "-C")).toBe(spec.workDir);
    for (const feature of CODEX_DISABLED_FEATURES) expect(args.join(" ")).toContain(`--disable ${feature}`);
    expect(args).toContain('mcp_servers.grenade.command="/usr/local/bin/node"');
    expect(args).toContain('mcp_servers.grenade.args=["/opt/grenade/dist/cli.js", "talk-mcp"]');
    expect(args).toContain('mcp_servers.grenade.env_vars=["GRENADE_TALK_PORT", "GRENADE_TALK_TURN", "GRENADE_TALK_SECRET"]');
    expect(args).toContain('mcp_servers.grenade.default_tools_approval_mode="approve"');
    expect(args).toContain(`developer_instructions=${JSON.stringify(spec.instructions)}`);
    expect(args.at(-1)).toBe("-");
    const resumed = codexTalkArgs({ ...spec, conversation: "01a10f1a-a49e" });
    expect(resumed.slice(0, 3)).toEqual(["exec", "resume", "--json"]);
    expect(resumed).toContain('sandbox_mode="read-only"');
    expect(resumed.slice(-2)).toEqual(["01a10f1a-a49e", "-"]);
    expect(resumed).not.toContain("-C");
  });

  it("reads Claude Code's answer and its failures", () => {
    const answered = JSON.stringify({ type: "result", subtype: "success", is_error: false, result: " Sent it. \n", session_id: "s-1" });
    expect(claudeOutcome(answered, "", 0)).toEqual({ text: "Sent it.", conversation: "s-1" });
    const signedOut = JSON.stringify({ type: "result", is_error: true, result: "Invalid API key · Please run /login" });
    expect(claudeOutcome(signedOut, "", 1)).toMatchObject({ failure: "signedOut" });
    expect(claudeOutcome("", "Error: something broke", 1)).toEqual({ failure: "failed", detail: "Error: something broke" });
  });

  it("reads Codex's last message and thread, and its failures", () => {
    const events = [
      { type: "thread.started", thread_id: "01a10f1a" },
      { type: "turn.started" },
      { type: "item.completed", item: { id: "item_0", type: "agent_message", text: "I'll look." } },
      { type: "item.completed", item: { id: "item_1", type: "mcp_tool_call", server: "grenade", tool: "list_sessions", status: "completed" } },
      { type: "item.completed", item: { id: "item_2", type: "agent_message", text: "Login rate limit is idle." } },
      { type: "turn.completed", usage: {} },
    ];
    const jsonl = `${events.map((e) => JSON.stringify(e)).join("\n")}\n`;
    expect(codexOutcome(jsonl, "Reading additional input from stdin...", 0)).toEqual({ text: "Login rate limit is idle.", conversation: "01a10f1a" });
    const failed = `${JSON.stringify({ type: "thread.started", thread_id: "x" })}\n${JSON.stringify({ type: "turn.failed", error: { message: "401 Unauthorized" } })}\n`;
    expect(codexOutcome(failed, "", 1)).toEqual({ failure: "signedOut", detail: "401 Unauthorized" });
    expect(codexOutcome("", "boom", 1)).toEqual({ failure: "failed", detail: "boom" });
  });

  it("says each failure in a sentence for the owner", () => {
    expect(failureSentence("Claude Code", "signedOut", "", "Mac")).toBe("Claude Code is not signed in on this Mac. Run claude in a terminal to sign in.");
    expect(failureSentence("Codex", "signedOut", "", "computer")).toBe("Codex is not signed in on this computer. Run codex login in a terminal to sign in.");
    expect(failureSentence("Codex", "notInstalled", "")).toContain("not installed");
    expect(failureSentence("Codex", "timeout", "")).toContain("longer than 5 minutes");
    expect(failureSentence("Claude Code", "failed", `a\n${"b".repeat(400)}`)).toHaveLength("Claude Code could not answer: ".length + 200);
    expect(noAgentSentence("Mac")).toBe("No agent that can answer Talk is installed on this Mac. Install Claude Code or Codex.");
  });
});
