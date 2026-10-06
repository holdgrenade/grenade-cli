/** The service: one turn at a time, rows in order, busy, failures, the agent's choice, and needsYou / finished. */
import { describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaemonFrame, type Session, type TalkEntry } from "@grenade/protocol";
import { silentLogger } from "../src/log.js";
import type { TalkAgentKind, TalkOutcome, TalkTurnSpec } from "../src/talk/talkAgents.js";
import { ENV_SECRET, ENV_TURN } from "../src/talk/talkMcp.js";
import { TalkService, answeringAgent, continuing } from "../src/talk/talkService.js";
import { TalkTools } from "../src/talk/talkTools.js";

const session = (id: string, o: Partial<Session> = {}): Session => ({
  id,
  name: id.slice(3),
  agent: "claude",
  cwd: `/Users/x/code/${id.slice(3)}`,
  status: "idle",
  statusSince: "2026-10-05T07:00:00.000Z",
  lastLine: "",
  createdAt: "2026-10-05T07:00:00.000Z",
  ...o,
});

class FakeRegistry extends EventEmitter {
  sessions = new Map<string, Session>();
  list() {
    return [...this.sessions.values()];
  }
  get(id: string) {
    return this.sessions.get(id);
  }
  update(s: Session) {
    this.sessions.set(s.id, s);
    this.emit("updated", s);
  }
}

interface Turn {
  agent: TalkAgentKind;
  spec: TalkTurnSpec;
  words: string;
  env: Record<string, string>;
}

function setup(o: { agents?: TalkAgentKind[]; answer?: (t: Turn, svc: TalkService) => Promise<TalkOutcome> } = {}) {
  const home = mkdtempSync(join(tmpdir(), "talk-svc-"));
  const registry = new FakeRegistry();
  registry.sessions.set("gr-relay", session("gr-relay", { title: "Relay version bump" }));
  const typed: string[] = [];
  const turns: Turn[] = [];
  const tools = new TalkTools({
    sessions: () => registry.list(),
    screenLines: () => ["─────", "❯ ", "─────"],
    entriesOf: () => [],
    openPrompt: () => undefined,
    agentName: (k) => (k === "codex" ? "Codex" : "Claude Code"),
    hasActivity: (k) => k !== "shell",
    codingAgents: () => ["claude", "codex"],
    conversationFolders: async () => [],
    home: "/Users/x",
    create: async () => {
      throw new Error("no");
    },
    type: async (id, text) => void typed.push(`${id}: ${text}`),
    now: () => Date.now(),
    sleep: async () => {},
  });
  let svc!: TalkService;
  svc = new TalkService({
    dir: join(home, "talk"),
    workDir: join(home, "talk", "work"),
    settingsPath: join(home, "talk.json"),
    tools,
    registry,
    feed: { entriesOf: () => [], askingOf: () => undefined, hasActivity: (k) => k !== "shell" },
    agents: o.agents ?? ["claude", "codex"],
    agentName: (k) => (k === "codex" ? "Codex" : "Claude Code"),
    async run(agent, spec, words, env) {
      const turn = { agent, spec, words, env };
      turns.push(turn);
      return o.answer ? o.answer(turn, svc) : { text: "Done.", conversation: spec.conversation ?? spec.newConversation };
    },
    mcp: { command: "node", args: ["cli.js", "talk-mcp"] },
    controlPort: 7789,
    log: silentLogger,
    computer: "Mac",
  });
  const events: unknown[] = [];
  svc.on("entry", (e) => events.push(e));
  svc.on("busy", (b) => events.push({ busy: b }));
  svc.on("thread", (f) => events.push(f));
  const settled = async () => {
    for (let i = 0; i < 50 && svc.busy(); i++) await new Promise((r) => setTimeout(r, 5));
  };
  return { svc, registry, typed, turns, events, settled, home };
}

describe("talkService pure rules", () => {
  it("chooses the agent and continues the day's conversation", () => {
    expect(answeringAgent("codex", ["claude", "codex"])).toBe("codex");
    expect(answeringAgent("codex", ["claude"])).toBe("claude");
    expect(answeringAgent(undefined, [])).toBeUndefined();
    const settings = { conversation: { date: "2026-10-05", agent: "claude", id: "c1" } };
    expect(continuing(settings, "2026-10-05", "claude")).toBe("c1");
    expect(continuing(settings, "2026-10-06", "claude")).toBeUndefined();
    expect(continuing(settings, "2026-10-05", "codex")).toBeUndefined();
  });
});

