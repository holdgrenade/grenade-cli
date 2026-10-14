/** Sessions' to-do lists (PROTOCOL.md "To-dos"): the store, and a Connection with it. */
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type DaemonFrame, type Session, todoBlock } from "@grenade/protocol";
import { Connection } from "../src/daemon/wsHandler.js";
import { silentLogger } from "../src/log.js";
import { TodoError, TodoStore } from "../src/todos/todoStore.js";

const session = (id: string): Session => ({ id, name: id, agent: "claude", cwd: "/w", status: "idle", statusSince: "2026-10-13T16:00:00.000Z", lastLine: "", createdAt: "2026-10-13T16:00:00.000Z" });

class FakeRegistry extends EventEmitter {
  readonly sessions = [session("gr-a"), session("gr-b")];
  readonly counts = new Map<string, number>();
  readonly typed: string[] = [];
  list() { return this.sessions; }
  get(id: string) { return this.sessions.find((s) => s.id === id); }
  setTodos(id: string, open: number) { this.counts.set(id, open); }
  unsubscribe() {}
  async sendText(_id: string, text: string) { this.typed.push(text); }
  /** The session's status changes, as the registry says it. */
  status(id: string, status: Session["status"], waitingFor?: Session["waitingFor"]) {
    const s = { ...session(id), status, ...(waitingFor ? { waitingFor } : {}) };
    this.emit("updated", s);
  }
}

const item = (title: string) => ({ title, text: `${title} And the rest of it.`, from: "2026-10-13T15:12:40.000Z" });

function store(path?: string) {
  const registry = new FakeRegistry();
  let t = Date.parse("2026-10-13T16:00:00.000Z");
  const todos = new TodoStore(registry, silentLogger, path, () => new Date((t += 1000)));
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

  it("forgets a removed session's list", () => {
    const { registry, todos } = store();
    todos.add("gr-a", [item("One.")]);
    registry.emit("removed", "gr-a");
    expect(todos.frame("gr-a").todos).toEqual([]);
  });

  it("saves to its file, mode 0600, and reads it back after a restart", () => {
    const path = join(mkdtempSync(join(tmpdir(), "todos-")), "todos.json");
    const first = store(path);
    first.todos.add("gr-a", [item("One.")]);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(path, "utf8")).sessions["gr-a"]).toHaveLength(1);
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
