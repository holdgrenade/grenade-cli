/**
 * Pure: Claude Code's `/model` picker, read off a session's screen (PROTOCOL.md "Models"). Claude Code has no
 * command that switches one session only: typing `/model <name>` saves the model as the user's default. The picker
 * does, with its "s to use this session only" key, so the daemon opens it and reads these rows to steer it.
 *
 *     Select model
 *       1.  Default (recommended)  Fable 5.1
 *     ❯ 2.  Opus 5.5               For complex work and everyday tasks
 *       3.  Fable 5.1 ✔            For your toughest challenges
 *     ↓ 10. Opus 4.7               Best for everyday, complex tasks
 *
 *     ◐ Medium effort (default) ←/→ to adjust
 *
 *     Enter to set as default · s to use this session only · Esc to cancel
 */

export interface PickerRow {
  /** The model as the picker names it ("Opus 5.5"), the same label `modelLabel` makes. */
  name: string;
  /** The row the cursor is on. */
  selected: boolean;
}

export interface ModelPicker {
  /** The rows on screen, top to bottom. The list scrolls, so these may not be all of them. */
  rows: PickerRow[];
  /** The effort level shown for the selected row, in lowercase ("xhigh"); null when its model takes none. */
  effort: string | null;
  /** The picker offers the key that switches this session only. */
  sessionOnly: boolean;
}

const HEADER = "Select model";
const SESSION_ONLY_HINT = "s to use this session only";
/** "❯ 3.  Fable 5.1 ✔   For your toughest challenges", with "↑"/"↓" where the list goes on. */
const ROW = /^\s*(❯)?\s*[↑↓]?\s*\d+\.\s+(.+)$/;
/** "◐ Medium effort (default) ←/→ to adjust"; "○ Effort not supported for Haiku 4.5" is not a level. */
const EFFORT = /^\s*\S\s+(\w+) effort\b/;

/** Claude Code draws its prompt and cursor with no-break spaces. */
const plain = (line: string): string => line.replace(/ /g, " ");

/** The model picker on this screen, or null when it is not open. */
export function modelPickerIn(lines: string[]): ModelPicker | null {
  const text = lines.map(plain);
  const top = text.findIndex((l) => l.trim() === HEADER);
  if (top < 0) return null;
  const rows: PickerRow[] = [];
  let effort: string | null = null;
  let sessionOnly = false;
  for (const line of text.slice(top + 1)) {
    const row = ROW.exec(line);
    if (row) {
      const name = row[2]!.split(/\s{2,}/)[0]!.replace(/\s*✔$/, "").trim();
      rows.push({ name, selected: row[1] !== undefined });
      continue;
    }
    const level = EFFORT.exec(line);
    if (level) effort = level[1]!.toLowerCase();
    if (line.includes(SESSION_ONLY_HINT)) sessionOnly = true;
  }
  return rows.length > 0 ? { rows, effort, sessionOnly } : null;
}

/** The name of the row the cursor is on. */
export function selectedModel(picker: ModelPicker): string | undefined {
  return picker.rows.find((r) => r.selected)?.name;
}

/** How many rows below the cursor `name` is (negative: above). Null when it, or the cursor, is not on screen. */
export function rowsDownTo(picker: ModelPicker, name: string): number | null {
  const from = picker.rows.findIndex((r) => r.selected);
  const to = picker.rows.findIndex((r) => r.name === name);
  return from < 0 || to < 0 ? null : to - from;
}

/** What is typed in Claude Code's prompt box: the text after the last "❯". Null when the screen has no prompt. */
export function promptText(lines: string[]): string | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = plain(lines[i]!).trim();
    if (line.startsWith("❯")) return line.slice(1).trim();
  }
  return null;
}

/**
 * The model Claude Code last said it switched to, or kept: "Set model to Opus 5.5 for this session only with low
 * effort", "Kept model as Fable 5.1". Null when the screen says neither.
 */
export function switchedModelIn(lines: string[]): string | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = plain(lines[i]!);
    const set = /Set model to (.+?) for this session only/.exec(line);
    if (set) return set[1]!.trim();
    const kept = /Kept model as (.+?)\s*$/.exec(line);
    if (kept) return kept[1]!.trim();
  }
  return null;
}

/**
 * The switch Claude Code last confirmed for this session only, with the effort level it names: "Set model to Opus 5.5
 * for this session only with high effort" (no level for a model that takes none). Null when its newest word on the
 * model is that it kept it, or when the screen says neither. A narrow terminal wraps the line, so the rows are read
 * as one text.
 */
export function sessionModelIn(lines: string[]): { model: string; effort: string | undefined } | null {
  const text = lines.map((l) => plain(l).trim()).join(" ").replace(/\s+/g, " ");
  let newest: RegExpExecArray | null = null;
  for (const said of text.matchAll(/Kept model as|Set model to (.+?) for this session only(?: with (\w+) effort)?/g)) newest = said;
  return newest?.[1] ? { model: newest[1].trim(), effort: newest[2]?.toLowerCase() } : null;
}
