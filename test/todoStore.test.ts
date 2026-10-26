/** Projects' to-do lists (PROTOCOL.md "To-dos"): the store, and a Connection with it. */
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type DaemonFrame, type Session, todoBlock } from "@grenade/protocol";
import { Connection } from "../src/daemon/wsHandler.js";
import { silentLogger } from "../src/log.js";
import { TodoError, TodoStore } from "../src/todos/todoStore.js";

const session = (id: string, cwd = "/w", group?: string): Session => ({ id, name: id, agent: "claude", cwd, status: "idle", statusSince: "2026-10-13T16:00:00.000Z", lastLine: "", createdAt: "2026-10-13T16:00:00.000Z", ...(group ? { group } : {}) });

/** gr-a in the project /w, gr-b in /v. */
class FakeRegistry extends EventEmitter {
  readonly sessions = [session("gr-a"), session("gr-b", "/v")];
  readonly counts = new Map<string, number>();
  readonly typed: string[] = [];
  list() { return this.sessions; }
  get(id: string) { return this.sessions.find((s) => s.id === id); }
  setTodos(id: string, open: number) { this.counts.set(id, open); }
  unsubscribe() {}
  async sendText(_id: string, text: string) { this.typed.push(text); }
  /** The session's status changes, as the registry says it. */
  status(id: string, status: Session["status"], waitingFor?: Session["waitingFor"]) {
    const s = { ...this.get(id)!, status, ...(waitingFor ? { waitingFor } : {}) };
    this.emit("updated", s);
  }
}

const item = (title: string) => ({ title, text: `${title} And the rest of it.`, from: "2026-10-13T15:12:40.000Z" });

function store(path?: string, registry = new FakeRegistry(), start = "2026-10-13T16:00:00.000Z") {
  let t = Date.parse(start);
  const todos = new TodoStore(registry, silentLogger, path, () => new Date((t += 1000)), "/home");
  const frames: unknown[] = [];
  todos.on("changed", (f) => frames.push(f));
  return { registry, todos, frames };
}

