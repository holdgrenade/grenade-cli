import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ReportedBackgroundTask, Session } from "@grenade/protocol";
import { ClaudeBackgroundWatch, claudeSaysIdle } from "../src/background/claudeBackgroundWatch.js";
import { codexBackgroundIn } from "../src/background/codexBackground.js";
import { NO_TASKS, countedTasks, heldTasks, restoreHeld, shownTask } from "../src/background/heldTasks.js";
import { watchScreenBackground } from "../src/background/screenBackground.js";
import { handleCodexHook } from "../src/daemon/codexHooks.js";
import { handleClaudeHook } from "../src/daemon/hooks.js";
import { silentLogger } from "../src/log.js";
import { SessionRegistry } from "../src/sessions/registry.js";
import { initialStatus, reduceStatus, STOPPED_QUIET_MS, shownWaitingFor, type StatusState } from "../src/sessions/status.js";
import type { Tmux } from "../src/tmux/tmux.js";
import { isBusy } from "../src/update/versions.js";

const examples = JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "grenade-protocol", "fixtures", "background.examples.json"), "utf8"));
const deploy: ReportedBackgroundTask = { id: "bs4ziypuh", kind: "shell", title: "Deploy to staging", command: "npm run deploy:staging" };
const review: ReportedBackgroundTask = { id: "a70b92ef", kind: "agent", title: "Review the migration" };

describe("status machine: a turn that ends with background tasks", () => {
  const working: StatusState = { ...initialStatus(0), hookDriven: true };
  const hold = (s: StatusState, at: number) => reduceStatus(s, { kind: "hook", status: "working", background: true, at });

  it("stays working, and is not taken for a turn that stopped partway", () => {
    let s = hold(working, 1000);
    expect(s).toMatchObject({ status: "working", background: true, since: 0 });
    s = reduceStatus(s, { kind: "output", changed: false, busy: false, at: 1000 + 2 * STOPPED_QUIET_MS });
    expect(s).toMatchObject({ status: "working", background: true });
  });

  it("finishes when the tasks are over without a hook", () => {
    const s = reduceStatus(hold(working, 1000), { kind: "background", running: false, at: 9000 });
    expect(s).toMatchObject({ status: "waiting", since: 9000 });
    expect(s.background).toBeUndefined();
    expect(shownWaitingFor(s)).toBe("done");
    expect(reduceStatus(working, { kind: "background", running: false, at: 9000 })).toBe(working);
  });

  it("any other hook lets go of the hold", () => {
    const held = hold(working, 1000);
    expect(reduceStatus(held, { kind: "hook", status: "working", at: 2000 })).toMatchObject({ status: "working" });
    expect(reduceStatus(held, { kind: "hook", status: "working", at: 2000 }).background).toBeUndefined();
    const done = reduceStatus(held, { kind: "hook", status: "waiting", waitingFor: "done", at: 3000 });
    expect(done).toMatchObject({ status: "waiting", waitingFor: "done" });
    expect(done.background).toBeUndefined();
  });

  it("a tool call inside a subagent keeps the hold, and starts no turn on a session that has finished", () => {
    const sub = (s: StatusState, at: number) => reduceStatus(s, { kind: "hook", status: "working", aside: true, at });
    const held = hold(working, 1000);
    expect(sub(held, 2000)).toBe(held);
    const done = reduceStatus(working, { kind: "hook", status: "waiting", waitingFor: "done", at: 1000 });
    expect(sub(done, 2000)).toBe(done);
    const seen = reduceStatus(done, { kind: "seen", at: 1500 });
    expect(sub(seen, 2000)).toBe(seen);
    expect(sub(working, 2000)).toBe(working);
    // The first hook a session ever sends makes it hook-driven, even from a subagent.
    expect(sub(initialStatus(0), 2000)).toMatchObject({ status: "working", hookDriven: true });
  });

  it("a question under the hold is asked, and answered the session is held again", () => {
    const held = hold(working, 1000);
    const asking = reduceStatus(held, { kind: "hook", status: "waiting", waitingFor: "answer", at: 2000 });
    expect(asking).toMatchObject({ status: "waiting", waitingFor: "answer", background: true });
    // What ends a hold does not end a question.
    expect(reduceStatus(asking, { kind: "background", running: false, at: 2500 })).toBe(asking);
    expect(reduceStatus(asking, { kind: "hook", status: "working", aside: true, at: 3000 })).toMatchObject({ status: "working", background: true });
    // Without a hold, an answered question is plain working.
    const plain = reduceStatus(working, { kind: "hook", status: "waiting", waitingFor: "answer", at: 2000 });
    const answered = reduceStatus(plain, { kind: "hook", status: "working", aside: true, at: 3000 });
    expect(answered.status).toBe("working");
    expect(answered.background).toBeUndefined();
  });

  it("a screen that shows tasks a moment late holds a turn that has just finished, and only that", () => {
    const done = reduceStatus(working, { kind: "hook", status: "waiting", waitingFor: "done", at: 1000 });
    expect(reduceStatus(done, { kind: "background", running: true, at: 1500 })).toMatchObject({ status: "working", background: true, since: 1500 });
    const asking = reduceStatus(working, { kind: "hook", status: "waiting", waitingFor: "answer", at: 1000 });
    expect(reduceStatus(asking, { kind: "background", running: true, at: 1500 })).toBe(asking);
    const seen = reduceStatus(done, { kind: "seen", at: 1200 });
    expect(reduceStatus(seen, { kind: "background", running: true, at: 1500 })).toBe(seen);
    const heuristic = { ...initialStatus(0), status: "waiting" as const, waitingFor: "done" as const };
    expect(reduceStatus(heuristic, { kind: "background", running: true, at: 1500 })).toBe(heuristic);
  });
});

