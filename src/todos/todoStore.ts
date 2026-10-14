/**
 * Sessions' to-do lists (PROTOCOL.md "To-dos"), kept for every client. Follows the registry: a to-do sent in a prompt
 * (a `<todo>` block) is checked off when the turn that prompt started ends, and a removed session's list goes with it.
 * Saved to todos.json (mode 0600) so it survives a restart.
 */
import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { type NewTodo, type Session, Todo, type TodosFrame, TODOS_MAX, openTodos, todoIdsIn } from "@grenade/protocol";
import type { Logger } from "../log.js";

/** The slice of SessionRegistry the store follows. */
export interface TodoRegistry {
  list(): Session[];
  setTodos(id: string, open: number): void;
  on(event: "updated", cb: (s: Session) => void): unknown;
  on(event: "removed", cb: (id: string) => void): unknown;
}

export interface TodoStoreEvents {
  /** A session's list changed; the frame goes to every client. */
  changed: [frame: TodosFrame];
}

/** A change the store refused: a to-do it does not have, or a list that is full. */
export class TodoError extends Error {}

/** To-dos sent in a prompt, waiting for the turn it started to end. */
interface Sent {
  ids: string[];
  /** The session went `working` after the prompt: its turn has started. */
  started: boolean;
}

export class TodoStore extends EventEmitter<TodoStoreEvents> {
  private readonly lists = new Map<string, Todo[]>();
  private readonly sent = new Map<string, Sent>();

  constructor(
    private readonly registry: TodoRegistry,
    private readonly log: Logger,
    private readonly path?: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    super();
    this.load();
    // Lists of sessions that are no longer here go; the rest show their count.
    const ids = new Set(registry.list().map((s) => s.id));
    let dropped = false;
    for (const id of [...this.lists.keys()]) {
      if (!ids.has(id)) dropped = this.lists.delete(id) || dropped;
    }
    if (dropped) this.save();
    for (const [id, todos] of this.lists) registry.setTodos(id, openTodos(todos));
    registry.on("updated", (s) => this.sessionUpdated(s));
    registry.on("removed", (id) => this.forget(id));
  }

  frame(sessionId: string, id?: string): TodosFrame {
    return { type: "todos", sessionId, ...(id ? { id } : {}), todos: [...(this.lists.get(sessionId) ?? [])] };
  }

  add(sessionId: string, todos: NewTodo[], frameId?: string): TodosFrame {
    const list = this.lists.get(sessionId) ?? [];
    if (list.length + todos.length > TODOS_MAX) throw new TodoError(`A session keeps at most ${TODOS_MAX} to-dos.`);
    const at = this.now().toISOString();
    const added = todos.map((t): Todo => ({ id: this.newId(), title: t.title, text: t.text, done: false, at, ...(t.from ? { from: t.from } : {}) }));
    return this.apply(sessionId, [...list, ...added], frameId);
  }

  update(sessionId: string, todoId: string, change: { done?: boolean | undefined; title?: string | undefined; text?: string | undefined }, frameId?: string): TodosFrame {
    const list = this.require(sessionId, todoId);
    const at = this.now().toISOString();
    return this.apply(
      sessionId,
      list.map((t) => {
        if (t.id !== todoId) return t;
        const next: Todo = { ...t, ...(change.title !== undefined ? { title: change.title } : {}), ...(change.text !== undefined ? { text: change.text } : {}) };
        if (change.done === true && !t.done) return { ...next, done: true, doneAt: at };
        if (change.done === false) {
          const { doneAt: _doneAt, ...open } = next;
          return { ...open, done: false };
        }
        return next;
      }),
      frameId,
    );
  }

  remove(sessionId: string, todoId: string, frameId?: string): TodosFrame {
    const list = this.require(sessionId, todoId);
    return this.apply(
      sessionId,
      list.filter((t) => t.id !== todoId),
      frameId,
    );
  }

  /**
   * A prompt was typed into the session. Its `<todo>` blocks of this session's to-dos are checked off when the turn it
   * starts ends.
   */
  prompted(sessionId: string, text: string): void {
    const list = this.lists.get(sessionId);
    if (!list) return;
    const ids = todoIdsIn(text).filter((id) => list.some((t) => t.id === id));
    if (ids.length === 0) return;
    this.sent.set(sessionId, { ids, started: false });
    const at = this.now().toISOString();
    this.apply(
      sessionId,
      list.map((t) => (ids.includes(t.id) ? { ...t, sentAt: at } : t)),
    );
  }

  private sessionUpdated(s: Session): void {
    const sent = this.sent.get(s.id);
    if (!sent) return;
    if (s.status === "working") {
      sent.started = true;
      return;
    }
    if (!sent.started) return;
    // A question is part of the turn; it goes on after the answer.
    if (s.status === "waiting" && s.waitingFor === "answer") return;
    this.sent.delete(s.id);
    const finished = s.status === "idle" || (s.status === "waiting" && (s.waitingFor ?? "done") === "done");
    if (!finished) return;
    const list = this.lists.get(s.id);
    if (!list) return;
    const at = this.now().toISOString();
    const next = list.map((t) => (sent.ids.includes(t.id) && !t.done ? { ...t, done: true, doneAt: at } : t));
    if (next.some((t, i) => t !== list[i])) {
      this.apply(s.id, next);
      this.log.info(`Checked off ${sent.ids.length === 1 ? "a to-do" : `${sent.ids.length} to-dos`} of ${s.id}: its turn ended`);
    }
  }

  private forget(sessionId: string): void {
    this.sent.delete(sessionId);
    if (this.lists.delete(sessionId)) this.save();
  }

  private require(sessionId: string, todoId: string): Todo[] {
    const list = this.lists.get(sessionId) ?? [];
    if (!list.some((t) => t.id === todoId)) throw new TodoError(`No to-do ${todoId} in this session.`);
    return list;
  }

  private apply(sessionId: string, next: Todo[], frameId?: string): TodosFrame {
    if (next.length === 0) this.lists.delete(sessionId);
    else this.lists.set(sessionId, next);
    this.save();
    this.registry.setTodos(sessionId, openTodos(next));
    const frame = this.frame(sessionId, frameId);
    this.emit("changed", frame);
    return frame;
  }

  private newId(): string {
    const taken = new Set([...this.lists.values()].flat().map((t) => t.id));
    for (;;) {
      const id = `td-${randomBytes(4).toString("hex")}`;
      if (!taken.has(id)) return id;
    }
  }

  private load(): void {
    if (!this.path || !existsSync(this.path)) return;
    try {
      const saved = JSON.parse(readFileSync(this.path, "utf8")) as { sessions?: unknown };
      if (typeof saved.sessions !== "object" || saved.sessions === null) return;
      for (const [id, todos] of Object.entries(saved.sessions as Record<string, unknown>)) {
        if (!Array.isArray(todos)) continue;
        const list = todos.flatMap((t) => {
          const parsed = Todo.safeParse(t);
          return parsed.success ? [parsed.data] : [];
        });
        if (list.length > 0) this.lists.set(id, list.slice(0, TODOS_MAX));
      }
    } catch (e) {
      this.log.warn("Could not read todos.json; to-do lists may be missing", { error: e });
    }
  }

  private save(): void {
    if (!this.path) return;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      writeFileSync(this.path, `${JSON.stringify({ sessions: Object.fromEntries(this.lists) }, null, 2)}\n`, { mode: 0o600 });
      chmodSync(this.path, 0o600);
    } catch (e) {
      this.log.warn("Could not save todos.json", { error: e });
    }
  }
}
