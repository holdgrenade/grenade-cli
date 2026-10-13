/**
 * CanvasWork (PROTOCOL.md "The canvas card"): the record of which session saved which board in which turn, and the
 * `canvas` activity entries a turn ends with. Command Center's `board` tiles come from the same record
 * (`savedBoards`), so a session's card and its Command Center row show the same boards.
 *
 * A turn runs from the session becoming `working` to its leaving `working` for anything but a question
 * (`waitingFor: "answer"`). When it starts, the save time of every board on the group's canvases is noted; while it
 * runs, the hooks name the boards the agent wrote (`hook`); when it ends, the canvases are read again and
 * `boardsOfTurn` says which boards were the session's. Nothing here writes: the canvas is only read.
 */
import { boardTitleOf, canvasCardTitleOf, type ActivityEntry, type Session } from "@grenade/protocol";
import { posix } from "node:path";
import type { Logger } from "../log.js";
import { canvasFolderOf, groupCwdOf, groupFolderOf } from "./canvasAccess.js";
import { boardsOfTurn, boardPlaceOf, canvasEntriesOf, workedDuring, writtenPathsOf, type BoardOnDisk, type SavedBoard } from "./boardSaves.js";
import { boardsOnDisk, canvasInfoOf, readHead } from "./canvasFolder.js";

/** The most boards kept in one session's record, for Command Center. */
export const RECORD_KEEP = 200;
/** How long a session's working spans are kept, to say whether it worked during another's turn. */
export const SPANS_KEEP_MS = 24 * 3_600_000;

/** A board the record says a session saved, with its canvas's address and when it was saved. */
export interface RecordedBoard {
  cwd: string;
  group: string;
  canvas: string;
  file: string;
  /** The canvas's folder, to read the board's head from. */
  folder: string;
  /** When it was last saved in the turn, ISO 8601. */
  at: string;
}

export interface CanvasWorkDeps {
  registry: { get(id: string): Session | undefined; list(): Session[] };
  activity: { noteCanvas(id: string, entries: ActivityEntry[], turnStart: number): void };
  home: string;
  log: Logger;
  now?: () => number;
  /** For tests: what is on a group's canvases. */
  scan?: (groupFolder: string, sharedFolder: string) => Promise<BoardOnDisk[]>;
}

interface Turn {
  start: number;
  /** The boards there when it started; null while not read yet, or when the daemon did not see it start. */
  before: Map<string, number> | null;
  hooked: Map<string, number>;
  /** The read of the boards at the start. */
  reading: Promise<void>;
}

export class CanvasWork {
  private readonly turns = new Map<string, Turn>();
  private readonly working = new Set<string>();
  private readonly spans = new Map<string, { from: number; to: number | null }[]>();
  private readonly record = new Map<string, RecordedBoard[]>();
  /** Sessions whose newest turn a hook saw save a board: kept after the turn ends, until the next one starts. */
  private readonly drew = new Set<string>();
  private readonly now: () => number;
  private readonly scan: (groupFolder: string, sharedFolder: string) => Promise<BoardOnDisk[]>;
  /** The ends of turns still being read, for tests and a clean stop. */
  private readonly ending = new Set<Promise<void>>();

  constructor(private readonly d: CanvasWorkDeps) {
    this.now = d.now ?? Date.now;
    this.scan = d.scan ?? boardsOnDisk;
    // A session working when the daemon starts is in a turn it did not see start.
    for (const s of d.registry.list()) {
      if (s.status !== "working") continue;
      this.working.add(s.id);
      this.spans.set(s.id, [{ from: this.now(), to: null }]);
      this.turns.set(s.id, { start: this.now(), before: null, hooked: new Map(), reading: Promise.resolve() });
    }
  }

  /** A session changed: a turn starts when it starts working, and ends when it stops for anything but a question. */
  statusChanged(s: Session): void {
    const now = this.now();
    if (s.status === "working") {
      if (!this.working.has(s.id)) {
        this.working.add(s.id);
        this.spans.set(s.id, [...(this.spans.get(s.id) ?? []).filter((x) => x.to === null || x.to >= now - SPANS_KEEP_MS), { from: now, to: null }]);
      }
      if (!this.turns.has(s.id)) {
        this.drew.delete(s.id);
        this.openTurn(s, now);
      }
      return;
    }
    if (this.working.delete(s.id)) {
      for (const span of this.spans.get(s.id) ?? []) if (span.to === null) span.to = now;
    }
    const asking = s.status === "waiting" && s.waitingFor === "answer";
    if (!asking && this.turns.has(s.id)) this.closeTurn(s, now);
  }