describe("heldTasks", () => {
  it("keeps the time a task had, else the time a hook saw it start, else now", () => {
    const first = heldTasks([deploy], NO_TASKS, new Map([["bs4ziypuh", "2026-10-03T14:00:00.000Z"]]), "2026-10-03T14:00:05.000Z");
    expect(first).toEqual([{ ...deploy, since: "2026-10-03T14:00:00.000Z" }]);
    const second = heldTasks([deploy, review], first, new Map(), "2026-10-03T14:02:00.000Z");
    expect(second.map((t) => t.since)).toEqual(["2026-10-03T14:00:00.000Z", "2026-10-03T14:02:00.000Z"]);
    expect(heldTasks([deploy, review], second, new Map(), "2026-10-03T14:09:00.000Z")).toBe(second);
    expect(heldTasks([], second, new Map(), "2026-10-03T14:09:00.000Z")).toBe(NO_TASKS);
  });

  it("a client gets a task without the agent's id", () => {
    expect(shownTask({ ...deploy, since: "2026-10-03T14:00:00.000Z" })).toEqual({ kind: "shell", title: "Deploy to staging", command: "npm run deploy:staging", since: "2026-10-03T14:00:00.000Z" });
  });

  it("counted tasks are shell commands without a title", () => {
    expect(countedTasks(2)).toEqual([{ id: "#0", kind: "shell" }, { id: "#1", kind: "shell" }]);
    expect(countedTasks(0)).toEqual([]);
  });

  it("restores only what is a held task", () => {
    const good = { id: "x", kind: "shell", since: "2026-10-03T14:00:00.000Z" };
    expect(restoreHeld([good, { kind: "shell", since: "2026-10-03T14:00:00.000Z" }, { id: "y", kind: "shell" }, null])).toEqual([good]);
    expect(restoreHeld(undefined)).toBe(NO_TASKS);
    expect(restoreHeld([null])).toBe(NO_TASKS);
  });
});

