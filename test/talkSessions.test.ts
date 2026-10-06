/** The sessions as the agent reads them, the projects it may start one in, and when an agent's screen takes a prompt. */
import { describe, expect, it } from "vitest";
import type { Session } from "@grenade/protocol";
import { asksTrust, hasPromptBox, readiness, TRUST_NOTE, ENDED_NOTE, DIALOG_NOTE } from "../src/talk/agentReady.js";
import { agentForNewSession, checkNewSession, knownProjects, matchProject, projectNames, sessionNameFor } from "../src/talk/talkProjects.js";
import { clipped, handleOf, recentEntries, resolveSession, sendable, sessionRow, MAX_SEND_CHARACTERS } from "../src/talk/talkSessions.js";

const session = (id: string, o: Partial<Session> = {}): Session => ({
  id,
  name: id.slice(3),
  agent: "claude",
  cwd: "/Users/x/code/grenade-relay",
  status: "idle",
  statusSince: "2026-10-05T09:00:00.000Z",
  lastLine: "",
  createdAt: "2026-10-05T08:00:00.000Z",
  ...o,
});

describe("talkSessions", () => {
  it("lists a session by handle, heading and folder name, never a path", () => {
    const row = sessionRow(session("gr-relay", { title: "Relay version bump", status: "waiting", waitingFor: "answer", summary: "Bumping." }), "Claude Code", "permission", Date.parse("2026-10-05T09:01:00.000Z"));
    expect(row).toEqual({ handle: "relay", title: "Relay version bump", folder: "grenade-relay", agent: "Claude Code", status: "waiting", status_for_seconds: 60, waiting_for: "answer", summary: "Bumping.", asking: "permission" });
    expect(JSON.stringify(row)).not.toContain("/Users");
    expect(handleOf("gr-api")).toBe("api");
  });

  it("finds a session by handle, else by id, name or title when only one fits", () => {
    const sessions = [session("gr-api", { title: "Login rate limit" }), session("gr-web", { title: "Login page" })];
    expect(resolveSession("API", sessions)?.id).toBe("gr-api");
    expect(resolveSession("login rate limit", sessions)?.id).toBe("gr-api");
    expect(resolveSession("gr-web", sessions)?.id).toBe("gr-web");
    expect(resolveSession("nope", sessions)).toBeUndefined();
    expect(resolveSession("  ", sessions)).toBeUndefined();
  });

  it("sends one capped line, and cuts long words in the middle", () => {
    expect(sendable("  first\nsecond\r\nthird ")).toBe("first second third");
    expect(sendable("\n \n")).toBeNull();
    expect(sendable("x".repeat(2000))).toHaveLength(MAX_SEND_CHARACTERS);
    const long = `${"a".repeat(1000)}${"b".repeat(1000)}`;
    expect(clipped(long)).toBe(`${"a".repeat(500)} […] ${"b".repeat(1000)}`);
    const entries = [
      { kind: "asked" as const, text: "q1", at: "2026-10-05T09:00:00.000Z" },
      { kind: "stopped" as const, text: "Stopped", at: "2026-10-05T09:00:01.000Z" },
      { kind: "said" as const, text: "a1", at: "2026-10-05T09:00:30.000Z" },
    ];
    expect(recentEntries(entries, 99, Date.parse("2026-10-05T09:01:00.000Z"))).toEqual([
      { who: "owner", seconds_ago: 60, text: "q1" },
      { who: "agent", seconds_ago: 30, text: "a1" },
    ]);
    expect(recentEntries(entries, 0, 0)).toHaveLength(1);
  });
});

describe("talkProjects", () => {
  it("knows the folders in use, newest first, without home", () => {
    const projects = knownProjects(["/Users/x/code/relay/", "/Users/x", "/Users/x/code/relay", "/Users/x/web/relay", "/Users/x/code/site", "/"], "/Users/x");
    expect(projects).toEqual([
      { path: "/Users/x/code/relay", name: "relay" },
      { path: "/Users/x/web/relay", name: "relay" },
      { path: "/Users/x/code/site", name: "site" },
    ]);
    expect(projectNames(projects)).toEqual(["relay", "site"]);
    expect(matchProject(" SITE ", projects)).toEqual({ one: { path: "/Users/x/code/site", name: "site" } });
    expect(matchProject("relay", projects)).toMatchObject({ several: [{}, {}] });
    expect(matchProject("shop", projects)).toEqual({ none: true });
    for (const path of ["~/code/site", "/etc", "../x", "a\\b"]) expect(matchProject(path, projects)).toEqual({ path: true });
  });

  it("checks what create_session takes, and names the session by its title", () => {
    expect(checkNewSession({ title: "Changelog page", purpose: "Write it.", project_context: "site", initial_prompt: "write\nthe page" }, sendable)).toEqual({ title: "Changelog page", purpose: "Write it.", project: "site", firstPrompt: "write the page" });
    expect(checkNewSession({ purpose: "x", project_context: "site" }, sendable)).toEqual({ problem: "create_session needs a title." });
    expect(checkNewSession({ title: "x".repeat(61), purpose: "x", project_context: "site" }, sendable)).toMatchObject({ problem: expect.stringContaining("longer than 60") });
    expect(checkNewSession({ title: "x", purpose: "x" }, sendable)).toEqual({ problem: "create_session needs a project_context." });
    expect(sessionNameFor("Changelog page!", new Set())).toBe("changelog-page");
    expect(sessionNameFor("Changelog page", new Set(["gr-changelog-page", "gr-changelog-page-2"]))).toBe("changelog-page-3");
  });

  it("starts a coding agent, never a shell", () => {
    expect(agentForNewSession("codex", ["claude", "codex"])).toBe("codex");
    expect(agentForNewSession("shell", ["claude", "codex"])).toBe("claude");
    expect(agentForNewSession(undefined, ["codex"])).toBe("codex");
    expect(agentForNewSession(undefined, [])).toBeNull();
  });
});

describe("agentReady", () => {
  const promptBox = ["╭─ Claude Code", "", "──────────────────", "❯ ", "──────────────────", "  ? for shortcuts"];
  const trust = ["Accessing workspace:", "", " /Users/x/code/site", "", "❯ 1. Yes, I trust this folder", "  2. No, exit"];

  it("sends to Claude Code at its prompt box, holds at the trust dialog, waits while it starts", () => {
    expect(hasPromptBox(promptBox)).toBe(true);
    expect(asksTrust(trust)).toBe(true);
    expect(hasPromptBox(trust)).toBe(false);
    expect(readiness("claude", promptBox, true)).toBe("send");
    expect(readiness("claude", trust, true)).toEqual({ hold: TRUST_NOTE });
    expect(readiness("claude", ["Loading…"], true)).toBe("wait");
    expect(readiness("claude", undefined, true)).toBe("wait");
    expect(readiness("claude", promptBox, false)).toEqual({ hold: ENDED_NOTE });
  });

  it("holds Codex at a dialog of its own and sends at its composer", () => {
    const hooks = ["  Hooks need review", "  7 hooks are new or changed.", "› 1. Trust all and continue", "  2. Continue without trusting"];
    expect(readiness("codex", hooks, true)).toEqual({ hold: DIALOG_NOTE });
    expect(readiness("codex", ["╭──────╮", "│ >_ OpenAI Codex │", "", "› Ask Codex to do anything", "", "  ? for shortcuts"], true)).toBe("send");
    expect(readiness("codex", ["Starting…"], true)).toBe("wait");
  });
});
