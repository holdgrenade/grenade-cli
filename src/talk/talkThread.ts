/**
 * The day's Talk thread on disk (PROTOCOL.md "Talk by text", "The thread"): one JSONL file per day,
 * `<GRENADE_HOME>/talk/YYYY-MM-DD.jsonl` in the computer's own calendar, mode 0600 in a folder of mode 0700. Rows are
 * only ever appended. A line that does not decode as a `TalkEntry` is skipped, never an error.
 */
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { TALK_TEXT_MAX, TALK_THREAD_MAX, TalkEntry } from "@grenade/protocol";

/** The day a moment falls on in this computer's calendar: "2026-10-05". Pure. */
export function talkDate(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** The rows in a day's file, oldest first; lines that are not rows are skipped. Pure. */
export function entriesIn(jsonl: string): TalkEntry[] {
  const entries: TalkEntry[] = [];
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = TalkEntry.safeParse(JSON.parse(line));
      if (parsed.success) entries.push(parsed.data);
    } catch {
      // a line cut short by a crash: skip it
    }
  }
  return entries;
}

/** The number after `t-` of the daemon's own row ids, so a new row never repeats one. Pure. */
export function lastRowNumber(entries: readonly TalkEntry[]): number {
  let last = 0;
  for (const e of entries) {
    const m = /^t-(\d+)$/.exec(e.id);
    if (m) last = Math.max(last, Number(m[1]));
  }
  return last;
}

/** A row as a caller hands it over: the store gives it its id (unless it has one, as a `you` row does) and its time. */
export type NewTalkEntry = Omit<TalkEntry, "id" | "at"> & { id?: string };

export class TalkThread {
  private day: string;
  private rows: TalkEntry[] = [];
  // The feed makes a day's file long: the ids and the last row number are kept, not scanned for on every row.
  private ids = new Set<string>();
  private lastNumber = 0;

  constructor(private readonly dir: string, private readonly now: () => Date = () => new Date()) {
    this.day = talkDate(now());
    this.reset(this.load(this.day));
  }

  /** The day this thread is of. */
  get date(): string {
    return this.day;
  }

  /** The day's newest rows, oldest first, at most `TALK_THREAD_MAX`. */
  entries(): TalkEntry[] {
    return this.rows.slice(-TALK_THREAD_MAX);
  }

  /** Every row of the day, oldest first. */
  all(): readonly TalkEntry[] {
    return this.rows;
  }

  has(id: string): boolean {
    return this.ids.has(id);
  }

  /** Moves to a new day's thread when the calendar has turned. True when it did. */
  rollover(): boolean {
    const today = talkDate(this.now());
    if (today === this.day) return false;
    this.day = today;
    this.reset(this.load(today));
    return true;
  }

  /** Writes a row to the day's file and returns it as it was kept. Call `rollover` first. */
  append(row: NewTalkEntry): TalkEntry {
    const entry: TalkEntry = {
      ...row,
      id: row.id ?? `t-${String(this.lastNumber + 1).padStart(4, "0")}`,
      at: this.now().toISOString(),
      text: row.text.length > TALK_TEXT_MAX ? `${row.text.slice(0, TALK_TEXT_MAX - 1)}…` : row.text,
    };
    this.ensureDir();
    appendFileSync(this.fileOf(this.day), `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    this.rows.push(entry);
    this.ids.add(entry.id);
    this.lastNumber = Math.max(this.lastNumber, lastRowNumber([entry]));
    return entry;
  }

  private reset(rows: TalkEntry[]): void {
    this.rows = rows;
    this.ids = new Set(rows.map((e) => e.id));
    this.lastNumber = lastRowNumber(rows);
  }

  private load(day: string): TalkEntry[] {
    const file = this.fileOf(day);
    if (!existsSync(file)) return [];
    return entriesIn(readFileSync(file, "utf8"));
  }

  private fileOf(day: string): string {
    return join(this.dir, `${day}.jsonl`);
  }

  private ensureDir(): void {
    if (existsSync(this.dir)) return;
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    chmodSync(this.dir, 0o700);
  }
}
