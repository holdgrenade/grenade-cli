/**
 * Pure: the dialogs Codex shows before a session can start, read off its screen (PROTOCOL.md "Prompts", "Codex
 * dialogs"). No hook runs while one is up, so the screen is the only thing that says the session waits for an
 * answer. Each becomes a `question` prompt; an answer is the keys that pick its option.
 */
import { keysTo, menuIn, questionBody, type DialogChoice, type MenuRow, type ScreenDialog } from "./screenDialog.js";

export interface CodexDialog extends ScreenDialog {
  id: "hooks" | "folder";
}

/** Codex marks the selected row of a menu with "›". */
const MARK = "›";

/** The Codex dialog on this screen, or null when none is (or its menu cannot be read). */
export function codexDialogIn(lines: string[]): CodexDialog | null {
  if (lines.some((l) => l.trim() === "Hooks need review")) return hooksDialog(lines);
  if (lines.some((l) => l.includes("Trust this folder?"))) return folderDialog(lines);
  return null;
}

/** "Hooks need review · 7 hooks are new or changed." Grenade's own hooks, the first Codex it starts. */
function hooksDialog(lines: string[]): CodexDialog | null {
  const menu = menuIn(lines, MARK);
  const count = lines.map((l) => l.trim()).find((l) => /^\d+ hooks? (is|are) new or changed\.$/.test(l));
  const choices = [
    choice(menu, "Trust all and continue", "Trust", "Codex runs the hooks, so this session shows its status and what Codex says."),
    choice(menu, "Continue without trusting", "Skip", "The hooks don't run; the status is guessed from the screen."),
  ];
  if (choices.some((c) => c === null)) return null;
  const question = `${count ? `${count} ` : ""}Codex runs hooks only once you trust them. They can run outside its sandbox.`;
  return { id: "hooks", body: questionBody("Codex hooks", question, choices as DialogChoice[]), choices: choices as DialogChoice[] };
}

/** "Trust this folder?" The first time Codex runs in a folder. */
function folderDialog(lines: string[]): CodexDialog | null {
  const menu = menuIn(lines, MARK);
  const trust = choice(menu, "Trust and continue", "Trust", "Codex can read, edit and run files here, subject to your permission settings.");
  if (!trust) return null;
  const at = lines.findIndex((l) => l.trim() === "Folder access");
  const folder = at >= 0 ? lines[at + 1]?.trim() : undefined;
  const question = `Trust this folder?${folder ? ` ${folder}` : ""}`;
  return { id: "folder", body: questionBody("Folder access", question, [trust]), choices: [trust] };
}

/** The option whose text starts with `starts`, as a choice with the arrow keys from the selected row to it and Enter. */
function choice(menu: MenuRow[], starts: string, label: string, description: string): DialogChoice | null {
  const keys = keysTo(menu, starts);
  return keys ? { label, description, keys } : null;
}
