/**
 * Sessions' to-do lists (PROTOCOL.md "To-dos"), kept for every client. Follows the registry: a to-do sent in a prompt
 * (a `<todo>` block) is checked off when the turn that prompt started ends. A list belongs to the session's
 * conversation (Jeff, 2026-10-21: ending a session and resuming its conversation lost its to-dos): a removed session's
 * list is kept with its conversation, and a session resuming that conversation takes it back; one never resumed goes
 * after `KEPT_DAYS`. Saved to todos.json (mode 0600) so it survives a restart.
 */
import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { conversationIdOf } from "../conversations/heldConversations.js";
import { type NewTodo, type Session, Todo, type TodosFrame, TODOS_MAX, openTodos, todoIdsIn } from "@grenade/protocol";
import type { Logger } from "../log.js";

/** The slice of SessionRegistry the store follows. */
export interface TodoRegistry {
  list(): Session[];
  setTodos(id: string, open: number): void;
  /** The transcript a session's hooks named: its conversation. */
  transcriptOf?(id: string): string | undefined;
  on(event: "updated", cb: (s: Session) => void): unknown;
  on(event: "removed", cb: (id: string) => void): unknown;
  on(event: "created", cb: (s: Session) => void): unknown;
}

/** How long a list waits with its conversation for a session to resume it. */
export const KEPT_DAYS = 60;

/** A list kept with a conversation no session holds now. */
interface Kept {
  todos: Todo[];
  /** When its session was removed. */
  keptAt: string;
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
  /** Lists of removed sessions, by the id of the conversation they belong to. */
  private readonly kept = new Map<string, Kept>();
  /** Each listed session's conversation, as last known, so a list outlives a restart that lost its session. */
  private readonly conversations = new Map<string, string>();

  constructor(
    private readonly registry: TodoRegistry,
    private readonly log: Logger,
    private readonly path?: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    super();
    this.load();
    // Lists of sessions that are no longer here are kept with their conversation (or go, with none known); lists kept
    // too long go; the rest show their count.
    const ids = new Set(registry.list().map((s) => s.id));
    let changed = false;
    for (const id of [...this.lists.keys()]) {
      if (!ids.has(id)) changed = this.keep(id) || changed;
    }
    const oldest = this.now().getTime() - KEPT_DAYS * 86_400_000;
    for (const [conversation, kept] of [...this.kept]) {
      if (Date.parse(kept.keptAt) < oldest) changed = this.kept.delete(conversation) || changed;
    }
    for (const s of registry.list()) changed = this.resume(s, false) || changed;
    if (changed) this.save();
    for (const [id, todos] of this.lists) registry.setTodos(id, openTodos(todos));
    registry.on("updated", (s) => this.sessionUpdated(s));
    registry.on("removed", (id) => this.forget(id));
    registry.on("created", (s) => {
      if (this.resume(s, true)) this.save();
    });
  }