describe("codexBackgroundIn", () => {
  it("reads the count off Codex's line", () => {
    expect(codexBackgroundIn(["• started", "", "  Worked for 5s • 10:31 AM", "", "  1 background terminal running · /ps to view · /stop to close", "", "› Ask Codex to do anything"])).toBe(1);
    expect(codexBackgroundIn(["  3 background terminals running · /ps to view"])).toBe(3);
  });
  it("is 0 when the screen says nothing, or only talks about one", () => {
    expect(codexBackgroundIn(["• started", "  Worked for 5s • 10:31 AM", "› Ask Codex to do anything"])).toBe(0);
    expect(codexBackgroundIn(["• I left 1 background terminal running for the server."])).toBe(0);
  });
});

function fakeRegistry() {
  const calls: string[] = [];
  return {
    calls,
    applyHook: (id: string, s: string, w?: string) => (calls.push(`${id}:${s}${w ? `:${w}` : ""}`), true),
    holdForBackground: (id: string, tasks: readonly ReportedBackgroundTask[]) => (calls.push(`${id}:hold:${tasks.map((t) => t.id).join(",")}`), true),
    backgroundStarted: (id: string, taskId: string) => void calls.push(`${id}:started:${taskId}`),
  };
}

describe("hooks and background tasks", () => {
  it("a Claude Code Stop with tasks still running holds the session; one without finishes it", () => {
    const r = fakeRegistry();
    expect(handleClaudeHook(r, "gr-a", JSON.stringify(examples.stop.payload), silentLogger).body).toEqual({ ok: true, applied: "working" });
    expect(handleClaudeHook(r, "gr-a", JSON.stringify({ ...examples.stop.payload, background_tasks: [] }), silentLogger).body.applied).toBe("waiting");
    expect(handleClaudeHook(r, "gr-a", JSON.stringify({ hook_event_name: "Stop" }), silentLogger).body.applied).toBe("waiting");
    expect(r.calls).toEqual(["gr-a:hold:bs4ziypuh,a70b92ef82c21cddb", "gr-a:waiting:done", "gr-a:waiting:done"]);
  });

  it("a PostToolUse that started a task notes when", () => {
    const r = fakeRegistry();
    handleClaudeHook(r, "gr-a", JSON.stringify(examples.started.payload), silentLogger);
    expect(r.calls).toEqual(["gr-a:working", "gr-a:started:bs4ziypuh"]);
  });

  it("a tool call inside a subagent is applied as an aside", () => {
    const asides: boolean[] = [];
    const r = { ...fakeRegistry(), applyHook: (_id: string, _s: string, _w?: string, aside?: boolean) => (asides.push(aside === true), true) };
    handleClaudeHook(r, "gr-a", JSON.stringify({ hook_event_name: "PreToolUse", agent_id: "a10364ca06af2342d", agent_type: "" }), silentLogger);
    handleClaudeHook(r, "gr-a", JSON.stringify({ hook_event_name: "PreToolUse" }), silentLogger);
    handleClaudeHook(r, "gr-a", JSON.stringify({ hook_event_name: "PermissionRequest", agent_id: "a10364ca06af2342d" }), silentLogger);
    expect(asides).toEqual([true, false, false]);
  });

  it("a Codex Stop holds the session while its screen shows background terminals", () => {
    const r = fakeRegistry();
    const stop = JSON.stringify({ hook_event_name: "Stop" });
    expect(handleCodexHook(r, "gr-c", stop, silentLogger, { background: () => 2 }).body.applied).toBe("working");
    expect(handleCodexHook(r, "gr-c", stop, silentLogger, { background: () => 0 }).body.applied).toBe("waiting");
    expect(handleCodexHook(r, "gr-c", JSON.stringify({ hook_event_name: "PreToolUse" }), silentLogger, { background: () => 2 }).body.applied).toBe("working");
    expect(r.calls).toEqual(["gr-c:hold:#0,#1", "gr-c:waiting:done", "gr-c:working"]);
  });
});

function fakeTmux(live: string[] = []): Tmux {
  return {
    async listSessions() { return live; },
    async hasSession() { return false; },
    async newSession() {},
    async capture() { throw new Error("unused"); },
    async captureHistory() { throw new Error("unused"); },
    async applySessionOptions() {},
    async sendText() {},
    async sendKey() {},
    async resize() {},
    async releaseSize() {},
    async windowWidths() { return new Map(); },
    async killSession() {},
  };
}

