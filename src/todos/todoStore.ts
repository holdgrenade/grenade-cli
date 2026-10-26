/**
 * Projects' to-do lists (PROTOCOL.md "To-dos"), kept for every client. A list belongs to a project (Jeff, 2026-10-25:
 * to-dos moved up from the session): the folder its sessions share, as the canvas finds it (`groupCwdOf`), so every
 * session of the project sees one list, and it stays when they all end. Frames still name a session: the store acts on
 * that session's project, and after a change sends the list to every session of it. Follows the registry: a to-do sent
 * in a prompt (a `<todo>` block) is checked off when the turn that prompt started ends. Saved to todos.json (mode 0600)
 * so it survives a restart; lists kept by session and conversation before are merged into their project's.
 */
import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { type NewTodo, type Session, Todo, type TodosFrame, TODO_TITLE_MAX, TODOS_MAX, openTodos, todoIdsIn } from "@grenade/protocol";
import { groupCwdOf, normalizeCwd, projectOf } from "../canvas/canvasAccess.js";
import type { Logger } from "../log.js";

/** The slice of SessionRegistry the store follows. */
export interface TodoRegistry {
  list(): Session[];
  setTodos(id: string, open: number): void;
  on(event: "updated", cb: (s: Session) => void): unknown;
  on(event: "removed", cb: (id: string) => void): unknown;
  on(event: "created", cb: (s: Session) => void): unknown;
}

/** How long a list kept with a conversation (before lists were the project's) whose folder is not known waits for a session to resume it. */
export const KEPT_DAYS = 60;

/** A list kept with a conversation no session holds now, from before lists were the project's. */
interface Kept {
  todos: Todo[];
  keptAt: string;
}

export interface TodoStoreEvents {
  /** A session's list changed (its project's); the frame goes to every client. */
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

/** Two lists as one: the first's to-dos, then the second's it does not have, at most `TODOS_MAX`. */
function joined(first: readonly Todo[], second: readonly Todo[]): Todo[] {
  return [...first, ...second.filter((t) => !first.some((f) => f.id === t.id))].slice(0, TODOS_MAX);
}

export class TodoStore extends EventEmitter<TodoStoreEvents> {
  /** Each project's list, by its folder (or `session:<id>` for a session whose `cwd` is not a path). */
  private readonly lists = new Map<string, Todo[]>();
  private readonly sent = new Map<string, Sent>();
  /** Lists of removed sessions from before, by the id of the conversation they belong to. */
  private readonly kept = new Map<string, Kept>();
  /** Each session's project, as last told: a move to another (a group's folder changing) is followed. */
  private readonly projects = new Map<string, string>();

  constructor(
    private readonly registry: TodoRegistry,
    private readonly log: Logger,
    private readonly path?: string,
    private readonly now: () => Date = () => new Date(),
    private readonly home: string = homedir(),
    /** The folder a conversation was held in, from its transcript: a list kept with it joins that project's. */
    private readonly folderOf: (conversation: string) => string | undefined = () => undefined,
  ) {
    super();
    let changed = this.load();
    // Lists kept with a conversation, from before: into the project of the folder it was held in, when it is known.
    for (const [conversation, kept] of [...this.kept]) {
      const folder = this.folderOf(conversation);
      const cwd = folder ? normalizeCwd(folder, this.home) : null;
      if (!cwd) continue;
      const project = projectOf(cwd);
      this.lists.set(project, joined(this.lists.get(project) ?? [], kept.todos));
      this.kept.delete(conversation);
      changed = true;
      this.log.info(`Moved ${kept.todos.length === 1 ? "a to-do" : `${kept.todos.length} to-dos`} kept with a conversation into its project's`, { conversation, project });
    }
    const oldest = this.now().getTime() - KEPT_DAYS * 86_400_000;
    for (const [conversation, kept] of [...this.kept]) {
      if (Date.parse(kept.keptAt) < oldest) changed = this.kept.delete(conversation) || changed;
    }
    for (const s of registry.list()) changed = this.resume(s) || changed;
    for (const s of registry.list()) this.projects.set(s.id, this.projectOf(s));
    if (changed) this.save();
    for (const s of registry.list()) registry.setTodos(s.id, openTodos(this.lists.get(this.projectOf(s)) ?? []));
    registry.on("updated", (s) => {
      this.sessionUpdated(s);
      this.follow();
    });
    registry.on("removed", (id) => {
      this.sent.delete(id);
      this.projects.delete(id);
      this.follow();
    });
    registry.on("created", (s) => {
      if (this.resume(s)) this.save();
      this.follow();
    });
  }

  /** The lists kept with conversations from before, by conversation id (tests). */
  keptFor(conversation: string): Todo[] | undefined {
    return this.kept.get(conversation)?.todos;
  }

