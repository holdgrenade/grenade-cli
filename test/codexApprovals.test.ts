import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import type { AgentKind, KeyName, PromptClosedFrame, PromptFrame } from "@grenade/protocol";
import { silentLogger } from "../src/log.js";
import { CodexApprovals, approvalsClosedByCodexHook, codexApprovalIn } from "../src/prompts/codexApprovals.js";
import { PromptStore } from "../src/prompts/promptStore.js";

/** As Codex 0.160 drew them, 2026-11-09. */
const commandScreen = [
  "• Running echo hello > b.txt",
  "  Would you like to run the following command?",
  "  Environment: local",
  "  Reason: May I run `echo hello > b.txt` to create the requested file?",
  "  $ echo hello > b.txt",
  "› 1. Yes, proceed (y)",
  "  2. Yes, and don't ask again for commands that start with `echo hello > b.txt` (p)",
  "  3. No, and tell Codex what to do differently (esc)",
  "  Press enter to confirm or esc to cancel",
];
const patchScreen = [
  "  Would you like to make the following edits?",
  "  Description: Apply proposed file edits",
  "  Destination: /Users/me/code/api/a.txt",
  "› 1. Yes, proceed (y)",
  "  2. Yes, and don't ask again for these files (a)",
  "  3. No, and tell Codex what to do differently (esc)",
  "  Press enter to confirm or esc to cancel",
];
const runningScreen = ["• Running echo hello > b.txt", "• Working (9s • esc to interrupt) · Running hook", "› Ask Codex to do anything", "  GPT-6-Luna default · ~/code/api"];
const interruptedScreen = ["■ Conversation interrupted - use /feedback if something went wrong", "› Ask Codex to do anything", "  GPT-6-Luna default · ~/code/api"];

const bashPayload = {
  hook_event_name: "PermissionRequest",
  session_id: "01a1c1b2",
  cwd: "/Users/me/code/api",
  model: "gpt-6-luna",
  permission_mode: "default",
  tool_name: "Bash",
  tool_input: { command: "echo hello > b.txt", description: "May I run `echo hello > b.txt` to create the requested file?" },
};
const patchPayload = { ...bashPayload, tool_name: "apply_patch", tool_input: { command: "*** Begin Patch\n*** Update File: /Users/me/code/api/a.txt\n@@\n-hi\n+goodbye\n*** End Patch" } };

class FakeRegistry extends EventEmitter {
  screens = new Map<string, string[]>();
  keys: KeyName[] = [];
  texts: string[] = [];
  hooks: string[] = [];
  screenOf(id: string) {
    const lines = this.screens.get(id);
    return lines ? { lines } : undefined;
  }
  async sendKey(_id: string, key: KeyName) {
    this.keys.push(key);
  }
  async sendText(_id: string, text: string, submit: boolean) {
    this.texts.push(`${text}${submit ? "⏎" : ""}`);
  }
  applyHook(_id: string, status: string) {
    this.hooks.push(status);
    return true;
  }
  show(id: string, lines: string[]) {
    this.screens.set(id, lines);
    this.emit("captured", id, "codex" as AgentKind, lines);
  }
}

function setup() {
  let now = 1_000_000;
  const registry = new FakeRegistry();
  const prompts = new PromptStore({ now: () => now });
  const opened: PromptFrame[] = [];
  const closed: PromptClosedFrame[] = [];
  prompts.on("opened", (f) => opened.push(f));
  prompts.on("closed", (f) => closed.push(f));
  const approvals = new CodexApprovals(registry, prompts, silentLogger, () => now);
  return { registry, prompts, approvals, opened, closed, tick: (ms: number) => (now += ms) };
}

describe("codexApprovalIn", () => {
  it("reads a command's and a patch's approval, with Enter on Yes, proceed", () => {
    expect(codexApprovalIn(commandScreen)).toEqual({ allow: ["enter"] });
    expect(codexApprovalIn(patchScreen)).toEqual({ allow: ["enter"] });
    expect(codexApprovalIn(runningScreen)).toBeNull();
  });

  it("walks to Yes, proceed when another row is selected", () => {
    const moved = commandScreen.map((l) => l.replace("› 1.", "  1.").replace("  3. No", "› 3. No"));
    expect(codexApprovalIn(moved)).toEqual({ allow: ["up", "up", "enter"] });
  });
});