describe("SessionRegistry and background tasks", () => {
  const start = Date.parse("2026-10-03T14:00:00.000Z");
  const make = async (o: { live?: string[]; persistPath?: string } = {}) => {
    let t = 0;
    const registry = new SessionRegistry({
      tmux: fakeTmux(o.live),
      log: silentLogger,
      home: "/Users/me",
      isDirectory: () => true,
      now: () => start + ++t * 1000,
      ...(o.persistPath ? { persistPath: o.persistPath } : {}),
    });
    const updates: Session[] = [];
    registry.on("updated", (s) => updates.push(s));
    return { registry, updates };
  };

  it("a held session is working and lists its tasks, without their ids", async () => {
    const { registry, updates } = await make();
    await registry.create({ name: "api", cwd: "~/app", agent: "claude" });
    registry.applyHook("gr-api", "working");
    registry.backgroundStarted("gr-api", "bs4ziypuh");
    updates.length = 0;
    expect(registry.holdForBackground("gr-api", [deploy, review])).toBe(true);
    const session = registry.get("gr-api");
    expect(session?.status).toBe("working");
    expect(session?.background).toEqual([
      { kind: "shell", title: "Deploy to staging", command: "npm run deploy:staging", since: "2026-10-03T14:00:04.000Z" },
      { kind: "agent", title: "Review the migration", since: "2026-10-03T14:00:05.000Z" },
    ]);
    expect(updates).toHaveLength(1);
    // The same report again changes nothing.
    registry.holdForBackground("gr-api", [deploy, review]);
    expect(updates).toHaveLength(1);
    expect(registry.heldInBackground().map((s) => s.id)).toEqual(["gr-api"]);
    expect(registry.holdForBackground("gr-nope", [deploy])).toBe(false);
  });

  it("one task fewer is an update; the next turn drops the list; a finished one is done", async () => {
    const { registry, updates } = await make();
    await registry.create({ name: "api", cwd: "~/app", agent: "claude" });
    registry.holdForBackground("gr-api", [deploy, review]);
    updates.length = 0;
    registry.holdForBackground("gr-api", [deploy]);
    expect(updates.at(-1)?.background).toHaveLength(1);
    registry.applyHook("gr-api", "working");
    expect(registry.get("gr-api")).toMatchObject({ status: "working" });
    expect(registry.get("gr-api")?.background).toBeUndefined();
    registry.holdForBackground("gr-api", [deploy]);
    registry.backgroundOver("gr-api");
    expect(registry.get("gr-api")).toMatchObject({ status: "waiting", waitingFor: "done" });
    expect(registry.get("gr-api")?.background).toBeUndefined();
    expect(registry.heldInBackground()).toEqual([]);
  });

  it("lists the tasks only while working: a question hides them, its answer brings them back", async () => {
    const { registry } = await make();
    await registry.create({ name: "api", cwd: "~/app", agent: "claude" });
    registry.holdForBackground("gr-api", [review]);
    registry.applyHook("gr-api", "working", undefined, true);
    expect(registry.get("gr-api")?.background).toHaveLength(1);
    registry.applyHook("gr-api", "waiting", "answer");
    expect(registry.get("gr-api")).toMatchObject({ status: "waiting", waitingFor: "answer" });
    expect(registry.get("gr-api")?.background).toBeUndefined();
    expect(registry.heldInBackground()).toEqual([]);
    registry.applyHook("gr-api", "working", undefined, true);
    expect(registry.get("gr-api")).toMatchObject({ status: "working", background: [{ kind: "agent" }] });
  });

  it("a restarted daemon holds the session again", async () => {
    const persistPath = join(mkdtempSync(join(tmpdir(), "gr-bg-")), "sessions.json");
    const first = await make({ persistPath });
    await first.registry.create({ name: "api", cwd: "~/app", agent: "claude" });
    first.registry.holdForBackground("gr-api", [deploy]);
    const second = await make({ live: ["gr-api"], persistPath });
    await second.registry.adopt();
    expect(second.registry.get("gr-api")).toMatchObject({ status: "working", background: [{ kind: "shell", title: "Deploy to staging" }] });
    expect(second.registry.hookDriven("gr-api")).toBe(true);
    second.registry.backgroundOver("gr-api");
    expect(second.registry.get("gr-api")?.status).toBe("waiting");
    const third = await make({ live: ["gr-api"], persistPath });
    await third.registry.adopt();
    expect(third.registry.get("gr-api")?.background).toBeUndefined();
  });

  it("a screen holds a session that has just finished, counts its tasks, and lets it finish", async () => {
    const { registry } = await make();
    await registry.create({ name: "web", cwd: "~/app", agent: "codex" });
    watchScreenBackground(registry);
    const screen = (lines: string[]) => registry.emit("captured", "gr-web", "codex", lines);
    // Not hook-driven yet: the screen holds nothing.
    screen(["  1 background terminal running · /ps to view"]);
    expect(registry.get("gr-web")?.background).toBeUndefined();
    registry.applyHook("gr-web", "working");
    registry.applyHook("gr-web", "waiting", "done");
    screen(["  2 background terminals running · /ps to view"]);
    expect(registry.get("gr-web")).toMatchObject({ status: "working", background: [{ kind: "shell" }, { kind: "shell" }] });
    screen(["  1 background terminal running · /ps to view"]);
    expect(registry.get("gr-web")?.background).toHaveLength(1);
    screen(["› Ask Codex to do anything"]);
    expect(registry.get("gr-web")).toMatchObject({ status: "waiting", waitingFor: "done" });
    // A working session's screen holds nothing either.
    registry.applyHook("gr-web", "working");
    screen(["  1 background terminal running · /ps to view"]);
    expect(registry.get("gr-web")?.background).toBeUndefined();
  });
});