  /** A project's list, by its folder (tests). */
  listOf(project: string): Todo[] | undefined {
    return this.lists.get(project);
  }

  frame(sessionId: string, id?: string): TodosFrame {
    return { type: "todos", sessionId, ...(id ? { id } : {}), todos: [...(this.lists.get(this.projectOfId(sessionId)) ?? [])] };
  }

  add(sessionId: string, todos: NewTodo[], frameId?: string): TodosFrame {
    const project = this.projectOfId(sessionId);
    const list = this.lists.get(project) ?? [];
    if (list.length + todos.length > TODOS_MAX) throw new TodoError(`A project keeps at most ${TODOS_MAX} to-dos.`);
    const at = this.now().toISOString();
    // Which session it was added in, for a project's list to say (its title then, for when it is gone).
    const s = this.registry.list().find((x) => x.id === sessionId);
    const name = (s?.title ?? s?.name)?.slice(0, TODO_TITLE_MAX);
    const by = s ? { session: s.id, ...(name ? { sessionName: name } : {}) } : {};
    const added = todos.map((t): Todo => ({ id: this.newId(), title: t.title, text: t.text, done: false, at, ...(t.from ? { from: t.from } : {}), ...by }));
    return this.apply(project, [...list, ...added], sessionId, frameId);
  }

  update(sessionId: string, todoId: string, change: { done?: boolean | undefined; title?: string | undefined; text?: string | undefined }, frameId?: string): TodosFrame {
    const project = this.projectOfId(sessionId);
    const list = this.require(project, todoId);
    const at = this.now().toISOString();
    return this.apply(
      project,
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
      sessionId,
      frameId,
    );
  }

  remove(sessionId: string, todoId: string, frameId?: string): TodosFrame {
    const project = this.projectOfId(sessionId);
    const list = this.require(project, todoId);
    return this.apply(
      project,
      list.filter((t) => t.id !== todoId),
      sessionId,
      frameId,
    );
  }

