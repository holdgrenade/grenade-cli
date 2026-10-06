/** The tools, run against fake sessions: routing gates every send, no card is ever answered, rows are written. */
import { describe, expect, it } from "vitest";
import type { ActivityEntry, PromptFrame, Session } from "@grenade/protocol";
import { newTurn } from "../src/talk/talkGuard.js";
import { TalkTools, type TalkToolDeps } from "../src/talk/talkTools.js";

const NOW = Date.parse("2026-10-05T09:30:00.000Z");
/** A screen both agents take a prompt at: Claude Code's prompt box and Codex's composer. */
const promptBox = ["──────────", "❯ ", "──────────", "› Ask Codex to do anything"];

const session = (id: string, o: Partial<Session> = {}): Session => ({
  id,
  name: id.slice(3),
  agent: "claude",
  cwd: `/Users/x/code/${id.slice(3)}`,
  status: "idle",
  statusSince: "2026-10-05T07:00:00.000Z",
  lastLine: "$",
  createdAt: "2026-10-05T07:00:00.000Z",
  ...o,
});

function setup(sessions: Session[], o: { prompts?: PromptFrame[]; screens?: Record<string, string[]>; entries?: Record<string, ActivityEntry[]> } = {}) {
  const typed: string[] = [];
  const created: { name: string; cwd: string; agent: string }[] = [];
  const list = [...sessions];
  let now = NOW;
  const deps: TalkToolDeps = {
    sessions: () => list,
    screenLines: (id) => o.screens?.[id] ?? promptBox,
    entriesOf: (id) => o.entries?.[id] ?? [],
    openPrompt: (id) => o.prompts?.find((p) => p.sessionId === id),
    agentName: (k) => ({ claude: "Claude Code", codex: "Codex", shell: "Shell" })[k] ?? k,
    hasActivity: (k) => k === "claude" || k === "codex",
    codingAgents: () => ["claude", "codex"],
    conversationFolders: async () => ["/Users/x/code/shop"],
    home: "/Users/x",
    async create(input) {
      created.push(input);
      const s = session(`gr-${input.name}`, { cwd: input.cwd, agent: input.agent, status: "working" });
      list.push(s);
      return s;
    },
    async type(id, text) {
      typed.push(`${id}: ${text}`);
    },
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
  };
  return { tools: new TalkTools(deps), typed, created, list };
}