describe("approvalsClosedByCodexHook", () => {
  it("closes on a turn's end, a new prompt and the tool's own result", () => {
    expect(["UserPromptSubmit", "Stop", "Interrupt", "SessionEnd"].map(approvalsClosedByCodexHook)).toEqual(["all", "all", "all", "all"]);
    expect(approvalsClosedByCodexHook("PostToolUse")).toBe("tool");
    expect(approvalsClosedByCodexHook("PreToolUse")).toBeNull();
  });
});

describe("CodexApprovals", () => {
  it("opens a permission card from the hook, before Codex draws the dialog", () => {
    const { approvals, opened } = setup();
    approvals.requested("gr-a", bashPayload);
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatchObject({ sessionId: "gr-a", kind: "permission", tool: "Bash", detail: "echo hello > b.txt", note: bashPayload.tool_input.description });
  });

  it("shows a patch's text as the detail", () => {
    const { approvals, opened } = setup();
    approvals.requested("gr-a", patchPayload);
    expect(opened[0]).toMatchObject({ tool: "apply_patch", detail: patchPayload.tool_input.command });
  });

  it("allows with Enter once the screen shows the dialog, and the session works again", () => {
    const { registry, prompts, approvals, opened, closed } = setup();
    registry.show("gr-a", runningScreen);
    approvals.requested("gr-a", bashPayload);
    expect(prompts.answer("gr-a", opened[0]!.promptId, { allow: true })).toBe("answered");
    expect(registry.keys).toEqual([]);
    expect(registry.hooks).toEqual(["working"]);
    registry.show("gr-a", commandScreen);
    expect(registry.keys).toEqual(["enter"]);
    expect(closed.map((c) => c.reason)).toEqual(["answered"]);
    registry.show("gr-a", commandScreen);
    expect(registry.keys).toEqual(["enter"]);
  });

  it("says no with Escape, then sends what to do instead once Codex waits for a prompt", () => {
    const { registry, prompts, approvals, opened } = setup();
    registry.show("gr-a", commandScreen);
    approvals.requested("gr-a", bashPayload);
    prompts.answer("gr-a", opened[0]!.promptId, { allow: false, feedback: "Use printf instead." });
    expect(registry.keys).toEqual(["escape"]);
    expect(registry.texts).toEqual([]);
    expect(registry.hooks).toEqual([]);
    registry.show("gr-a", commandScreen);
    expect(registry.texts).toEqual([]);
    registry.show("gr-a", interruptedScreen);
    expect(registry.texts).toEqual(["Use printf instead.⏎"]);
  });

  it("closes the card when the dialog is answered in the terminal", () => {
    const { registry, approvals, closed } = setup();
    approvals.requested("gr-a", bashPayload);
    registry.show("gr-a", runningScreen);
    expect(closed).toEqual([]);
    registry.show("gr-a", commandScreen);
    registry.show("gr-a", runningScreen);
    expect(closed.map((c) => c.reason)).toEqual(["elsewhere"]);
  });

  it("closes the card on a later hook: the tool's own result, or the turn's end", () => {
    const { approvals, closed } = setup();
    approvals.requested("gr-a", bashPayload);
    approvals.hook("gr-a", "PostToolUse", "apply_patch");
    expect(closed).toEqual([]);
    approvals.hook("gr-a", "PostToolUse", "Bash");
    expect(closed).toHaveLength(1);
    approvals.requested("gr-b", bashPayload);
    approvals.hook("gr-b", "Interrupt", undefined);
    expect(closed).toHaveLength(2);
  });

  it("closes an older card when Codex asks the next thing", () => {
    const { approvals, opened, closed } = setup();
    approvals.requested("gr-a", bashPayload);
    approvals.requested("gr-a", patchPayload);
    expect(opened).toHaveLength(2);
    expect(closed.map((c) => c.promptId)).toEqual([opened[0]!.promptId]);
  });

  it("gives up on an answer whose dialog never shows", () => {
    const { registry, prompts, approvals, opened, tick } = setup();
    approvals.requested("gr-a", bashPayload);
    prompts.answer("gr-a", opened[0]!.promptId, { allow: true });
    tick(11_000);
    registry.show("gr-a", commandScreen);
    expect(registry.keys).toEqual([]);
  });

  it("makes no card of a payload it cannot show", () => {
    const { approvals, opened } = setup();
    approvals.requested("gr-a", { hook_event_name: "PermissionRequest" });
    expect(opened).toEqual([]);
  });
});