  /** A hook of the session's agent: the boards a tool wrote are the session's. */
  hook(sessionId: string, event: unknown, toolName: unknown, toolInput: unknown, cwd: string | undefined): void {
    const session = this.d.registry.get(sessionId);
    if (!session) return;
    const paths = writtenPathsOf(event, toolName, toolInput, cwd ?? session.cwd).filter((p) => boardPlaceOf(p) !== null);
    if (paths.length === 0) return;
    const now = this.now();
    let turn = this.turns.get(sessionId);
    if (!turn) {
      turn = { start: now, before: null, hooked: new Map(), reading: Promise.resolve() };
      this.turns.set(sessionId, turn);
    }
    for (const p of paths) if (!turn.hooked.has(p)) turn.hooked.set(p, now);
    this.drew.add(sessionId);
  }

  /** Whether the session's newest turn saved a board, as its hooks said (PROTOCOL.md "Session", `turn`). */
  drawing(sessionId: string): boolean {
    return this.drew.has(sessionId);
  }

  /** The boards the record says a session saved between `from` and `to` (ms), oldest first. */
  savedBoards(sessionId: string, from: number, to: number): RecordedBoard[] {
    return (this.record.get(sessionId) ?? []).filter((b) => {
      const at = Date.parse(b.at);
      return at >= from && at <= to;
    });
  }

  /** The session is gone. */
  forget(id: string): void {
    this.drew.delete(id);
    this.turns.delete(id);
    this.working.delete(id);
    this.spans.delete(id);
    this.record.delete(id);
  }

  /** Resolves once every turn that has ended is read and its entries are out. */
  async settled(): Promise<void> {
    while (this.ending.size > 0) await Promise.all([...this.ending]);
  }

  private openTurn(s: Session, now: number): void {
    const turn: Turn = { start: now, before: null, hooked: new Map(), reading: Promise.resolve() };
    const place = this.placeOf(s);
    turn.reading = place
      ? this.scan(place.groupFolder, place.sharedFolder)
          .then((boards) => {
            turn.before = new Map(boards.map((b) => [b.path, b.mtimeMs]));
          })
          .catch((e) => this.d.log.debug("Could not read a group's canvases at a turn's start", { session: s.id, error: e }))
      : Promise.resolve();
    this.turns.set(s.id, turn);
  }

  private closeTurn(s: Session, end: number): void {
    const turn = this.turns.get(s.id);
    if (!turn) return;
    this.turns.delete(s.id);
    const done = this.endTurn(s, turn, end)
      .catch((e) => this.d.log.debug("Could not read a turn's boards", { session: s.id, error: e }))
      .finally(() => this.ending.delete(done));
    this.ending.add(done);
  }

  private async endTurn(s: Session, turn: Turn, end: number): Promise<void> {
    await turn.reading;
    const place = this.placeOf(s);
    if (!place) return;
    const onDisk = await this.scan(place.groupFolder, place.sharedFolder);
    const others = this.d.registry.list().filter((o) => o.id !== s.id && (o.group ?? o.id) === place.group);
    const othersWorked = others.some((o) => workedDuring(this.spans.get(o.id) ?? [], turn.start, end));
    const saved = boardsOfTurn({ start: turn.start, end, hooked: turn.hooked, before: turn.before }, onDisk, othersWorked);
    // A session removed while its turn was read keeps no record.
    if (saved.length === 0 || !this.d.registry.get(s.id)) return;
    this.remember(s.id, place, saved);
    const folderOf = (canvas: string) => posix.dirname(saved.find((b) => b.canvas === canvas)!.path);
    const names = new Map<string, string>();
    for (const canvas of new Set(saved.map((b) => b.canvas))) names.set(canvas, (await canvasInfoOf(folderOf(canvas), canvas)).name);
    const titles = new Map<string, string>();
    for (const b of saved) titles.set(b.path, canvasCardTitleOf(b.file, boardTitleOf(await readHead(posix.dirname(b.path), b.file))));
    const entries = canvasEntriesOf(saved, {
      cwd: place.cwd,
      group: place.group,
      at: new Date(end).toISOString(),
      nameOf: (canvas) => names.get(canvas)!,
      titleOf: (path) => titles.get(path)!,
    });
    this.d.activity.noteCanvas(s.id, entries, turn.start);
    this.d.log.info("A turn saved boards on its group's canvas", { session: s.id, boards: saved.length, canvases: entries.length });
  }

  private remember(id: string, place: { cwd: string; group: string }, saved: readonly SavedBoard[]): void {
    const boards = saved.map((b): RecordedBoard => ({ cwd: place.cwd, group: place.group, canvas: b.canvas, file: b.file, folder: posix.dirname(b.path), at: new Date(b.mtimeMs).toISOString() }));
    this.record.set(id, [...(this.record.get(id) ?? []), ...boards].slice(-RECORD_KEEP));
  }

  /** Where a session's group's canvases are: the folder it shares, its group, and the folders to read. */
  private placeOf(s: Session): { cwd: string; group: string; groupFolder: string; sharedFolder: string } | null {
    const cwd = groupCwdOf(s, this.d.registry.list(), this.d.home);
    if (!cwd) return null;
    const group = s.group ?? s.id;
    return { cwd, group, groupFolder: groupFolderOf(cwd, group), sharedFolder: canvasFolderOf(cwd) };
  }
}
