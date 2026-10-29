import { describe, expect, it } from "vitest";
import type { ActivityEntry, Session } from "@grenade/protocol";
import { EndedSessions, PromptHeldError, type EndedSessionsDeps } from "../src/sessions/endedSessions.js";
import { FIRST_PROMPT_WAIT_MS } from "../src/talk/agentReady.js";

const PROMPT_BOX = ["╭───", "─────────────", "❯ ", "─────────────"];
const TRUST = ["Do you trust the files in this folder?", "❯ 1. Yes, proceed", "  2. No, exit"];

const ended = (over: Partial<Session> = {}): Session => ({
  id: "gr-app",
  name: "app",
  agent: "claude",
  cwd: "/Users/me/app/web",
  status: "gone",
  statusSince: "2026-10-29T09:42:00.000Z",
  lastLine: "",
  createdAt: "2026-10-29T09:00:00.000Z",
  ...over,
});

function make(o: { session?: Session; transcript?: string; conversation?: { agent: string; path: string; cwd: string } | null; history?: ActivityEntry[]; onSleep?: (sleeps: number) => readonly string[] | undefined } = {}) {
  const calls: string[] = [];
  let session = o.session ?? ended();
  let screen: readonly string[] | undefined;
  let now = 0;
  const deps: EndedSessionsDeps = {
    get: () => session,
    transcriptOf: () => o.transcript,
    async restart(id, opts) {
      calls.push(`restart:${id}:${opts.cwd}:${opts.resume ?? "-"}`);
      session = { ...session, status: "idle", ...(opts.resume ? { resumedFrom: opts.resume } : {}) };
      return session;
    },
    setTranscript: (id, path) => calls.push(`transcript:${id}:${path}`),
    async findConversation(id) {
      calls.push(`find:${id}`);
      return o.conversation === undefined ? null : o.conversation;
    },
    async previewConversation() { return o.history ?? null; },
    replaceActivity: (id, entries) => calls.push(`activity:${id}:${entries.length}`),
    resumes: (agent) => agent === "claude" || agent === "codex",
    screenLines: () => screen,
    now: () => now,
    async sleep(ms) {
      now += ms;
      calls.push("sleep");
      screen = o.onSleep?.(calls.filter((c) => c === "sleep").length) ?? screen;
    },
  };
  return { ended: new EndedSessions(deps), calls, show: (lines: readonly string[]) => { screen = lines; }, end: () => { session = { ...session, status: "gone" }; } };
}

const asked: ActivityEntry = { kind: "asked", text: "Fix the clash", at: "2026-10-29T09:10:00.000Z" };

describe("EndedSessions.resume", () => {
  it("resumes a copy of the session's own conversation in the folder it was started in, and shows its history", async () => {
    const { ended: e, calls } = make({
      transcript: "/Users/me/.claude/projects/-Users-me-app/9a76de47.jsonl",
      conversation: { agent: "claude", path: "/Users/me/.claude/projects/-Users-me-app/9a76de47.jsonl", cwd: "/Users/me/app" },
      history: [asked],
    });
    await e.resume("gr-app");
    expect(calls).toEqual([
      "find:9a76de47",
      "restart:gr-app:/Users/me/app:9a76de47",
      "transcript:gr-app:/Users/me/.claude/projects/-Users-me-app/9a76de47.jsonl",
      "activity:gr-app:1",
    ]);
  });

  it("starts the agent fresh in its last folder when it has no conversation, or the conversation is gone", async () => {
    const none = make();
    await none.ended.resume("gr-app");
    expect(none.calls).toEqual(["restart:gr-app:/Users/me/app/web:-"]);
    const deleted = make({ transcript: "/Users/me/.claude/projects/-Users-me-app/9a76de47.jsonl", conversation: null });
    await deleted.ended.resume("gr-app");
    expect(deleted.calls).toEqual(["find:9a76de47", "restart:gr-app:/Users/me/app/web:-"]);
  });

  it("starts a shell fresh, and never resumes another agent's conversation", async () => {
    const shell = make({ session: ended({ agent: "shell" }), transcript: "/x/9a76de47.jsonl", conversation: { agent: "claude", path: "/x/9a76de47.jsonl", cwd: "/x" } });
    await shell.ended.resume("gr-app");
    expect(shell.calls).toEqual(["restart:gr-app:/Users/me/app/web:-"]);
    const codex = make({ session: ended({ agent: "codex" }), transcript: "/x/9a76de47.jsonl", conversation: { agent: "claude", path: "/x/9a76de47.jsonl", cwd: "/x" } });
    await codex.ended.resume("gr-app");
    expect(codex.calls).toEqual(["find:9a76de47", "restart:gr-app:/Users/me/app/web:-"]);
  });
});

describe("EndedSessions.whenReady", () => {
  it("lets an input to any other session go at once", async () => {
    const { ended: e, calls } = make();
    await e.whenReady("gr-app");
    expect(calls).toEqual([]);
  });

  it("holds the first input after a resume until the agent shows its prompt box, then lets the next ones go at once", async () => {
    // Claude Code shows its prompt box on the third look.
    const { ended: e, calls } = make({ onSleep: (n) => (n >= 2 ? PROMPT_BOX : ["Resuming…"]) });
    await e.resume("gr-app");
    calls.length = 0;
    await e.whenReady("gr-app");
    expect(calls).toEqual(["sleep", "sleep"]);
    calls.length = 0;
    await e.whenReady("gr-app");
    expect(calls).toEqual([]);
  });

  it("refuses to type into a dialog, after the wait runs out, or once the session ended again", async () => {
    const trust = make();
    await trust.ended.resume("gr-app");
    trust.show(TRUST);
    await expect(trust.ended.whenReady("gr-app")).rejects.toBeInstanceOf(PromptHeldError);
    const late = make();
    await late.ended.resume("gr-app");
    await expect(late.ended.whenReady("gr-app")).rejects.toThrow("not ready in time");
    expect(late.calls.filter((c) => c === "sleep").length).toBe(FIRST_PROMPT_WAIT_MS / 500);
    const gone = make();
    await gone.ended.resume("gr-app");
    gone.end();
    await expect(gone.ended.whenReady("gr-app")).rejects.toThrow("ended");
  });

  it("holds nothing for a shell", async () => {
    const { ended: e, calls } = make({ session: ended({ agent: "shell" }) });
    await e.resume("gr-app");
    calls.length = 0;
    await e.whenReady("gr-app");
    expect(calls).toEqual([]);
  });
});
