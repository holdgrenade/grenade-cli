/**
 * ShowreelService (PROTOCOL.md "Showreel"): the `ShowreelPort` of `Connection`, and the control API's. Keeps the clips
 * (`ClipStore`), cuts a day's reel from them (`cutShowreel`: at once without a model, then again with the model's
 * titles and buckets), keeps each day's cut in `<GRENADE_HOME>/showreels/<date>.json`, and at the end-of-day hour
 * announces the day's reel once as a `showreel` row of the Talk thread. Emits `changed` with the day's frame whenever
 * a day's reel was cut again; `Connection` passes it to clients that asked for that day.
 */
import { EventEmitter } from "node:events";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { clipIdsOf, showreelRowText, type ActivityEntry, type Clip, type ClipChunkFrame, type ClipsFrame, type Session, type ShowreelFrame, type ShowreelPiece } from "@grenade/protocol";
import type { Logger } from "../log.js";
import { clipDate, type ClipInput } from "./clipFile.js";
import { ClipStore } from "./clipStore.js";
import { cutShowreel, openingOf, pushesIn, type DayBoard } from "./showreelCut.js";
import { buildShowreelInput, CLOSING_REPLIES_MAX, CLOSING_TEXT_MAX, parseShowreelReply, type SessionClosing } from "./showreelPrompt.js";
import { loadShowreelSettings, saveShowreelSettings } from "./showreelSettings.js";

/** How long after the last clip the model is asked, so a burst of clips is titled once. */
export const MODEL_SETTLE_MS = 20_000;
/** How often the clock is looked at for the end-of-day hour. */
export const HOUR_CHECK_MS = 60_000;

/** A day's cut as kept on disk. */
export interface ShowreelDoc {
  date: string;
  madeAt: string;
  version: number;
  /** One sentence of what shipped, for the opening card. */
  opening?: string;
  pieces: ShowreelPiece[];
  /** The ids of the clips the cut was made from, so a new clip is noticed. */
  from: string[];
  /** The model has titled this cut (or there was none to ask). */
  titled: boolean;
  /** The Talk row was written. */
  announced?: boolean;
}

export interface ShowreelServiceEvents {
  changed: [frame: ShowreelFrame];
}

export interface ShowreelServiceOptions {
  store: ClipStore;
  /** Where the days' cuts are kept: `<GRENADE_HOME>/showreels`. */
  dir: string;
  /** `showreel.json`. */
  settingsPath: string;
  registry: { list(): Session[]; get(id: string): Session | undefined };
  entriesOf(id: string): ActivityEntry[];
  /** The boards saved on a day in the canvases of the sessions listed. */
  boardsOf(date: string): Promise<DayBoard[]>;
  /** Sends the model its input, resolves with its reply. Absent: the reel keeps the agents' own titles. */
  run?: ((input: string) => Promise<string>) | undefined;
  /** Writes the day's `showreel` row to the thread. Absent: nothing announces it. */
  announce?: ((text: string) => void) | undefined;
  log: Logger;
  now?: () => Date;
}

export class ShowreelService extends EventEmitter<ShowreelServiceEvents> {
  private readonly now: () => Date;
  private readonly settleTimers = new Map<string, NodeJS.Timeout>();
  private readonly hourTimer: NodeJS.Timeout;
  private titling = new Set<string>();

  constructor(private readonly o: ShowreelServiceOptions) {
    super();
    this.now = o.now ?? (() => new Date());
    this.hourTimer = setInterval(() => void this.checkHour(), HOUR_CHECK_MS);
    this.hourTimer.unref();
    const gone = o.store.prune();
    if (gone.length > 0) o.log.info("Removed old clips", { days: gone.join(",") });
  }

  stop(): void {
    clearInterval(this.hourTimer);
    for (const t of this.settleTimers.values()) clearTimeout(t);
    this.settleTimers.clear();
  }

  /** Today, in this computer's calendar. */
  today(): string {
    return clipDate(this.now());
  }

  /** The hour the day's reel is cut and announced. */
  hour(): number {
    return loadShowreelSettings(this.o.settingsPath).hour;
  }