describe("ClaudeBackgroundWatch", () => {
  it("claudeSaysIdle reads the process of that conversation", () => {
    const processes = [{ pid: 1, sessionId: "a", status: "shell" }, { pid: 2, sessionId: "b", status: "idle" }, { pid: 3, sessionId: "c" }];
    expect(claudeSaysIdle(processes, "a")).toBe(false);
    expect(claudeSaysIdle(processes, "b")).toBe(true);
    expect(claudeSaysIdle(processes, "c")).toBe(false);
    expect(claudeSaysIdle(processes, "gone")).toBe(false);
  });

  it("ends a hold after two idle looks in a row, and leaves other agents alone", async () => {
    const over: string[] = [];
    let status = "shell";
    let reads = 0;
    const held = [
      { id: "gr-api", agent: "claude", transcript: "/Users/me/.claude/projects/-app/abc.jsonl" },
      { id: "gr-web", agent: "codex", transcript: "/Users/me/.codex/sessions/rollout-x.jsonl" },
    ];
    const port = { heldInBackground: () => held.filter((s) => !over.includes(s.id)), backgroundOver: (id: string) => void over.push(id) };
    const watch = new ClaudeBackgroundWatch(port, "/sessions", silentLogger, async () => (reads++, [{ pid: 1, sessionId: "abc", status }]));
    await watch.look();
    status = "idle";
    await watch.look();
    expect(over).toEqual([]);
    status = "busy";
    await watch.look();
    status = "idle";
    await watch.look();
    expect(over).toEqual([]);
    await watch.look();
    expect(over).toEqual(["gr-api"]);
    // Nothing of Claude Code's is held any more: the folder is not read.
    const before = reads;
    await watch.look();
    expect(reads).toBe(before);
  });
});

describe("isBusy", () => {
  it("a session that only waits for background tasks does not keep the daemon from restarting", () => {
    expect(isBusy({ status: "working" })).toBe(true);
    expect(isBusy({ status: "working", background: [{}] })).toBe(false);
  });
});