  /** The lists kept with conversations, by conversation id (tests, and `grenade todo`). */
  keptFor(conversation: string): Todo[] | undefined {
    return this.kept.get(conversation)?.todos;
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

  /** A removed session's list stays with its conversation, for a session that resumes it. */
  private forget(sessionId: string): void {
    this.sent.delete(sessionId);
    if (this.keep(sessionId)) this.save();
  }

  /** Moves a session's list to its conversation (dropped when none is known). Changed anything. */
  private keep(sessionId: string): boolean {
    const list = this.lists.get(sessionId);
    const conversation = this.conversationOf(sessionId);
    this.conversations.delete(sessionId);
    if (!list) return false;
    this.lists.delete(sessionId);
    if (!conversation) return true;
    // Two sessions of one conversation (a copy resumed twice): the lists join, the older first.
    const before = this.kept.get(conversation)?.todos ?? [];
    this.kept.set(conversation, { todos: [...before, ...list.filter((t) => !before.some((b) => b.id === t.id))].slice(0, TODOS_MAX), keptAt: this.now().toISOString() });
    this.log.info(`Kept ${list.length === 1 ? "a to-do" : `${list.length} to-dos`} of ${sessionId} with its conversation`, { conversation });
    return true;
  }

  /** A session that resumes a conversation with a kept list takes it back. Changed anything. */
  private resume(s: Session, announce: boolean): boolean {
    const from = s.resumedFrom;
    const kept = from ? this.kept.get(from) : undefined;
    if (!from || !kept) return false;
    this.kept.delete(from);
    const list = this.lists.get(s.id) ?? [];
    const next = [...kept.todos, ...list.filter((t) => !kept.todos.some((k) => k.id === t.id))].slice(0, TODOS_MAX);
    this.lists.set(s.id, next);
    this.registry.setTodos(s.id, openTodos(next));
    if (announce) this.emit("changed", this.frame(s.id));
    this.log.info(`${s.id} took back ${kept.todos.length === 1 ? "a to-do" : `${kept.todos.length} to-dos`} of the conversation it resumed`, { conversation: from });
    return true;
  }

  /** A session's conversation: its transcript's, else the one it resumed, else the last known. */
  private conversationOf(sessionId: string): string | undefined {
    const transcript = this.registry.transcriptOf?.(sessionId);
    if (transcript) return conversationIdOf(transcript);
    return this.conversations.get(sessionId) ?? this.registry.list().find((s) => s.id === sessionId)?.resumedFrom;
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
      const saved = JSON.parse(readFileSync(this.path, "utf8")) as { sessions?: unknown; conversations?: unknown; kept?: unknown };
      const todosOf = (todos: unknown) =>
        Array.isArray(todos)
          ? todos.flatMap((t) => {
              const parsed = Todo.safeParse(t);
              return parsed.success ? [parsed.data] : [];
            }).slice(0, TODOS_MAX)
          : [];
      if (typeof saved.sessions === "object" && saved.sessions !== null) {
        for (const [id, todos] of Object.entries(saved.sessions as Record<string, unknown>)) {
          const list = todosOf(todos);
          if (list.length > 0) this.lists.set(id, list);
        }
      }
      if (typeof saved.conversations === "object" && saved.conversations !== null) {
        for (const [id, conversation] of Object.entries(saved.conversations as Record<string, unknown>)) {
          if (typeof conversation === "string") this.conversations.set(id, conversation);
        }
      }
      if (typeof saved.kept === "object" && saved.kept !== null) {
        for (const [conversation, value] of Object.entries(saved.kept as Record<string, unknown>)) {
          const kept = value as { todos?: unknown; keptAt?: unknown };
          const list = todosOf(kept?.todos);
          if (list.length > 0 && typeof kept.keptAt === "string") this.kept.set(conversation, { todos: list, keptAt: kept.keptAt });
        }
      }
    } catch (e) {
      this.log.warn("Could not read todos.json; to-do lists may be missing", { error: e });
    }
  }

  private save(): void {
    if (!this.path) return;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      // Each listed session's conversation, so its list is kept even if the session goes while the daemon is down.
      for (const id of this.lists.keys()) {
        const conversation = this.conversationOf(id);
        if (conversation) this.conversations.set(id, conversation);
      }
      for (const id of [...this.conversations.keys()]) if (!this.lists.has(id)) this.conversations.delete(id);
      const saved = {
        sessions: Object.fromEntries(this.lists),
        ...(this.conversations.size > 0 ? { conversations: Object.fromEntries(this.conversations) } : {}),
        ...(this.kept.size > 0 ? { kept: Object.fromEntries(this.kept) } : {}),
      };
      writeFileSync(this.path, `${JSON.stringify(saved, null, 2)}\n`, { mode: 0o600 });
      chmodSync(this.path, 0o600);
    } catch (e) {
      this.log.warn("Could not save todos.json", { error: e });
    }
  }
}