  setHour(hour: number): void {
    saveShowreelSettings(this.o.settingsPath, { hour });
    this.o.log.info(`The showreel is cut at ${hour}:00`);
  }

  /** `grenade clip`: keeps the file and cuts the day again. Rejects with `ClipError`. */
  async addClip(input: ClipInput): Promise<Clip> {
    const clip = await this.o.store.add(input);
    this.o.log.info("Kept a clip", { clip: clip.id, kind: clip.kind, bytes: clip.bytes, session: clip.session });
    this.recut(clipDate(new Date(clip.at)));
    return clip;
  }

  /** The `clips` frame of a day. */
  clips(date: string | undefined): ClipsFrame {
    const day = date ?? this.today();
    return { type: "clips", date: day, clips: this.o.store.list(day) };
  }

  /** The `clip.chunk` frame for a clip from an offset, or null for a clip not kept or an offset past its end. */
  chunk(id: string, from: number): ClipChunkFrame | null {
    const chunk = this.o.store.chunk(id, from);
    return chunk ? { type: "clip.chunk", id, from, data: chunk.data.toString("base64"), bytes: chunk.bytes, last: chunk.last } : null;
  }

  /** The `showreel` frame of a day: cut now when a clip came since the last cut. */
  frame(date: string | undefined): ShowreelFrame {
    const day = date ?? this.today();
    const doc = this.current(day);
    return this.frameOf(day, doc);
  }

  /** Cuts a day again with the model now (`grenade showreel --make`, `POST /showreel/make`) and returns it. */
  async make(date: string | undefined): Promise<ShowreelFrame> {
    const day = date ?? this.today();
    this.current(day);
    await this.title(day);
    return this.frameOf(day, this.load(day));
  }

  /** The day's cut, made or remade without the model when its clips changed. */
  private current(day: string): ShowreelDoc | undefined {
    const clips = this.o.store.list(day);
    const doc = this.load(day);
    if (clips.length === 0) return doc;
    const ids = clips.map((c) => c.id);
    if (doc && sameIds(doc.from, ids)) return doc;
    const next = this.cut(day, clips, undefined, doc);
    this.schedule(day);
    return next;
  }

  private recut(day: string): void {
    const doc = this.current(day);
    if (doc) this.emit("changed", this.frameOf(day, doc));
  }

  /** One cut: the pieces from the clips, the boards and the pushes, with the model's proposal when there is one. */
  private cut(day: string, clips: Clip[], proposal: ReturnType<typeof parseShowreelReply> | undefined, previous: ShowreelDoc | undefined, boards: DayBoard[] = []): ShowreelDoc {
    const pushes = [...new Set(clips.map((c) => c.session).filter((s): s is string => !!s))].flatMap((s) => pushesIn(s, this.o.entriesOf(s)).filter((p) => clipDate(new Date(p.at)) === day));
    const pieces = cutShowreel({ clips, boards, pushes, proposal: proposal ?? undefined });
    // A cut without the model keeps the sentence the model wrote last time, when the pieces are the same titles.
    const kept = !proposal && previous?.opening && sameTitles(previous.pieces, pieces) ? previous.opening : undefined;
    const opening = kept ?? openingOf(pieces, proposal ?? undefined);
    const doc: ShowreelDoc = {
      date: day,
      madeAt: this.now().toISOString(),
      version: (previous?.version ?? 0) + 1,
      ...(opening ? { opening } : {}),
      pieces,
      from: clips.map((c) => c.id),
      titled: proposal !== undefined || !this.o.run,
      ...(previous?.announced ? { announced: true } : {}),
    };
    this.save(doc);
    return doc;
  }

  /** Asks the model once the day's clips have held still. */
  private schedule(day: string): void {
    if (!this.o.run) return;
    const pending = this.settleTimers.get(day);
    if (pending) clearTimeout(pending);
    const t = setTimeout(() => {
      this.settleTimers.delete(day);
      void this.title(day);
    }, MODEL_SETTLE_MS);
    t.unref();
    this.settleTimers.set(day, t);
  }