describe("TalkService", () => {
  it("answers a turn with the agent's tools, writing you, sent and it rows, busy around them", async () => {
    const { svc, turns, typed, events, settled } = setup({
      async answer(t, s) {
        // The agent's MCP server calls back with the turn's id and secret from its environment.
        const routed = await s.tool(t.env[ENV_TURN], t.env[ENV_SECRET], "route_session", { intent: "the relay one", action: "prompt" });
        expect(routed).toMatchObject({ ok: true, isError: false });
        await s.tool(t.env[ENV_TURN], t.env[ENV_SECRET], "send_to_session", { handle: "relay", text: "Bump the version and push to main." });
        return { text: "Sent it to Relay version bump.", conversation: t.spec.newConversation };
      },
    });
    expect(svc.say("u-1", "Bump the relay version and push it")).toBe(true);
    await settled();
    expect(typed).toEqual(["gr-relay: Bump the version and push to main."]);
    const kinds = events.map((e) => ((e as TalkEntry).kind ? (e as TalkEntry).kind : e));
    expect(kinds).toEqual(["you", { busy: true }, "sent", "it", { busy: false }]);
    expect(turns[0]?.words).toContain('"handle": "relay"');
    expect(turns[0]?.words.endsWith("The owner says:\nBump the relay version and push it")).toBe(true);
    expect(turns[0]?.spec.conversation).toBeUndefined();
    // Every frame it would send decodes as the protocol's.
    const frame = svc.frame();
    expect(DaemonFrame.safeParse(frame).success).toBe(true);
    for (const entry of frame.entries) expect(DaemonFrame.safeParse({ type: "talk.entry", entry }).success).toBe(true);
    expect(frame).toMatchObject({ busy: false, agent: "claude" });
    // The next turn continues the conversation and gets no day summary; a repeated id is not said again.
    expect(svc.say("u-1", "again")).toBe(false);
    svc.say("u-2", "and the other one?");
    await settled();
    expect(turns[1]?.spec.conversation).toBe(turns[0]?.spec.newConversation);
    expect(turns[1]?.words).not.toContain("<today");
  });

  it("refuses a tool call from outside the running turn", async () => {
    let leaked: { turn?: string; secret?: string } = {};
    const { svc, typed, settled } = setup({
      async answer(t) {
        leaked = { turn: t.env[ENV_TURN], secret: t.env[ENV_SECRET] };
        return { text: "", conversation: undefined };
      },
    });
    expect(await svc.tool("t", "s", "list_sessions", {})).toEqual({ ok: false, message: "This Talk turn is over." });
    svc.say("u-1", "hi");
    await settled();
    // After the turn its own secret is refused too.
    expect(await svc.tool(leaked.turn, leaked.secret, "send_to_session", { handle: "relay", text: "x" })).toEqual({ ok: false, message: "This Talk turn is over." });
    expect(typed).toEqual([]);
    // An empty answer writes no `it` row.
    expect(svc.frame().entries.map((e) => e.kind)).toEqual(["you"]);
  });

  it("answers words in the order they came, one turn at a time", async () => {
    const order: string[] = [];
    let running = 0;
    const { svc, settled } = setup({
      async answer(t) {
        running++;
        expect(running).toBe(1);
        await new Promise((r) => setTimeout(r, 5));
        order.push(t.words.split("\n").at(-1)!);
        running--;
        return { text: `ok ${order.length}`, conversation: "c" };
      },
    });
    svc.say("a", "one");
    svc.say("b", "two");
    svc.say("c", "three");
    await settled();
    expect(order).toEqual(["one", "two", "three"]);
    expect(svc.frame().entries.map((e) => `${e.kind}:${e.text}`)).toEqual(["you:one", "you:two", "you:three", "it:ok 1", "it:ok 2", "it:ok 3"]);
  });

  it("writes a failed row in a sentence, and starts a new conversation after one", async () => {
    const { svc, turns, settled } = setup({ answer: async () => ({ failure: "signedOut", detail: "Please run /login" }) });
    svc.say("a", "hi");
    await settled();
    expect(svc.frame().entries.at(-1)).toMatchObject({ kind: "failed", text: "Claude Code is not signed in on this Mac. Run claude in a terminal to sign in." });
    svc.say("b", "hi again");
    await settled();
    expect(turns[1]?.spec.conversation).toBeUndefined();
  });

  it("says no agent can answer when none is installed", async () => {
    const { svc, turns, settled } = setup({ agents: [] });
    expect(svc.frame().agent).toBeUndefined();
    svc.say("a", "hi");
    await settled();
    expect(turns).toEqual([]);
    expect(svc.frame().entries.map((e) => e.kind)).toEqual(["you", "failed"]);
  });

  it("switches the agent, which starts its own conversation and is handed the day in short", async () => {
    const { svc, turns, events, settled, home } = setup();
    svc.say("a", "hi");
    await settled();
    expect(svc.setAgent("shell")).toBe(false);
    expect(svc.setAgent("codex")).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: "talk.thread", agent: "codex" });
    expect(JSON.parse(readFileSync(join(home, "talk.json"), "utf8"))).toEqual({ agent: "codex" });
    svc.say("b", "and now?");
    await settled();
    expect(turns[1]).toMatchObject({ agent: "codex", spec: { conversation: undefined } });
    expect(turns[1]?.words).toContain("owner: hi");
    expect(turns[1]?.words).toContain("you answered: Done.");
  });

  it("writes no working row for a turn it sent, and a feed row for a session it never sent to", async () => {
    const { svc, registry, settled } = setup({
      async answer(t, s) {
        await s.tool(t.env[ENV_TURN], t.env[ENV_SECRET], "route_session", { intent: "relay", action: "prompt" });
        await s.tool(t.env[ENV_TURN], t.env[ENV_SECRET], "send_to_session", { handle: "relay", text: "go" });
        return { text: "Sent.", conversation: "c" };
      },
    });
    registry.sessions.set("gr-other", session("gr-other", { title: "Other work" }));
    svc.say("a", "tell relay to go");
    await settled();
    // The hook of the turn Talk sent, and one of a turn typed in another session.
    svc.noteAsked("gr-relay", "go");
    svc.noteAsked("gr-other", "Write the docs");
    expect(svc.frame().entries.map((e) => `${e.kind}${e.session ? `:${e.session}` : ""}:${e.text}`)).toEqual(["you:tell relay to go", "sent:gr-relay:go", "it:Sent.", "working:gr-other:Write the docs"]);
    svc.stop();
  });
});