describe("TodoStore", () => {
  it("adds to the end, open, with ids, and counts the open ones on the session", () => {
    const { registry, todos, frames } = store();
    const f = todos.add("gr-a", [item("One."), item("Two.")], "t-1");
    expect(f.id).toBe("t-1");
    expect(f.todos.map((t) => t.title)).toEqual(["One.", "Two."]);
    expect(f.todos.every((t) => /^td-[0-9a-f]{8}$/.test(t.id) && !t.done && t.from === "2026-10-13T15:12:40.000Z")).toBe(true);
    // Which session it was added in, for the project's list.
    expect(f.todos[0]).toMatchObject({ session: "gr-a", sessionName: "gr-a" });
    expect(registry.counts.get("gr-a")).toBe(2);
    expect(frames).toHaveLength(1);
  });

  it("checks off and on, changes words, and removes", () => {
    const { registry, todos } = store();
    const [a, b] = todos.add("gr-a", [item("One."), item("Two.")]).todos;
    let f = todos.update("gr-a", a!.id, { done: true });
    expect(f.todos[0]).toMatchObject({ done: true, doneAt: expect.any(String) });
    expect(registry.counts.get("gr-a")).toBe(1);
    f = todos.update("gr-a", a!.id, { done: false, title: "Uno." });
    expect(f.todos[0]).toMatchObject({ done: false, title: "Uno." });
    expect(f.todos[0]).not.toHaveProperty("doneAt");
    f = todos.remove("gr-a", b!.id);
    expect(f.todos.map((t) => t.title)).toEqual(["Uno."]);
    expect(() => todos.remove("gr-a", b!.id)).toThrow(TodoError);
    expect(() => todos.update("gr-b", a!.id, { done: true })).toThrow(TodoError);
  });

  it("refuses an add past 200", () => {
    const { todos } = store();
    todos.add("gr-a", Array.from({ length: 50 }, (_, i) => item(`${i}.`)));
    todos.add("gr-a", Array.from({ length: 50 }, (_, i) => item(`${i}.`)));
    todos.add("gr-a", Array.from({ length: 50 }, (_, i) => item(`${i}.`)));
    todos.add("gr-a", Array.from({ length: 50 }, (_, i) => item(`${i}.`)));
    expect(() => todos.add("gr-a", [item("One too many.")])).toThrow(TodoError);
  });

  it("checks off a to-do sent in a prompt when the turn it started ends", () => {
    const { registry, todos } = store();
    const [a, b] = todos.add("gr-a", [item("One."), item("Two.")]).todos;
    todos.prompted("gr-a", `Do this.\n\n${todoBlock(a!)}`);
    expect(todos.frame("gr-a").todos[0]!.sentAt).toBeDefined();
    // Not yet started: an update from before the prompt reached the agent changes nothing.
    registry.status("gr-a", "waiting", "done");
    expect(todos.frame("gr-a").todos[0]!.done).toBe(false);
    registry.status("gr-a", "working");
    // A question is part of the turn.
    registry.status("gr-a", "waiting", "answer");
    expect(todos.frame("gr-a").todos[0]!.done).toBe(false);
    registry.status("gr-a", "working");
    registry.status("gr-a", "waiting", "done");
    expect(todos.frame("gr-a").todos.map((t) => t.done)).toEqual([true, false]);
    expect(b!.done).toBe(false);
    expect(registry.counts.get("gr-a")).toBe(1);
  });

  it("checks nothing off for a turn that stopped partway, or for another session's to-do", () => {
    const { registry, todos } = store();
    const [a] = todos.add("gr-a", [item("One.")]).todos;
    todos.prompted("gr-a", todoBlock(a!));
    registry.status("gr-a", "working");
    registry.status("gr-a", "waiting", "stopped");
    expect(todos.frame("gr-a").todos[0]!.done).toBe(false);
    todos.prompted("gr-b", todoBlock(a!));
    registry.status("gr-b", "working");
    registry.status("gr-b", "waiting", "done");
    expect(todos.frame("gr-a").todos[0]!.done).toBe(false);
  });

  it("keeps one list per project: every session in its folder sees it, and gets each change", () => {
    const { registry, todos, frames } = store();
    const c = session("gr-c", "/w/app", "g-1");
    const a = { ...registry.sessions[0]!, group: "g-1" };
    registry.sessions[0] = a;
    registry.sessions.push(c);
    registry.emit("created", c);
    frames.length = 0;
    // gr-a (/w) and gr-c (/w/app) share g-1, whose folder is /w; gr-b is another project.
    const f = todos.add("gr-c", [item("One.")], "t-1");
    expect(f).toMatchObject({ sessionId: "gr-c", id: "t-1" });
    expect(todos.frame("gr-a").todos.map((x) => x.title)).toEqual(["One."]);
    expect(todos.frame("gr-b").todos).toEqual([]);
    expect([registry.counts.get("gr-a"), registry.counts.get("gr-c"), registry.counts.get("gr-b")]).toEqual([1, 1, 0]);
    // A frame for each session of the project, the asker's with its id.
    expect(frames).toEqual([todos.frame("gr-a"), todos.frame("gr-c", "t-1")]);
    expect(todos.listOf("/w")).toHaveLength(1);
    // Every session ends: the project keeps its list, and a new session there sees it.
    registry.sessions.splice(0, registry.sessions.length, registry.sessions[1]!);
    registry.emit("removed", "gr-a");
    registry.emit("removed", "gr-c");
    const d = session("gr-d", "/w");
    registry.sessions.push(d);
    registry.emit("created", d);
    expect(todos.frame("gr-d").todos.map((x) => x.title)).toEqual(["One."]);
    expect(registry.counts.get("gr-d")).toBe(1);
  });

  it("follows a group whose folder widens, and a session moved to another project", () => {
    const { registry, todos } = store();
    registry.sessions[0] = { ...registry.sessions[0]!, cwd: "/w/app", group: "g-1" };
    registry.emit("updated", registry.sessions[0]);
    todos.add("gr-a", [item("One.")]);
    expect(todos.listOf("/w/app")).toHaveLength(1);
    // gr-b (/v… now /w/site) joins g-1: its folder is /w, and the list goes with it.
    registry.sessions[1] = { ...registry.sessions[1]!, cwd: "/w/site", group: "g-1" };
    registry.emit("updated", registry.sessions[1]);
    expect(todos.listOf("/w/app")).toBeUndefined();
    expect(todos.frame("gr-b").todos.map((x) => x.title)).toEqual(["One."]);
    expect(registry.counts.get("gr-b")).toBe(1);
    // Moved out again to a group of its own: it sees its own folder's list, none.
    registry.sessions[1] = { ...registry.sessions[1]!, group: "g-2" };
    registry.emit("updated", registry.sessions[1]);
    expect(todos.frame("gr-b").todos).toEqual([]);
    expect(registry.counts.get("gr-b")).toBe(0);
  });

  it("brings the lists of sessions and conversations from before into their projects", () => {
    const path = join(mkdtempSync(join(tmpdir(), "todos-")), "todos.json");
    const at = "2026-10-13T15:00:00.000Z";
    const todo = (id: string) => ({ id, title: id, text: id, done: false, at });
    writeFileSync(path, JSON.stringify({
      sessions: { "gr-a": [todo("td-0000000a")], "gr-gone": [todo("td-0000000b")] },
      conversations: { "gr-gone": "conv-2" },
      kept: { "conv-1": { todos: [todo("td-0000000c")], keptAt: "2026-10-12T00:00:00.000Z" } },
    }));
    const registry = new FakeRegistry();
    registry.sessions.push({ ...session("gr-e"), resumedFrom: "conv-1" });
    const { todos } = store(path, registry);
    // gr-a's and the resumed conv-1's join /w; gr-gone's waits with conv-2.
    expect(todos.frame("gr-a").todos.map((x) => x.id)).toEqual(["td-0000000a", "td-0000000c"]);
    expect(todos.keptFor("conv-2")?.map((x) => x.id)).toEqual(["td-0000000b"]);
    const saved = JSON.parse(readFileSync(path, "utf8"));
    expect(Object.keys(saved.projects)).toEqual(["/w"]);
    expect(saved.sessions).toBeUndefined();
    // A session resuming conv-2 later brings it in; one never resumed goes after 60 days.
    const resumed = { ...session("gr-f", "/v"), resumedFrom: "conv-2" };
    registry.sessions.push(resumed);
    registry.emit("created", resumed);
    expect(todos.frame("gr-b").todos.map((x) => x.id)).toEqual(["td-0000000b"]);
    const stale = join(mkdtempSync(join(tmpdir(), "todos-")), "todos.json");
    writeFileSync(stale, JSON.stringify({ kept: { "conv-3": { todos: [todo("td-0000000d")], keptAt: "2026-10-12T00:00:00.000Z" } } }));
    expect(store(stale, new FakeRegistry(), "2026-12-14T16:00:00.000Z").todos.keptFor("conv-3")).toBeUndefined();
  });

  it("moves a list kept with a conversation into the project of the folder that conversation was held in", () => {
    const path = join(mkdtempSync(join(tmpdir(), "todos-")), "todos.json");
    const at = "2026-10-13T15:00:00.000Z";
    writeFileSync(path, JSON.stringify({ kept: {
      "conv-1": { todos: [{ id: "td-0000000e", title: "Kept.", text: "Kept.", done: false, at }], keptAt: "2026-10-12T00:00:00.000Z" },
      "conv-2": { todos: [{ id: "td-0000000f", title: "Unknown.", text: "Unknown.", done: false, at }], keptAt: "2026-10-12T00:00:00.000Z" },
    } }));
    const registry = new FakeRegistry();
    const todos = new TodoStore(registry, silentLogger, path, () => new Date("2026-10-13T16:00:00.000Z"), "/home", (c) => (c === "conv-1" ? "/w/.grenade/canvas" : undefined));
    expect(todos.frame("gr-a").todos.map((x) => x.title)).toEqual(["Kept."]);
    expect(registry.counts.get("gr-a")).toBe(1);
    expect(todos.keptFor("conv-1")).toBeUndefined();
    expect(todos.keptFor("conv-2")).toHaveLength(1);
  });

  it("saves to its file, mode 0600, and reads it back after a restart", () => {
    const path = join(mkdtempSync(join(tmpdir(), "todos-")), "todos.json");
    const first = store(path);
    first.todos.add("gr-a", [item("One.")]);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(path, "utf8")).projects["/w"]).toHaveLength(1);
    const again = store(path);
    expect(again.todos.frame("gr-a").todos.map((t) => t.title)).toEqual(["One."]);
    expect(again.registry.counts.get("gr-a")).toBe(1);
  });
});