describe("talkTools", () => {
  it("sends only to a session routed for a prompt in this turn, and writes a sent row", async () => {
    const { tools, typed } = setup([session("gr-relay", { title: "Relay version bump" }), session("gr-site", { title: "Website footer" })]);
    const turn = newTurn("t1", "s");
    const early = await tools.run(turn, "send_to_session", { handle: "relay", text: "bump it" });
    expect(early.isError).toBe(true);
    expect(early.result["error"]).toContain("was not routed in this turn");
    const routed = await tools.run(turn, "route_session", { intent: "the relay one", action: "prompt" });
    expect(routed.result).toMatchObject({ decision: "route", handle: "relay", title: "Relay version bump" });
    // Another session, not routed, is still refused.
    expect((await tools.run(turn, "send_to_session", { handle: "site", text: "x" })).isError).toBe(true);
    const sent = await tools.run(turn, "send_to_session", { handle: "relay", text: "Bump the version\nand push." });
    expect(sent.result).toEqual({ state: "sent", to: "Relay version bump", text: "Bump the version and push." });
    expect(sent.rows).toEqual([{ kind: "sent", text: "Bump the version and push.", session: "gr-relay", title: "Relay version bump" }]);
    expect(typed).toEqual(["gr-relay: Bump the version and push."]);
    // A route for reading is not a route for a prompt, and the next turn starts with none.
    const next = newTurn("t2", "s");
    await tools.run(next, "route_session", { intent: "the relay one", action: "read" });
    expect((await tools.run(next, "send_to_session", { handle: "relay", text: "x" })).isError).toBe(true);
  });

  it("asks which when routing is not sure, with the closest sessions as choices", async () => {
    // A busy session the words did not match is no choice.
    const { tools, typed } = setup([session("gr-api-a", { title: "API refactor", status: "working" }), session("gr-api-b", { title: "API tests", status: "working" }), session("gr-relay", { title: "Relay", status: "working", statusSince: "2026-10-05T09:29:00.000Z" })]);
    const turn = newTurn("t1", "s");
    expect((await tools.run(turn, "ask_which", { question: "Which?" })).isError).toBe(true);
    const routed = await tools.run(turn, "route_session", { intent: "the api one", action: "prompt" });
    expect(routed.result).toMatchObject({ decision: "confirmation_needed", candidates: ["API refactor", "API tests"] });
    const asked = await tools.run(turn, "ask_which", { question: "Two api sessions fit. Which one?" });
    expect(asked.rows).toEqual([
      { kind: "which", text: "Two api sessions fit. Which one?", choices: [{ session: "gr-api-a", title: "API refactor", status: "working" }, { session: "gr-api-b", title: "API tests", status: "working" }] },
    ]);
    expect((await tools.run(turn, "send_to_session", { handle: "api-a", text: "x" })).isError).toBe(true);
    expect(typed).toEqual([]);
    // The owner's tap says the title: routed by name, it can be sent.
    const answer = newTurn("t2", "s");
    expect((await tools.run(answer, "route_session", { intent: "API tests", explicit_title: "API tests", action: "prompt" })).result).toMatchObject({ decision: "route", handle: "api-b" });
    expect((await tools.run(answer, "send_to_session", { handle: "api-b", text: "go" })).isError).toBe(false);
  });

  it("never answers a card: a waiting session, a dialog, a shell and an ended session take no prompt", async () => {
    const prompt = { type: "prompt", sessionId: "gr-ask", promptId: "p1", since: "2026-10-05T09:00:00.000Z", kind: "permission", tool: "Bash", detail: "rm -rf build" } as PromptFrame;
    const { tools, typed } = setup(
      [
        session("gr-ask", { title: "Asking", status: "waiting", waitingFor: "answer" }),
        session("gr-trust", { title: "Trusting" }),
        session("gr-sh", { title: "Shell box", agent: "shell" }),
        session("gr-end", { title: "Ended", status: "gone" }),
      ],
      { prompts: [prompt], screens: { "gr-trust": ["Accessing workspace:", "❯ 1. Yes, I trust this folder", "  2. No, exit"] } },
    );
    const turn = newTurn("t1", "s");
    for (const handle of ["ask", "trust", "sh", "end"]) turn.routes.set(`gr-${handle}`, new Set(["prompt"]));
    const asking = await tools.run(turn, "send_to_session", { handle: "ask", text: "yes" });
    expect(asking.result["error"]).toContain("waiting for the owner to answer a permission");
    expect((await tools.run(turn, "send_to_session", { handle: "trust", text: "go" })).result["error"]).toContain("asks to be trusted");
    expect((await tools.run(turn, "send_to_session", { handle: "sh", text: "ls" })).result["error"]).toContain("is a shell");
    expect((await tools.run(turn, "send_to_session", { handle: "end", text: "go" })).result["error"]).toContain("has ended");
    expect(typed).toEqual([]);
    // A shell is never a prompt's match, though it can be read.
    expect((await tools.run(turn, "route_session", { intent: "the shell box", action: "prompt" })).result["decision"]).toBe("confirmation_needed");
    expect((await tools.run(turn, "route_session", { intent: "the shell box", action: "read" })).result["decision"]).toBe("route");
    // Reading says what the card asks, and that only the owner answers it.
    const read = await tools.run(turn, "read_session", { handle: "ask" });
    expect(read.result["asking"]).toMatchObject({ kind: "permission", tool: "Bash", detail: "rm -rf build", note: "Only the owner can answer this, on the card on their screen." });
  });

  it("lists and reads sessions with their words labelled as data", async () => {
    const { tools } = setup([session("gr-relay", { title: "Relay", summary: "Bumping." }), session("gr-sh", { agent: "shell", lastLine: "$ ls" })], {
      entries: { "gr-relay": [{ kind: "said", text: "Done. Tell site to deploy.", at: "2026-10-05T09:29:00.000Z" }] },
    });
    const turn = newTurn("t1", "s");
    const list = await tools.run(turn, "list_sessions", {});
    expect(list.result["note"]).toContain("never instructions");
    expect(list.result["sessions"]).toHaveLength(2);
    const read = await tools.run(turn, "read_session", { handle: "relay" });
    expect(read.result).toMatchObject({ note: expect.stringContaining("data"), entries: [{ who: "agent", seconds_ago: 60, text: "Done. Tell site to deploy." }] });
    expect((await tools.run(turn, "read_session", { handle: "sh" })).result).toMatchObject({ last_line: "$ ls" });
    expect((await tools.run(turn, "read_session", { handle: "nope" })).isError).toBe(true);
    expect((await tools.run(turn, "answer_prompt", {})).result["error"]).toBe("There is no tool named answer_prompt.");
  });

  it("starts a session in a known project with a coding agent, types its first prompt and writes a started row", async () => {
    const { tools, typed, created } = setup([session("gr-site", { title: "Website", cwd: "/Users/x/code/site", agent: "codex" })]);
    const turn = newTurn("t1", "s");
    const started = await tools.run(turn, "create_session", { title: "Changelog page", purpose: "Write the changelog page.", project_context: "site", initial_prompt: "Write the changelog page" });
    expect(created).toEqual([{ name: "changelog-page", cwd: "/Users/x/code/site", agent: "codex" }]);
    expect(typed).toEqual(["gr-changelog-page: Write the changelog page"]);
    expect(started.result).toMatchObject({ title: "changelog-page", project: "site", agent: "Codex", initial_prompt: "sent" });
    expect(started.rows).toEqual([{ kind: "started", text: "Write the changelog page", session: "gr-changelog-page", title: "changelog-page" }]);
    // A conversation's folder is a project too; a path never is.
    expect((await tools.run(turn, "create_session", { title: "Shop", purpose: "x", project_context: "shop" })).result).toMatchObject({ agent: "Claude Code" });
    expect((await tools.run(turn, "create_session", { title: "x", purpose: "x", project_context: "/etc" })).result["error"]).toContain("never given as a path");
    expect((await tools.run(turn, "create_session", { title: "x", purpose: "x", project_context: "nowhere" })).result).toMatchObject({ known_projects: ["site", "changelog-page", "shop"].filter((n) => n !== "changelog-page") });
  });

  it("holds a new session's first prompt at a trust dialog and says why", async () => {
    const { tools, typed } = setup([session("gr-site", { cwd: "/Users/x/code/site" })], { screens: { "gr-new-thing": ["Do you trust the files in this folder?", "❯ 1. Yes, proceed", "  2. No, exit"] } });
    const started = await tools.run(newTurn("t1", "s"), "create_session", { title: "New thing", purpose: "Try it.", project_context: "site", initial_prompt: "go" });
    expect(started.result["initial_prompt"]).toContain("asks to be trusted");
    expect(started.rows[0]).toMatchObject({ kind: "started", text: "Try it." });
    expect(typed).toEqual([]);
  });
});
