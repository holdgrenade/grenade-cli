/**
 * Pure: a dialog an agent shows that no hook announces, read off its screen (PROTOCOL.md "Codex dialogs",
 * "Claude Code dialogs"). Each becomes a `question` prompt; an answer is the keys that pick its option.
 * The readers are `codexDialogs.ts` and `claudeDialogs.ts`; `screenPrompts.ts` turns what they read into cards.
 */
import type { KeyName, PromptBody } from "@grenade/protocol";

/** One answer a card offers, and the keys that pick it in the dialog. */
export interface DialogChoice {
  label: string;
  description: string;
  keys: KeyName[];
  /** One more key, pressed once the screen shows what the keys lead to (a picker to close). */
  then?: { when: (lines: string[]) => boolean; key: KeyName };
}

export interface ScreenDialog {
  /** What the dialog is: a prompt stays the same prompt while the same dialog is up. */
  id: string;
  body: PromptBody;
  choices: DialogChoice[];
  /** What a dismissed card presses. Without it a dismissal leaves the dialog to the terminal. */
  dismiss?: DialogChoice;
  /** The model the screen says the session was switched to, read once the dialog is gone. */
  chose?: (lines: string[]) => { model: string; effort: string | undefined } | null;
}

/** "› 2. Trust all and continue": one row of a dialog's menu, the selected one marked. */
export interface MenuRow {
  selected: boolean;
  text: string;
}

/** The numbered rows on the screen; `mark` is what the agent draws before the selected one ("›", "❯"). */
export function menuIn(lines: string[], mark: string): MenuRow[] {
  const row = new RegExp(`^\\s*(${mark.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})?\\s*\\d+\\.\\s+(.+?)\\s*$`);
  const rows: MenuRow[] = [];
  for (const line of lines) {
    const m = row.exec(line);
    if (m) rows.push({ selected: m[1] !== undefined, text: m[2]! });
  }
  return rows;
}

/** The arrow keys from the selected row to the one whose text starts with `starts`, then Enter. Null when either is not on the screen. */
export function keysTo(menu: MenuRow[], starts: string): KeyName[] | null {
  const selected = menu.findIndex((r) => r.selected);
  const target = menu.findIndex((r) => r.text.startsWith(starts));
  if (selected < 0 || target < 0) return null;
  const step: KeyName = target > selected ? "down" : "up";
  return [...Array<KeyName>(Math.abs(target - selected)).fill(step), "enter"];
}

export function questionBody(header: string, question: string, choices: DialogChoice[]): PromptBody {
  return { kind: "question", questions: [{ header, question, options: choices.map((c) => ({ label: c.label, description: c.description })), multiSelect: false }] };
}
