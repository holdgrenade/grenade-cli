import { describe, expect, it } from "vitest";
import { HOOK_EVENTS, PROMPT_EVENT, hookCommand, mergeHooks, promptHook, removeHooks } from "../src/hooks/installHooks.js";

describe("mergeHooks", () => {
  it("adds every event to empty settings", () => {
    const { settings, changed } = mergeHooks({}, 7788);
    expect(changed).toBe(true);
    for (const e of HOOK_EVENTS) {
      expect(settings.hooks?.[e]).toEqual([{ matcher: "", hooks: [{ type: "command", command: hookCommand(7788) }] }]);
    }
  });

  it("keeps existing hooks and is idempotent", () => {
    const existing = {
      permissions: { allow: ["Bash(npm test)"] },
      hooks: { Stop: [{ matcher: "", hooks: [{ type: "command", command: "say done" }] }] },
    };
    const first = mergeHooks(existing, 7788);
    expect(first.settings.permissions).toEqual(existing.permissions);
    expect(first.settings.hooks?.Stop).toHaveLength(2);
    expect(first.settings.hooks?.Stop?.[0]).toEqual(existing.hooks.Stop[0]);
    const second = mergeHooks(first.settings, 7788);
    expect(second.changed).toBe(false);
    expect(second.settings).toEqual(first.settings);
  });

  it("updates the port of an existing grenade hook in place", () => {
    const { settings } = mergeHooks({}, 7788);
    const moved = mergeHooks(settings, 7799);
    expect(moved.changed).toBe(true);
    expect(moved.settings.hooks?.Stop?.[0]?.hooks?.[0]?.command).toBe(hookCommand(7799));
    expect(moved.settings.hooks?.Stop).toHaveLength(1);
  });

  it("does not mutate its input", () => {
    const input = { hooks: {} };
    mergeHooks(input, 7788);
    expect(input).toEqual({ hooks: {} });
  });
});

describe("removeHooks", () => {
  it("removes only grenade hooks", () => {
    const { settings } = mergeHooks({ hooks: { Stop: [{ matcher: "", hooks: [{ type: "command", command: "say done" }] }] } }, 7788);
    const { settings: out, changed } = removeHooks(settings);
    expect(changed).toBe(true);
    expect(out.hooks?.Stop).toEqual([{ matcher: "", hooks: [{ type: "command", command: "say done" }] }]);
    expect(out.hooks?.Notification).toEqual([]);
  });
});

describe("the prompt hook", () => {
  it("is an HTTP hook that Claude Code holds open, with the session in a header", () => {
    expect(promptHook(7788)).toEqual({
      type: "http",
      url: "http://127.0.0.1:7788/hooks/claude/prompt",
      timeout: 43200,
      headers: { "X-Grenade-Session": "$GRENADE_SESSION" },
      allowedEnvVars: ["GRENADE_SESSION"],
    });
  });

  it("is added for PermissionRequest, once, and follows the port", () => {
    const first = mergeHooks({}, 7788);
    expect(first.settings.hooks?.[PROMPT_EVENT]).toEqual([{ matcher: "", hooks: [promptHook(7788)] }]);
    expect(mergeHooks(first.settings, 7788).changed).toBe(false);
    const moved = mergeHooks(first.settings, 7799);
    expect(moved.changed).toBe(true);
    expect(moved.settings.hooks?.[PROMPT_EVENT]).toEqual([{ matcher: "", hooks: [promptHook(7799)] }]);
  });

  it("is added to settings that only have the command hooks, and leaves a user's own PermissionRequest hook alone", () => {
    const old = mergeHooks({}, 7788).settings;
    delete old.hooks?.[PROMPT_EVENT];
    const own = { matcher: "Bash", hooks: [{ type: "command", command: "say asking" }] };
    old.hooks![PROMPT_EVENT] = [own];
    const { settings, changed } = mergeHooks(old, 7788);
    expect(changed).toBe(true);
    expect(settings.hooks?.[PROMPT_EVENT]).toEqual([own, { matcher: "", hooks: [promptHook(7788)] }]);
  });

  it("is taken out by removeHooks", () => {
    const { settings } = mergeHooks({ hooks: { [PROMPT_EVENT]: [{ matcher: "Bash", hooks: [{ type: "command", command: "say asking" }] }] } }, 7788);
    const { settings: out } = removeHooks(settings);
    expect(out.hooks?.[PROMPT_EVENT]).toEqual([{ matcher: "Bash", hooks: [{ type: "command", command: "say asking" }] }]);
  });
});
