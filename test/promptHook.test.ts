import { describe, expect, it } from "vitest";
import { closePromptsByHook, openPromptFromHook } from "../src/daemon/promptHook.js";
import { silentLogger } from "../src/log.js";
import { PromptStore } from "../src/prompts/promptStore.js";

const body = JSON.stringify({ hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command: "ls" } });

function setup(known = ["gr-a"]) {
  const prompts = new PromptStore({ newId: () => "p-1" });
  const applied: string[] = [];
  const replies: unknown[] = [];
  const deps = {
    prompts,
    applyHook: (id: string) => {
      applied.push(id);
      return known.includes(id);
    },
    log: silentLogger,
  };
  return { prompts, applied, replies, open: (session: string | undefined, raw: string) => openPromptFromHook(deps, session, raw, (r) => replies.push(r)) };
}

describe("openPromptFromHook", () => {
  it("opens a prompt for a known session and applies the hook", () => {
    const { prompts, applied, replies, open } = setup();
    expect(open("gr-a", body)).toMatchObject({ type: "prompt", sessionId: "gr-a", promptId: "p-1", kind: "permission", tool: "Bash", detail: "ls" });
    expect(applied).toEqual(["gr-a"]);
    expect(replies).toEqual([]); // held
    expect(prompts.list()).toHaveLength(1);
  });

  it("leaves a Claude Code that Grenade did not start alone", () => {
    const { prompts, applied, open } = setup();
    expect(open(undefined, body)).toBeNull();
    expect(applied).toEqual([]);
    expect(prompts.list()).toEqual([]);
  });

  it("opens nothing for an unknown session, a body that is not JSON, or another event", () => {
    const { prompts, open } = setup();
    expect(open("gr-nope", body)).toBeNull();
    expect(open("gr-a", "{not json")).toBeNull();
    expect(open("gr-a", JSON.stringify({ hook_event_name: "Stop" }))).toBeNull();
    expect(prompts.list()).toEqual([]);
  });
});

describe("closePromptsByHook", () => {
  it("closes the prompt of the tool that ran", () => {
    const { prompts, replies, open } = setup();
    open("gr-a", body);
    closePromptsByHook(prompts, "gr-a", JSON.stringify({ hook_event_name: "PostToolUse", tool_name: "Bash" }));
    expect(prompts.list()).toEqual([]);
    expect(replies).toEqual([null]);
  });

  it("ignores hooks without a session and bodies that are not JSON", () => {
    const { prompts, open } = setup();
    open("gr-a", body);
    closePromptsByHook(prompts, null, JSON.stringify({ hook_event_name: "Stop" }));
    closePromptsByHook(prompts, "gr-a", "{nope");
    closePromptsByHook(prompts, "gr-a", JSON.stringify({ tool_name: "Bash" }));
    expect(prompts.list()).toHaveLength(1);
  });
});
