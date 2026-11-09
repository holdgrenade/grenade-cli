/**
 * Pure: Codex's `/model` picker as its screen shows it (Codex 0.160): "Select Model and Effort" (one row a model,
 * "GPT-6-Luna (current)  Fast and affordable…"), then "Select Reasoning Level for <model>" (Low, Medium, High,
 * Extra high, and "More reasoning…", which opens "Advanced Reasoning": Max, Ultra), where "s" applies the choice to the
 * session only and Enter would save it as Codex's default. `codexModelSwitch.ts` steers it.
 */
import { menuIn, type MenuRow } from "../prompts/screenDialog.js";

export interface PickerMenu {
  /** What each row is: a model's name, an effort level, or `more` for "More reasoning…". */
  rows: string[];
  selected: number;
}

const MORE = "more";

/** A row's words before its description, without "(current)" or "(default)". */
function rowName(row: MenuRow): string {
  return row.text.split(/\s{2,}/)[0]!.replace(/\s*\((current|default)\)\s*$/, "").trim();
}

/** The rows under the newest line `heading` matches, the menu ending at its key line. */
function menuUnder(lines: readonly string[], heading: (line: string) => boolean): MenuRow[] | null {
  let at = -1;
  for (let i = lines.length - 1; i >= 0 && at < 0; i--) if (heading(lines[i]!.trim())) at = i;
  if (at < 0) return null;
  const below = lines.slice(at + 1);
  if (!below.some((l) => /esc back/.test(l))) return null;
  const rows = menuIn(below, "›");
  return rows.length > 0 && rows.some((r) => r.selected) ? rows : null;
}

function pickerMenu(rows: MenuRow[], name: (row: MenuRow) => string): PickerMenu {
  return { rows: rows.map(name), selected: rows.findIndex((r) => r.selected) };
}

/** "Select Model and Effort": the models, in the picker's order. */
export function codexModelMenuIn(lines: readonly string[]): PickerMenu | null {
  const rows = menuUnder(lines, (l) => l === "Select Model and Effort");
  return rows ? pickerMenu(rows, rowName) : null;
}

/** The reasoning levels as Codex's words for them: "Extra high" is `xhigh`; the rest in lowercase. */
export function effortOfLabel(label: string): string {
  const word = label.toLowerCase();
  if (word === "extra high") return "xhigh";
  if (word.startsWith("more reasoning")) return MORE;
  return word.replace(/\s+/g, "-");
}

/** "Select Reasoning Level for <model>", or the "Advanced Reasoning" it opens: the levels, `more` for the way there. */
export function codexEffortMenuIn(lines: readonly string[]): (PickerMenu & { advanced: boolean }) | null {
  const levels = menuUnder(lines, (l) => l.startsWith("Select Reasoning Level for "));
  const advanced = levels ? null : menuUnder(lines, (l) => l === "Advanced Reasoning");
  const rows = levels ?? advanced;
  if (!rows) return null;
  // "s session" is offered on a level's row, not on "More reasoning…": `offersSessionOnly` says so before "s".
  return { ...pickerMenu(rows, (r) => effortOfLabel(rowName(r))), advanced: advanced !== null };
}

/** The arrow presses from the selected row to `row`: positive is down. Null when it is not a row. */
export function movesTo(menu: PickerMenu, row: string): number | null {
  const at = menu.rows.indexOf(row);
  return at < 0 || menu.selected < 0 ? null : at - menu.selected;
}

/** The picker offers "s" for this session only on the row it is on. */
export function offersSessionOnly(lines: readonly string[]): boolean {
  return lines.some((l) => /\bs session\b/.test(l));
}

export function hasMore(menu: PickerMenu): boolean {
  return menu.rows.includes(MORE);
}

/** "• Model changed to gpt-5.6-terra high for this session only": the model's slug and the effort, the newest one. */
export function codexSwitchedIn(lines: readonly string[]): { slug: string; effort: string | undefined } | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = /Model changed to (\S+)(?: (\S+))? for this session only/.exec(lines[i]!);
    if (m) return { slug: m[1]!, effort: m[2] };
  }
  return null;
}

/** What Codex's composer holds: the text of its "›" row that is no menu row, "" for the empty one. */
export function codexComposerText(lines: readonly string[]): string | null {
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 10); i--) {
    const row = lines[i]!.trimStart();
    if (!row.startsWith("›") || /^›\s*\d+\.\s/.test(row)) continue;
    const text = row.slice(1).trim();
    return text === "Ask Codex to do anything" ? "" : text;
  }
  return null;
}
