/**
 * Pure: what Codex's screen shows during a turn (Codex 0.160): its composer and mode, a page of its questions, the
 * "Implement this plan?" dialog. Each menu is read only below the dialog's own heading, so a numbered list in what
 * Codex wrote above it is never taken for the menu.
 */
import { menuIn, type MenuRow } from "./screenDialog.js";

const MARK = "›";

/** A numbered menu row, selected or not: "  › 1. Plain (Recommended)  Direct…". */
const MENU_ROW = /^\s*›?\s*\d+\.\s/;

/**
 * Codex waits for a prompt: its composer (a "›" row that is no menu row) with the footer under it that names the
 * model ("GPT-6-Luna default · ~/code/api"), and no question or plan dialog on the screen.
 */
export function codexComposerIn(lines: readonly string[]): boolean {
  if (codexQuestionPageIn(lines) || codexPlanDialogIn(lines)) return false;
  const rows = lines.map((l) => l.trimEnd()).filter((l) => l.trim() !== "");
  for (let i = rows.length - 1; i >= Math.max(0, rows.length - 8); i--) {
    const row = rows[i]!.trimStart();
    if (!row.startsWith(MARK) || MENU_ROW.test(rows[i]!)) continue;
    return rows.slice(i + 1).some((l) => l.includes(" · "));
  }
  return false;
}

/** Codex's footer says Plan mode is on. */
export function codexInPlanMode(lines: readonly string[]): boolean {
  return lines.slice(-4).some((l) => /\bPlan mode\b/.test(l));
}

/** A page of Codex's `request_user_input`: "Question 2/3 (2 unanswered)", its options below it. */
export function codexQuestionPageIn(lines: readonly string[]): { page: number; of: number; menu: MenuRow[] } | null {
  let at = -1;
  let m: RegExpExecArray | null = null;
  for (let i = lines.length - 1; i >= 0 && at < 0; i--) {
    m = /^\s*Question (\d+)\/(\d+)\b/.exec(lines[i]!);
    if (m) at = i;
  }
  if (at < 0 || !m) return null;
  const below = lines.slice(at + 1);
  if (!below.some((l) => /enter to submit/.test(l))) return null;
  return { page: Number(m[1]), of: Number(m[2]), menu: menuIn(below, MARK) };
}

/** Codex's notes field is open on a question page (after Tab): its footer offers to clear the notes. */
export function codexNotesOpenIn(lines: readonly string[]): boolean {
  return lines.slice(-4).some((l) => l.includes("to clear notes"));
}

/** "Implement this plan?", the menu under it. */
export function codexPlanDialogIn(lines: readonly string[]): { menu: MenuRow[] } | null {
  let at = -1;
  for (let i = lines.length - 1; i >= 0 && at < 0; i--) if (lines[i]!.trim() === "Implement this plan?") at = i;
  if (at < 0) return null;
  const menu = menuIn(lines.slice(at + 1), MARK);
  return menu.some((r) => r.text.startsWith("Yes, implement this plan")) ? { menu } : null;
}