  /** The model's pass over a day: titles, lines, buckets and boards. The cut stands when it fails. */
  private async title(day: string): Promise<void> {
    if (!this.o.run || this.titling.has(day)) return;
    const clips = this.o.store.list(day);
    if (clips.length === 0) return;
    this.titling.add(day);
    try {
      const boards = await this.o.boardsOf(day).catch(() => [] as DayBoard[]);
      const closings = this.closingsOf(clips, day);
      const reply = await this.o.run(buildShowreelInput(clips, boards, closings));
      const proposal = parseShowreelReply(reply);
      if (!proposal) {
        this.o.log.warn("The showreel's model gave no pieces; the agents' titles stand", { day });
        return;
      }
      const latest = this.o.store.list(day);
      const doc = this.cut(day, latest, proposal, this.load(day), boards);
      this.emit("changed", this.frameOf(day, doc));
      this.o.log.info("Cut the showreel", { day, pieces: doc.pieces.length, version: doc.version });
    } catch (e) {
      this.o.log.warn("Could not title the showreel", { day, error: e instanceof Error ? e.message : String(e) });
    } finally {
      this.titling.delete(day);
    }
  }

  /** Each session's last replies of the day, for the model. */
  private closingsOf(clips: Clip[], day: string): SessionClosing[] {
    const closings: SessionClosing[] = [];
    for (const id of new Set(clips.map((c) => c.session).filter((s): s is string => !!s))) {
      const session = this.o.registry.get(id);
      const said = this.o
        .entriesOf(id)
        .filter((e) => e.kind === "said" && clipDate(new Date(e.at)) === day)
        .slice(-CLOSING_REPLIES_MAX)
        .map((e) => (e.text.length > CLOSING_TEXT_MAX ? `${e.text.slice(0, CLOSING_TEXT_MAX - 1)}…` : e.text));
      closings.push({ session: id, title: session?.title ?? session?.name ?? id, said });
    }
    return closings;
  }

  /** At the end-of-day hour: title today's reel and announce it, once. */
  async checkHour(): Promise<void> {
    const now = this.now();
    if (now.getHours() < this.hour()) return;
    const day = clipDate(now);
    let doc = this.current(day);
    if (!doc || doc.announced || doc.pieces.length === 0) return;
    if (!doc.titled) {
      await this.title(day);
      doc = this.load(day) ?? doc;
    }
    if (doc.announced || doc.pieces.length === 0) return;
    this.o.announce?.(showreelRowText(doc.pieces));
    this.save({ ...doc, announced: true });
    this.o.log.info("Announced the showreel", { day, pieces: doc.pieces.length });
  }

  private frameOf(day: string, doc: ShowreelDoc | undefined): ShowreelFrame {
    if (!doc) return { type: "showreel", date: day, version: 0, pieces: [], clips: [] };
    const all = new Map(this.o.store.list(day).map((c) => [c.id, c]));
    const clips = clipIdsOf(doc.pieces).map((id) => all.get(id)).filter((c): c is Clip => !!c);
    return { type: "showreel", date: day, madeAt: doc.madeAt, version: doc.version, ...(doc.opening ? { opening: doc.opening } : {}), pieces: doc.pieces, clips };
  }

  private load(day: string): ShowreelDoc | undefined {
    const file = this.fileOf(day);
    if (!existsSync(file)) return undefined;
    try {
      const raw = JSON.parse(readFileSync(file, "utf8")) as ShowreelDoc;
      return raw && typeof raw === "object" && Array.isArray(raw.pieces) && Array.isArray(raw.from) ? raw : undefined;
    } catch {
      return undefined;
    }
  }

  private save(doc: ShowreelDoc): void {
    if (!existsSync(this.o.dir)) {
      mkdirSync(this.o.dir, { recursive: true, mode: 0o700 });
      chmodSync(this.o.dir, 0o700);
    }
    const file = this.fileOf(doc.date);
    writeFileSync(`${file}.tmp`, `${JSON.stringify(doc)}\n`, { mode: 0o600 });
    renameSync(`${file}.tmp`, file);
  }

  private fileOf(day: string): string {
    return join(this.o.dir, `${day}.json`);
  }
}

function sameTitles(a: readonly ShowreelPiece[], b: readonly ShowreelPiece[]): boolean {
  return a.length === b.length && a.every((p, i) => p.title === b[i]!.title);
}

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i]);
}