describe("a Connection with to-dos", () => {
  const hello = JSON.stringify({ type: "hello", protocol: 1, token: "grt_t", client: { name: "Mac", platform: "macos", version: "1.0.200" } });

  function connect() {
    const { registry, todos } = store();
    const out: DaemonFrame[] = [];
    const conn = new Connection({
      registry: registry as never,
      attachments: { save: async () => ({ path: "", bytes: 0 }) },
      isValidToken: () => true,
      sealed: true,
      route: "lan",
      todos,
      daemon: { id: "d_1", name: "Mac", version: "0.1.0" },
      log: silentLogger,
      out: (f) => out.push(f),
      close: () => {},
      setTimer: () => 0,
      clearTimer: () => {},
    });
    const send = (frame: object) => conn.handleMessage(JSON.stringify(frame));
    return { registry, todos, out, send, conn };
  }

  it("answers todos, and sends every change with the id of the frame that made it", async () => {
    const { out, send } = connect();
    await send(JSON.parse(hello));
    await send({ type: "todos", sessionId: "gr-a", id: "q" });
    expect(out.at(-1)).toEqual({ type: "todos", sessionId: "gr-a", id: "q", todos: [] });
    await send({ type: "todo.add", sessionId: "gr-a", id: "a", todos: [item("One.")] });
    const added = out.at(-1) as Extract<DaemonFrame, { type: "todos" }>;
    expect(added).toMatchObject({ type: "todos", id: "a" });
    await send({ type: "todo.update", sessionId: "gr-a", id: "u", todo: added.todos[0]!.id, done: true });
    expect(out.at(-1)).toMatchObject({ type: "todos", id: "u", todos: [{ done: true }] });
  });

  it("refuses an unknown session and a to-do it does not have, with the id", async () => {
    const { out, send } = connect();
    await send(JSON.parse(hello));
    await send({ type: "todos", sessionId: "gr-x", id: "q" });
    expect(out.at(-1)).toMatchObject({ type: "error", code: "unknown_session", id: "q" });
    await send({ type: "todo.remove", sessionId: "gr-a", id: "r", todo: "td-00000000" });
    expect(out.at(-1)).toMatchObject({ type: "error", code: "bad_frame", ref: "todo.remove", id: "r" });
  });

  it("marks a prompt's to-dos sent when it is typed", async () => {
    const { registry, todos, send } = connect();
    await send(JSON.parse(hello));
    const [a] = todos.add("gr-a", [item("One.")]).todos;
    await send({ type: "input", sessionId: "gr-a", id: "i-1", submit: true, text: `Go.\n\n${todoBlock(a!)}` });
    expect(registry.typed).toHaveLength(1);
    expect(todos.frame("gr-a").todos[0]!.sentAt).toBeDefined();
  });
});

describe("grenade todo", () => {
  it("makes a title of at most 200 characters, its first sentence when longer, and keeps the whole text", async () => {
    const { newTodo, todoLines } = await import("../src/cli/todoCommand.js");
    expect(newTodo("Trim the email.")).toEqual({ title: "Trim the email.", text: "Trim the email." });
    expect(newTodo("Trim the email.", "Before checking it.")).toEqual({ title: "Trim the email.", text: "Before checking it." });
    const long = `Make the field forgiving. ${"It rejects spaces. ".repeat(20)}`;
    const made = newTodo(long);
    expect(made.title).toBe("Make the field forgiving.");
    expect(made.text).toBe(long.replace(/\s+/g, " ").trim());
    expect(newTodo("x".repeat(300)).title).toHaveLength(200);
    expect(todoLines([])).toEqual(["No to-dos."]);
    const at = "2026-10-21T00:00:00.000Z";
    expect(todoLines([{ id: "td-1", title: "Done one", text: "Done one", done: true, at }, { id: "td-2", title: "Open one", text: "Open one", done: false, at }]))
      .toEqual(["[ ] Open one  (td-2)", "[x] Done one  (td-1)"]);
  });
});