  /**
   * A prompt was typed into the session. Its `<todo>` blocks of its project's to-dos are checked off when the turn it
   * starts ends.
   */
  prompted(sessionId: string, text: string): void {
    const project = this.projectOfId(sessionId);
    const list = this.lists.get(project);
    if (!list) return;
    const ids = todoIdsIn(text).filter((id) => list.some((t) => t.id === id));
    if (ids.length === 0) return;
    this.sent.set(sessionId, { ids, started: false });
    const at = this.now().toISOString();
    this.apply(
      project,
      list.map((t) => (ids.includes(t.id) ? { ...t, sentAt: at } : t)),
      sessionId,
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
    const project = this.projectOfId(s.id);
    const list = this.lists.get(project);
    if (!list) return;
    const at = this.now().toISOString();
    const next = list.map((t) => (sent.ids.includes(t.id) && !t.done ? { ...t, done: true, doneAt: at } : t));
    if (next.some((t, i) => t !== list[i])) {
      this.apply(project, next, s.id);
      this.log.info(`Checked off ${sent.ids.length === 1 ? "a to-do" : `${sent.ids.length} to-dos`} of ${s.id}: its turn ended`);
    }
  }

  /**
   * Sessions whose project changed (moved to another group, the group's shared folder changed with a new member) get
   * its list and count. A project no session is in any more hands its list on to the one its sessions went to, so a
   * group whose folder widens keeps its to-dos.
   */
  private follow(): void {
    const sessions = this.registry.list();
    const moved: { id: string; from: string | undefined; to: string }[] = [];
    for (const s of sessions) {
      const to = this.projectOf(s, sessions);
      const from = this.projects.get(s.id);
      if (from !== to) moved.push({ id: s.id, from, to });
      this.projects.set(s.id, to);
    }
    if (moved.length === 0) return;
    const held = new Set(this.projects.values());
    let changed = false;
    for (const { from, to } of moved) {
      const left = from !== undefined && from !== to && !held.has(from) ? this.lists.get(from) : undefined;
      if (!left) continue;
      this.lists.delete(from!);
      this.lists.set(to, joined(this.lists.get(to) ?? [], left));
      changed = true;
      this.log.info(`Moved a project's to-dos to its new folder`, { from, to });
    }
    if (changed) this.save();
    const touched = new Set(moved.map((m) => m.to));
    for (const s of sessions) {
      if (!touched.has(this.projects.get(s.id)!)) continue;
      this.registry.setTodos(s.id, openTodos(this.lists.get(this.projects.get(s.id)!) ?? []));
      this.emit("changed", this.frame(s.id));
    }
  }

  /** A session that resumes a conversation with a list kept from before brings it into its project's. Changed anything. */
  private resume(s: Session): boolean {
    const from = s.resumedFrom;
    const kept = from ? this.kept.get(from) : undefined;
    if (!from || !kept) return false;
    this.kept.delete(from);
    const project = this.projectOf(s);
    this.lists.set(project, joined(this.lists.get(project) ?? [], kept.todos));
    this.log.info(`${s.id} brought ${kept.todos.length === 1 ? "a to-do" : `${kept.todos.length} to-dos`} of the conversation it resumed into its project's`, { conversation: from });
    return true;
  }

  /** A session's project: the folder its group shares (`groupCwdOf`), else its own key. */
  private projectOf(s: Session, sessions: readonly Session[] = this.registry.list()): string {
    return groupCwdOf(s, sessions, this.home) ?? `session:${s.id}`;
  }

  private projectOfId(sessionId: string): string {
    const s = this.registry.list().find((x) => x.id === sessionId);
    return s ? this.projectOf(s) : (this.projects.get(sessionId) ?? `session:${sessionId}`);
  }

  private require(project: string, todoId: string): Todo[] {
    const list = this.lists.get(project) ?? [];
    if (!list.some((t) => t.id === todoId)) throw new TodoError(`No to-do ${todoId} in this project.`);
    return list;
  }

  /** The project's list is now `next`: saved, and sent to each of its sessions, the one that asked with `frameId`. */
  private apply(project: string, next: Todo[], sessionId: string, frameId?: string): TodosFrame {
    if (next.length === 0) this.lists.delete(project);
    else this.lists.set(project, next);
    this.save();
    const open = openTodos(next);
    const sessions = this.registry.list();
    for (const s of sessions) {
      if (s.id === sessionId || this.projectOf(s, sessions) !== project) continue;
      this.registry.setTodos(s.id, open);
      this.emit("changed", this.frame(s.id));
    }
    this.registry.setTodos(sessionId, open);
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

  /** Reads todos.json. Lists of sessions, from before, join their project's (or their conversation's). Changed anything. */
  private load(): boolean {
    if (!this.path || !existsSync(this.path)) return false;
    let changed = false;
    try {
      const saved = JSON.parse(readFileSync(this.path, "utf8")) as { projects?: unknown; sessions?: unknown; conversations?: unknown; kept?: unknown };
      const todosOf = (todos: unknown) =>
        Array.isArray(todos)
          ? todos.flatMap((t) => {
              const parsed = Todo.safeParse(t);
              return parsed.success ? [parsed.data] : [];
            }).slice(0, TODOS_MAX)
          : [];
      const entries = (value: unknown) => (typeof value === "object" && value !== null ? Object.entries(value as Record<string, unknown>) : []);
      for (const [project, todos] of entries(saved.projects)) {
        const list = todosOf(todos);
        if (list.length > 0) this.lists.set(project, list);
      }
      for (const [conversation, value] of entries(saved.kept)) {
        const kept = value as { todos?: unknown; keptAt?: unknown };
        const list = todosOf(kept?.todos);
        if (list.length > 0 && typeof kept.keptAt === "string") this.kept.set(conversation, { todos: list, keptAt: kept.keptAt });
      }
      // From before lists were the project's: each session's list joins its project's, in the order they were added;
      // a session no longer here keeps it with its conversation, as before, for a session that resumes it.
      const conversations = new Map(entries(saved.conversations).flatMap(([id, c]) => (typeof c === "string" ? [[id, c] as const] : [])));
      const sessions = this.registry.list();
      for (const [id, todos] of entries(saved.sessions)) {
        const list = todosOf(todos);
        if (list.length === 0) continue;
        changed = true;
        const s = sessions.find((x) => x.id === id);
        const conversation = conversations.get(id) ?? s?.resumedFrom;
        if (s) {
          const project = this.projectOf(s, sessions);
          this.lists.set(project, joined(this.lists.get(project) ?? [], list));
        } else if (conversation) {
          this.kept.set(conversation, { todos: joined(this.kept.get(conversation)?.todos ?? [], list), keptAt: this.now().toISOString() });
        }
      }
    } catch (e) {
      this.log.warn("Could not read todos.json; to-do lists may be missing", { error: e });
    }
    return changed;
  }

  private save(): void {
    if (!this.path) return;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const saved = {
        projects: Object.fromEntries(this.lists),
        ...(this.kept.size > 0 ? { kept: Object.fromEntries(this.kept) } : {}),
      };
      writeFileSync(this.path, `${JSON.stringify(saved, null, 2)}\n`, { mode: 0o600 });
      chmodSync(this.path, 0o600);
    } catch (e) {
      this.log.warn("Could not save todos.json", { error: e });
    }
  }
}
