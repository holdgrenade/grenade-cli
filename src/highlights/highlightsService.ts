/**
 * HighlightsService (PROTOCOL.md "Highlights"): once a session's turn has finished, finds what the turn made and puts
 * it on the feed's `finished` row. Everything comes from what the daemon already has: the boards saved on the group's
 * canvas in the turn (`src/canvas`), the pictures the agent took or was shown (its transcript, `transcriptPictures.ts`),
 * the pictures the owner sent (`attachments/<session>`), the push (`push` activity entries), and the turn's words from
 * the activity (`highlightWords.ts`). No model is asked anything. Copies of pictures live in `PictureStore`.
 *
 * Timing: the `finished` row is written by the feed at once; `HIGHLIGHTS_DELAY_MS` later this looks, and when it found
 * something the row is written again with `highlights` (`TalkService.setHighlights`), which every watching client gets
 * as a `talk.entry` and replaces. A turn's start is noted from the hook's prompt or the thread's own send, with the
 * transcript's size then, so only the turn's lines are read.
 */
import { stat } from "node:fs/promises";
import { open, readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { boardNameOf, boardTitleOf, type ActivityEntry, type HighlightTile, type Highlights, type Session, type TalkEntry } from "@grenade/protocol";
import { canvasFolderOf, groupFolderOf, normalizeCwd, projectOf, sharedFolder } from "../canvas/canvasAccess.js";
import { listCanvas, listCanvases, readHead } from "../canvas/canvasFolder.js";
import type { Logger } from "../log.js";
import { gatherHighlights, shippedTiles } from "./gatherHighlights.js";
import { highlightIdOf } from "./highlightId.js";
import { captionFor, entriesInTurn, firstLine } from "./highlightWords.js";
import type { KeptPicture, PictureStore } from "./pictureStore.js";
import { isPicturePath, picturesIn } from "./transcriptPictures.js";

/** How long after a `finished` row the turn is looked at: the transcript, the canvas and git have settled by then. */
export const HIGHLIGHTS_DELAY_MS = 20_000;
/** Transcript times, file times and the daemon's clock may differ a little. */
export const WINDOW_SLACK_MS = 3_000;
/** The most screenshots of the agent's kept from one turn. */
export const SCREENS_MAX = 12;
/** The most pictures of the owner's kept from one turn. */
export const YOURS_MAX = 6;
/** The most boards taken from one turn. */
export const BOARDS_MAX = 18;
/** How often kept pictures are pruned. */
export const PRUNE_EVERY_MS = 24 * 3_600_000;

export interface HighlightsDeps {
  registry: { get(id: string): Session | undefined; list(): Session[]; transcriptOf(id: string): string | undefined };
  entriesOf(id: string): ActivityEntry[];
  talk: { setHighlights(rowId: string, highlights: Highlights | undefined): TalkEntry | undefined; row(id: string): TalkEntry | undefined };
  pictures: PictureStore;
  /** `<GRENADE_HOME>/attachments`. */
  attachmentsDir: string;
  home: string;
  log: Logger;
  now?: () => number;
  /** For tests: run the look at once instead of after the delay. */
  delayMs?: number;
}

interface TurnStart {
  at: number;
  /** The transcript's size when the turn started, so only its lines are read. */
  offset: number | undefined;
}

export class HighlightsService {
  private readonly starts = new Map<string, TurnStart>();
  private readonly pending = new Map<string, NodeJS.Timeout>();
  private readonly pruneTimer: NodeJS.Timeout;
  private readonly now: () => number;

  constructor(private readonly d: HighlightsDeps) {
    this.now = d.now ?? Date.now;
    this.pruneTimer = setInterval(() => void this.prune(), PRUNE_EVERY_MS);
    this.pruneTimer.unref();
    void this.prune();
  }

  stop(): void {
    clearInterval(this.pruneTimer);
    for (const t of this.pending.values()) clearTimeout(t);
    this.pending.clear();
  }

  /** A turn starts (a hook's prompt, or the thread's own send): remember when, and how long the transcript was. */
  turnStarted(sessionId: string): void {
    const at = this.now();
    const path = this.d.registry.transcriptOf(sessionId);
    this.starts.set(sessionId, { at, offset: undefined });
    if (!path) return;
    stat(path)
      .then((st) => {
        const start = this.starts.get(sessionId);
        if (start && start.at === at) start.offset = st.size;
      })
      .catch(() => {});
  }

  /** A row of the thread: a `finished` row of a session is looked at after the delay; a `sent` or `started` starts a turn. */
  onEntry(entry: TalkEntry): void {
    if (!entry.session) return;
    if (entry.kind === "sent" || entry.kind === "started") return this.turnStarted(entry.session);
    if (entry.kind !== "finished" || entry.highlights) return;
    const session = entry.session;
    const timer = setTimeout(() => {
      this.pending.delete(session);
      void this.look(entry).catch((e) => this.d.log.debug("Could not gather a turn's highlights", { session, error: e }));
    }, this.d.delayMs ?? HIGHLIGHTS_DELAY_MS);
    timer.unref?.();
    this.pending.get(session)?.unref?.();
    clearTimeout(this.pending.get(session));
    this.pending.set(session, timer);
  }

  /** A kept picture for `highlight.image`, or null. */
  image(id: string) {
    return this.d.pictures.read(id);
  }

  /** Takes a tile out of a row and forgets its copy (PROTOCOL.md "Highlights", `highlight.remove`). False when the row or tile is not here. */
  async remove(rowId: string, highlightId: string): Promise<boolean> {
    const row = this.d.talk.row(rowId);
    const tile = row?.highlights?.tiles.find((t) => t.id === highlightId);
    if (!row?.highlights || !tile) return false;
    const tiles = row.highlights.tiles.filter((t) => t.id !== highlightId);
    this.d.talk.setHighlights(rowId, tiles.length > 0 ? { ...row.highlights, tiles } : undefined);
    if (tile.kind === "screen" || tile.kind === "yours") await this.d.pictures.remove(highlightId);
    return true;
  }

  /** The look itself: the turn's window, then each source. Exposed for tests. */
  async look(entry: TalkEntry): Promise<Highlights | null> {
    const sessionId = entry.session!;
    const session = this.d.registry.get(sessionId);
    if (!session) return null;
    const finishedAt = Date.parse(entry.at);
    const start = this.starts.get(sessionId);
    const all = this.d.entriesOf(sessionId);
    const from = this.turnFrom(start, all, finishedAt);
    if (from === undefined) return null;
    this.starts.delete(sessionId);
    const fromIso = new Date(from - WINDOW_SLACK_MS).toISOString();
    const toIso = new Date(finishedAt + WINDOW_SLACK_MS).toISOString();
    const turn = entriesInTurn(all, fromIso, toIso);
    const found: HighlightTile[] = [];
    found.push(...(await this.boards(session, fromIso, toIso).catch(() => [])));
    found.push(...(await this.screens(sessionId, start?.offset, fromIso, toIso, turn).catch(() => [])));
    found.push(...(await this.yours(sessionId, fromIso, toIso, turn).catch(() => [])));
    found.push(...shippedTiles(turn, highlightIdOf));
    const highlights = gatherHighlights(found, turn);
    if (!highlights) return null;
    // The row may have been replaced (a fold on the daemon's side never happens; a restart may have re-read it): set by id.
    this.d.talk.setHighlights(entry.id, highlights);
    this.d.log.info("A turn's highlights are on its row", { session: sessionId, tiles: highlights.tiles.length, words: highlights.words.length });
    return highlights;
  }

  /** When the turn began: what was noted, else the newest `asked` before the finish, else nothing to look at. */
  private turnFrom(start: TurnStart | undefined, entries: readonly ActivityEntry[], finishedAt: number): number | undefined {
    if (start && start.at <= finishedAt) return start.at;
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i]!;
      const at = Date.parse(e.at);
      if (e.kind === "asked" && at <= finishedAt + WINDOW_SLACK_MS) return at;
    }
    return undefined;
  }

  /** The boards saved on the group's canvases in the window, each with its address for `canvas.board`. */
  private async boards(session: Session, from: string, to: string): Promise<HighlightTile[]> {
    const members = this.d.registry.list().filter((s) => s.group === session.group);
    const cwds = members.map((s) => normalizeCwd(s.cwd, this.d.home)).flatMap((c) => (c ? [projectOf(c)] : []));
    const own = normalizeCwd(session.cwd, this.d.home);
    const cwd = (cwds.length > 1 ? sharedFolder(cwds) : null) ?? (own ? projectOf(own) : null);
    if (!cwd || !session.group) return [];
    const group = session.group;
    const groupFolder = groupFolderOf(cwd, group);
    const canvases = await listCanvases(groupFolder, canvasFolderOf(cwd));
    const start = Date.parse(from);
    const end = Date.parse(to);
    const tiles: HighlightTile[] = [];
    for (const info of canvases) {
      const folder = info.canvas === "shared" ? canvasFolderOf(cwd) : join(groupFolder, info.canvas);
      const { boards } = await listCanvas(folder);
      for (const board of boards) {
        const modified = Date.parse(board.modified);
        if (modified < start || modified > end) continue;
        const head = await readHead(folder, board.file);
        tiles.push({
          id: highlightIdOf(`board:${folder}/${board.file}`),
          kind: "board",
          at: board.modified,
          caption: (boardTitleOf(head) ?? boardNameOf(board.file).name).slice(0, 200),
          cwd,
          group,
          canvas: info.canvas,
          file: board.file,
        });
        if (tiles.length >= BOARDS_MAX) return tiles;
      }
    }
    return tiles;
  }

  /** The pictures the agent took or was shown in the window, kept as copies. */
  private async screens(sessionId: string, offset: number | undefined, from: string, to: string, turn: readonly ActivityEntry[]): Promise<HighlightTile[]> {
    const path = this.d.registry.transcriptOf(sessionId);
    if (!path || !this.d.pictures.canKeep) return [];
    const jsonl = await readFrom(path, offset ?? 0);
    const tiles: HighlightTile[] = [];
    const seen = new Set<string>();
    for (const picture of picturesIn(jsonl, from, to)) {
      let kept: KeptPicture | null = null;
      let name = "A screenshot";
      if (picture.kind === "path") {
        if (!isPicturePath(picture.path)) continue;
        name = basename(picture.path);
        kept = await this.d.pictures.keepFile(picture.path, sessionId, picture.at);
      } else {
        kept = await this.d.pictures.keepBytes(Buffer.from(picture.data, "base64"), sessionId, picture.at);
      }
      if (!kept || seen.has(kept.id)) continue;
      seen.add(kept.id);
      tiles.push({ id: kept.id, kind: "screen", at: picture.at, caption: captionFor(picture.at, turn, name), mime: kept.mime, width: kept.width, height: kept.height });
      if (tiles.length >= SCREENS_MAX) break;
    }
    return tiles;
  }

  /** The pictures the owner sent the session in the window (PROTOCOL.md "Attachments"), kept as copies. */
  private async yours(sessionId: string, from: string, to: string, turn: readonly ActivityEntry[]): Promise<HighlightTile[]> {
    if (!this.d.pictures.canKeep) return [];
    const folder = join(this.d.attachmentsDir, sessionId);
    const names = await readdir(folder).catch(() => [] as string[]);
    const start = Date.parse(from);
    const end = Date.parse(to);
    const tiles: HighlightTile[] = [];
    for (const name of names.sort()) {
      if (!isPicturePath(name)) continue;
      const path = join(folder, name);
      const st = await stat(path).catch(() => null);
      if (!st?.isFile() || st.mtimeMs < start || st.mtimeMs > end) continue;
      const at = new Date(st.mtimeMs).toISOString();
      const kept = await this.d.pictures.keepFile(path, sessionId, at);
      if (!kept) continue;
      // The prompt it went with names its path; else the first prompt after it.
      const prompt = turn.find((e) => e.kind === "asked" && e.text.includes(name)) ?? turn.find((e) => e.kind === "asked" && Date.parse(e.at) >= st.mtimeMs);
      tiles.push({ id: kept.id, kind: "yours", at, caption: firstLine(prompt?.text ?? name), mime: kept.mime, width: kept.width, height: kept.height });
      if (tiles.length >= YOURS_MAX) break;
    }
    return tiles;
  }

  private async prune(): Promise<void> {
    const removed = await this.d.pictures.prune().catch(() => 0);
    if (removed > 0) this.d.log.debug("Pruned kept highlight pictures", { removed });
  }
}

/** The bytes of a file from `offset` to its end, as UTF-8. Whole lines are the caller's business. */
async function readFrom(path: string, offset: number): Promise<string> {
  const file = await open(path, "r");
  try {
    const { size } = await file.stat();
    const start = Math.min(offset, size);
    if (size === start) return "";
    const buffer = Buffer.alloc(size - start);
    await file.read(buffer, 0, buffer.length, start);
    return buffer.toString("utf8");
  } finally {
    await file.close();
  }
}
