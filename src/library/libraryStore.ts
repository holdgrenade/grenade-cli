/**
 * The Library (PROTOCOL.md "Library"): every canvas and plan on this computer, by project folder, whatever happened to
 * the group that made it. The store remembers what only the daemon sees (which session wrote which plan file, in which
 * folder and group, and where the plan got to; each group's folder and name, kept after the group ends) in
 * library.json, and reads the rest from disk: the canvases of every project folder it has known, and the plans' files.
 * Clients that asked are sent the list again when it changes, looked at every 5 s while one does.
 *
 * Like `src/canvas/`, it never writes outside its own file: the items point at files where they are.
 */
import { createReadStream } from "node:fs";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { lstat, readdir, readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { createInterface } from "node:readline";
import {
  CANVAS_SHARED,
  canvasNameOf,
  canvasNumberOf,
  PLAN_TEXT_MAX,
  planPreviewOf,
  planTitleOf,
  type KeptGroup,
  type LibraryFrame,
  type LibraryItem,
  type LibraryPlanFrame,
  type Session,
  type SessionPlan,
} from "@grenade/protocol";
import { canvasFolderOf, groupCwdOf, normalizeCwd, projectOf } from "../canvas/canvasAccess.js";
import { listCanvas, readHead, type HeadCache } from "../canvas/canvasFolder.js";
import type { Logger } from "../log.js";
import { canvasItem, cwdIn, libraryList, planFilesIn, planItem, type FoundCanvas, type FoundPlan, type GroupRecord, type GroupsNow, type PlanRecord } from "./libraryItems.js";

/** How often the store looks again while a client follows the list: boards saved and plans written fire no event. */
export const LIBRARY_POLL_MS = 5000;
/** A change is sent at most this often. */
export const LIBRARY_SETTLE_MS = 2000;
/** How long the past conversations' folders are trusted before they are read again. */
const PROJECTS_TTL_MS = 10 * 60 * 1000;
/** A transcript larger than this is not read for plan files (a backfill's only cost). */
const BACKFILL_FILE_MAX = 256 * 1024 * 1024;

/** Why `plan` refused, in a sentence for the user. */
export class LibraryError extends Error {}

export interface LibraryDeps {
  registry: {
    list(): Session[];
    on(event: "updated", cb: (s: Session) => void): unknown;
  };
  /** The groups kept with no session, and a way to hear when they change. */
  kept(): KeptGroup[];
  onKeptChanged(cb: () => void): void;
  /** Each session's plan (PROTOCOL.md "Plans") and its file's path. */
  plans: {
    on(event: "plan", cb: (sessionId: string, plan: SessionPlan | undefined) => void): unknown;
    pathOf(sessionId: string): string | undefined;
  };
  /** The folders of the agents' past conversations, as project folders may have canvases. */
  conversationFolders?(): Promise<string[]>;
  /** Claude Code's folder (`~/.claude`): its `plans` and its `projects` (the transcripts read once for old plans). */
  claudeDir: string;
  home: string;
  log: Logger;
  /** library.json; in memory when absent. */
  path?: string;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
  every?: (fn: () => void, ms: number) => () => void;
}

interface Saved {
  groups: GroupRecord[];
  plans: PlanRecord[];
  projects: string[];
  backfilled?: boolean;
}

const groupOf = (s: Session): string => s.group ?? s.id;

const realEvery = (fn: () => void, ms: number): (() => void) => {
  const t = setInterval(fn, ms);
  t.unref?.();
  return () => clearInterval(t);
};

export class LibraryStore {
  private readonly groups = new Map<string, GroupRecord>();
  private readonly plans = new Map<string, PlanRecord>();
  private readonly projects = new Set<string>();
  private backfilled = false;
  private readonly plansFolder: string;
  /** Whether each session was planning when last heard of: leaving plan mode with a file approves it. */
  private readonly planning = new Map<string, boolean>();

  private readonly watchers = new Set<(frame: LibraryFrame) => void>();
  private stopPoll: (() => void) | undefined;
  private settleTimer: unknown;
  private computing: Promise<LibraryItem[]> | undefined;
  private again = false;
  private lastKey = "";
  private items: LibraryItem[] = [];
  private truncated = false;
  private found: FoundCanvas[] = [];

  private readonly heads: HeadCache = new Map();
  private readonly firstHeads = new Map<string, string>();
  private readonly planTexts = new Map<string, { key: string; title: string; preview: string }>();
  private conversationProjects: { at: number; folders: string[] } | undefined;
  private saveTimer: unknown;

  constructor(private readonly d: LibraryDeps) {
    this.plansFolder = join(d.claudeDir, "plans");
    this.load();
    const sessions = d.registry.list();
    for (const s of sessions) {
      this.rememberSession(s, sessions);
      const path = d.plans.pathOf(s.id);
      if (path && s.plan?.file) this.recordPlan(s, path);
      this.planning.set(s.id, s.plan?.planning === true);
    }
    for (const k of d.kept()) this.rememberKept(k);
    this.save();
    d.registry.on("updated", (s) => {
      if (this.rememberSession(s, d.registry.list())) this.saveSoon();
      this.changed();
    });
    d.onKeptChanged(() => {
      for (const k of d.kept()) this.rememberKept(k);
      this.saveSoon();
      this.changed();
    });
    d.plans.on("plan", (id, plan) => this.planChanged(id, plan));
  }

  /** Reads the agents' past conversations once for the plans they wrote (in the background; a first start only). */
  async backfill(): Promise<void> {
    if (this.backfilled) return;
    const projectsDir = join(this.d.claudeDir, "projects");
    let found = 0;
    try {
      const folders = await readdir(projectsDir, { withFileTypes: true }).catch(() => []);
      for (const folder of folders) {
        if (!folder.isDirectory()) continue;
        const files = await readdir(join(projectsDir, folder.name), { withFileTypes: true }).catch(() => []);
        for (const f of files) {
          if (!f.isFile() || !f.name.endsWith(".jsonl")) continue;
          found += await this.backfillTranscript(join(projectsDir, folder.name, f.name));
        }
      }
    } catch (e) {
      this.d.log.warn("Could not read past conversations for plans", { error: e });
    }
    this.backfilled = true;
    this.save();
    if (found > 0) this.d.log.info(`Library: found ${found} plans in past conversations`);
    this.changed();
  }

  /** The list now, as `library` answers it. */
  async frame(id?: string): Promise<LibraryFrame> {
    await this.compute();
    return { type: "library", items: this.items, ...(this.truncated ? { truncated: true as const } : {}), ...(id !== undefined ? { id } : {}) };
  }

  /** A plan of the Library, its whole file. `LibraryError` for any other. */
  async plan(file: string, id?: string): Promise<LibraryPlanFrame> {
    if (!this.plans.has(file)) throw new LibraryError("That plan is not in the Library.");
    const path = join(this.plansFolder, file);
    const info = await lstat(path).catch(() => null);
    if (!info?.isFile()) throw new LibraryError("That plan's file is gone.");
    const text = await readFile(path, "utf8");
    return {
      type: "library.plan",
      plan: file,
      folder: this.plansFolder,
      text: text.length <= PLAN_TEXT_MAX ? text : text.slice(0, PLAN_TEXT_MAX),
      modified: info.mtime.toISOString(),
      ...(id !== undefined ? { id } : {}),
    };
  }

  /** Sends `send` the list whenever it changes, until the returned function is called. */
  watch(send: (frame: LibraryFrame) => void): () => void {
    this.watchers.add(send);
    if (!this.stopPoll) this.stopPoll = (this.d.every ?? realEvery)(() => this.changed(), LIBRARY_POLL_MS);
    return () => {
      this.watchers.delete(send);
      if (this.watchers.size === 0) {
        this.stopPoll?.();
        this.stopPoll = undefined;
      }
    };
  }

  /**
   * A stand-in session for each group the Library knows a canvas of, or remembers, with its folder: the canvas frames
   * serve them as a listed group's (PROTOCOL.md "Library", "A canvas").
   */
  standIns(): Session[] {
    const pairs = new Map<string, { group: string; cwd: string }>();
    for (const g of this.groups.values()) pairs.set(`${g.group}\n${g.cwd}`, g);
    for (const c of this.found) {
      const group = c.group ?? `library-${c.cwd}`;
      pairs.set(`${group}\n${c.cwd}`, { group, cwd: c.cwd });
    }
    return [...pairs.values()].map((p, i) => ({
      id: `library-${i}`,
      name: p.group,
      agent: "shell",
      cwd: p.cwd,
      status: "gone" as const,
      statusSince: new Date(0).toISOString(),
      lastLine: "",
      createdAt: new Date(0).toISOString(),
      group: p.group,
    }));
  }

  /**
   * A group the Library remembers, or knows a canvas of, that no session the daemon lists has: a session may be started
   * in it, as in a kept group, carrying the name it had (PROTOCOL.md "Library", "Starting again").
   */
  rememberedGroup(group: string): { name?: string } | undefined {
    if (this.d.registry.list().some((s) => groupOf(s) === group)) return undefined;
    const record = this.groups.get(group);
    if (record) return record.name ? { name: record.name } : {};
    return this.found.some((c) => c.group === group) ? {} : undefined;
  }

  /** Something may have changed: the list is worked out again (at most every 2 s) and sent when it did. */
  changed(): void {
    if (this.watchers.size === 0 || this.settleTimer !== undefined) return;
    const set = this.d.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms).unref());
    this.settleTimer = set(() => {
      this.settleTimer = undefined;
      void this.compute().then(() => {
        const key = JSON.stringify(this.items);
        if (key === this.lastKey) return;
        this.lastKey = key;
        const frame: LibraryFrame = { type: "library", items: this.items, ...(this.truncated ? { truncated: true as const } : {}) };
        for (const send of this.watchers) send(frame);
      });
    }, LIBRARY_SETTLE_MS);
  }

  // ---- finding ----------------------------------------------------------------

  private compute(): Promise<LibraryItem[]> {
    if (this.computing) {
      this.again = true;
      return this.computing;
    }
    this.computing = this.build()
      .catch((e: unknown) => {
        this.d.log.warn("Could not list the Library", { error: e });
        return this.items;
      })
      .finally(() => {
        this.computing = undefined;
        if (this.again) {
          this.again = false;
          void this.compute();
        }
      });
    return this.computing;
  }

  private async build(): Promise<LibraryItem[]> {
    const sessions = this.d.registry.list();
    const now: GroupsNow = { sessions, kept: this.d.kept(), remembered: this.groups };
    const found: FoundCanvas[] = [];
    for (const cwd of await this.projectFolders(sessions, now.kept)) found.push(...(await this.canvasesIn(cwd)));
    this.found = found;
    const planning = new Set(sessions.flatMap((s) => (s.status !== "gone" && s.plan?.planning && s.plan.file ? [s.plan.file] : [])));
    const plans: FoundPlan[] = [];
    for (const record of this.plans.values()) {
      const plan = await this.readPlan(record);
      if (plan) plans.push(plan);
    }
    const list = libraryList([...found.map((c) => canvasItem(c, now)), ...plans.map((p) => planItem(p, now, planning))]);
    this.items = list.items;
    this.truncated = list.truncated === true;
    return this.items;
  }

  /** Every project folder known: the sessions', the kept groups', those remembered, and the past conversations'. */
  private async projectFolders(sessions: Session[], kept: readonly KeptGroup[]): Promise<string[]> {
    const folders = new Set<string>(this.projects);
    for (const s of sessions) {
      const cwd = groupCwdOf(s, sessions, this.d.home);
      if (cwd) folders.add(cwd);
    }
    for (const k of kept) folders.add(k.cwd);
    for (const g of this.groups.values()) folders.add(g.cwd);
    for (const p of this.plans.values()) folders.add(p.cwd);
    for (const f of await this.pastConversationFolders()) folders.add(f);
    return [...folders];
  }

  private async pastConversationFolders(): Promise<string[]> {
    const source = this.d.conversationFolders;
    if (!source) return [];
    const cached = this.conversationProjects;
    if (cached && Date.now() - cached.at < PROJECTS_TTL_MS) return cached.folders;
    const folders = new Set<string>();
    try {
      for (const cwd of await source()) {
        const normalized = normalizeCwd(cwd, this.d.home);
        if (normalized) folders.add(projectOf(normalized));
      }
    } catch (e) {
      this.d.log.debug("Could not list past conversations' folders", { error: e instanceof Error ? e.message : String(e) });
    }
    this.conversationProjects = { at: Date.now(), folders: [...folders] };
    return this.conversationProjects.folders;
  }

  /** The canvases with boards under one project folder: each group folder's `canvas-<n>`, then `shared`. */
  private async canvasesIn(cwd: string): Promise<FoundCanvas[]> {
    const root = canvasFolderOf(cwd);
    const rootInfo = await lstat(root).catch(() => null);
    if (!rootInfo?.isDirectory()) return [];
    const out: FoundCanvas[] = [];
    const groups = await readdir(root, { withFileTypes: true }).catch(() => []);
    for (const g of groups) {
      if (!g.isDirectory() || g.name.startsWith(".")) continue;
      const canvases = await readdir(join(root, g.name), { withFileTypes: true }).catch(() => []);
      for (const c of canvases) {
        if (!c.isDirectory() || canvasNumberOf(c.name) === null) continue;
        const canvas = await this.canvasAt(join(root, g.name, c.name), cwd, c.name, g.name);
        if (canvas) out.push(canvas);
      }
    }
    const shared = await this.canvasAt(root, cwd, CANVAS_SHARED);
    if (shared) out.push(shared);
    return out;
  }

  private async canvasAt(folder: string, cwd: string, canvas: string, group?: string): Promise<FoundCanvas | null> {
    const listing = await listCanvas(folder, this.heads).catch(() => null);
    if (!listing || listing.boards.length === 0) return null;
    const first = listing.boards[0]!;
    const headKey = `${folder}/${first.file}\n${first.modified}\n${first.bytes}`;
    let head = this.firstHeads.get(headKey);
    if (head === undefined) {
      head = await readHead(folder, first.file);
      this.firstHeads.set(headKey, head);
    }
    const modifiedMs = Math.max(...listing.boards.map((b) => Date.parse(b.modified)));
    return { folder, cwd, ...(group ? { group } : {}), canvas, title: canvasNameOf(canvas, { file: first.file, head }), files: listing.boards.map((b) => b.file), modifiedMs };
  }

  private async readPlan(record: PlanRecord): Promise<FoundPlan | null> {
    const path = join(this.plansFolder, record.file);
    const info = await lstat(path).catch(() => null);
    if (!info?.isFile()) return null;
    const key = `${info.mtimeMs}\n${info.size}`;
    let text = this.planTexts.get(record.file);
    if (text?.key !== key) {
      const body = await readFile(path, "utf8").catch(() => null);
      if (body === null) return null;
      text = { key, title: planTitleOf(body, record.file), preview: planPreviewOf(body) };
      this.planTexts.set(record.file, text);
    }
    return { record, title: text.title, preview: text.preview, modifiedMs: info.mtimeMs };
  }

  // ---- remembering ------------------------------------------------------------

  /** Keeps a live session's group, folder and name; true when that changed what is kept. */
  private rememberSession(s: Session, sessions: Session[]): boolean {
    if (s.status === "gone" || s.id.startsWith("kept-")) return false;
    const cwd = groupCwdOf(s, sessions, this.d.home);
    if (!cwd) return false;
    const group = groupOf(s);
    const before = this.groups.get(group);
    const after: GroupRecord = { group, cwd, ...(s.groupName ? { name: s.groupName } : {}) };
    this.projects.add(cwd);
    if (before && before.cwd === after.cwd && before.name === after.name) return false;
    this.groups.set(group, after);
    return true;
  }

  private rememberKept(k: KeptGroup): void {
    this.groups.set(k.group, { group: k.group, cwd: k.cwd, ...(k.name ? { name: k.name } : {}) });
    this.projects.add(k.cwd);
  }

  private planChanged(sessionId: string, plan: SessionPlan | undefined): void {
    const session = this.d.registry.list().find((s) => s.id === sessionId);
    const path = this.d.plans.pathOf(sessionId);
    const was = this.planning.get(sessionId) === true;
    this.planning.set(sessionId, plan?.planning === true);
    if (!session || !path || !plan?.file) {
      this.changed();
      return;
    }
    const record = this.recordPlan(session, path);
    if (record) {
      // The agent left plan mode with this plan: it was approved (in the app or in the terminal).
      if (was && !plan.planning) record.state = "approved";
      else if (plan.planning) record.state = "draft";
      this.saveSoon();
    }
    this.changed();
  }

  private recordPlan(s: Session, path: string): PlanRecord | undefined {
    if (dirname(path) !== this.plansFolder) return undefined;
    const file = basename(path);
    const cwd = groupCwdOf(s, this.d.registry.list(), this.d.home);
    if (!cwd) return undefined;
    const before = this.plans.get(file);
    const session = s.title ?? s.name;
    const record: PlanRecord = { ...before, file, cwd, group: groupOf(s), ...(session ? { session } : {}) };
    this.plans.set(file, record);
    this.projects.add(cwd);
    return record;
  }

  /** The plan files one transcript names, kept with its folder unless a session's record has them. */
  private async backfillTranscript(path: string): Promise<number> {
    const info = await lstat(path).catch(() => null);
    if (!info?.isFile() || info.size > BACKFILL_FILE_MAX) return 0;
    let cwd: string | undefined;
    const files = new Set<string>();
    const lines = createInterface({ input: createReadStream(path, { encoding: "utf8" }), crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        if (cwd === undefined && line.includes('"cwd"')) cwd = cwdIn(line);
        if (line.includes("/plans/")) for (const f of planFilesIn(line, this.plansFolder)) files.add(f);
      }
    } catch {
      return 0;
    }
    const project = cwd ? normalizeCwd(cwd, this.d.home) : null;
    if (!project) return 0;
    let added = 0;
    for (const file of files) {
      if (this.plans.has(file)) continue;
      this.plans.set(file, { file, cwd: projectOf(project) });
      added++;
    }
    if (added > 0) this.projects.add(projectOf(project));
    return added;
  }

  // ---- keeping ----------------------------------------------------------------

  private load(): void {
    if (!this.d.path || !existsSync(this.d.path)) return;
    try {
      const saved = JSON.parse(readFileSync(this.d.path, "utf8")) as Partial<Saved>;
      for (const g of saved.groups ?? []) if (typeof g?.group === "string" && typeof g.cwd === "string") this.groups.set(g.group, g);
      for (const p of saved.plans ?? []) if (typeof p?.file === "string" && typeof p.cwd === "string") this.plans.set(p.file, p);
      for (const f of saved.projects ?? []) if (typeof f === "string") this.projects.add(f);
      this.backfilled = saved.backfilled === true;
    } catch (e) {
      this.d.log.warn("Could not read library.json; the Library starts over", { error: e });
    }
  }

  private saveSoon(): void {
    if (!this.d.path || this.saveTimer !== undefined) return;
    const set = this.d.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms).unref());
    this.saveTimer = set(() => {
      this.saveTimer = undefined;
      this.save();
    }, 1000);
  }

  private save(): void {
    if (!this.d.path) return;
    const saved: Saved = { groups: [...this.groups.values()], plans: [...this.plans.values()], projects: [...this.projects], backfilled: this.backfilled };
    try {
      mkdirSync(dirname(this.d.path), { recursive: true });
      writeFileSync(this.d.path, `${JSON.stringify(saved, null, 2)}\n`, { mode: 0o600 });
      chmodSync(this.d.path, 0o600);
    } catch (e) {
      this.d.log.warn("Could not save library.json", { error: e });
    }
  }

  /** Stops looking and saves what is kept. */
  stop(): void {
    this.stopPoll?.();
    this.stopPoll = undefined;
    if (this.saveTimer !== undefined) (this.d.clearTimer ?? ((t) => clearTimeout(t as NodeJS.Timeout)))(this.saveTimer);
    if (this.settleTimer !== undefined) (this.d.clearTimer ?? ((t) => clearTimeout(t as NodeJS.Timeout)))(this.settleTimer);
    this.save();
  }
}
