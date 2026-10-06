/**
 * Whether a session's agent can take a typed prompt now, read off its screen. Pure, tested.
 *
 * A port of the apps' `ClaudeStartup` and `VoiceFirstPrompt` (grenade-ios), widened to Codex's dialogs: text typed
 * into a dialog answers it (Claude Code's "trust this folder" has "No, exit" selected), and trusting a folder is the
 * owner's to decide. So a prompt waits for the prompt box and is held while a dialog shows.
 */
import { codexDialogIn } from "../prompts/codexDialogs.js";

/** How long a new session's agent is waited for before its first prompt is given up. */
export const FIRST_PROMPT_WAIT_MS = 30_000;
export const TRUST_NOTE = "The folder asks to be trusted first. The owner answers that in the session, and the prompt was not sent.";
export const DIALOG_NOTE = "The agent is showing a question of its own. The owner answers that in the session, and the prompt was not sent.";
export const LATE_NOTE = "The agent was not ready in time. The first prompt was not sent.";
export const ENDED_NOTE = "The session ended before the prompt was sent.";

export type Readiness = "send" | "wait" | { hold: string };

/** Whether `agent`'s screen takes a prompt: send, wait (still starting) or hold (a dialog is up, or it ended). */
export function readiness(agent: string, lines: readonly string[] | undefined, live: boolean): Readiness {
  if (!live) return { hold: ENDED_NOTE };
  if (!lines) return "wait";
  if (agent === "claude") {
    if (asksTrust(lines)) return { hold: TRUST_NOTE };
    return hasPromptBox(lines) ? "send" : "wait";
  }
  if (agent === "codex") {
    const dialog = codexDialogIn([...lines]);
    if (dialog) return { hold: dialog.id === "folder" ? TRUST_NOTE : DIALOG_NOTE };
    return hasCodexComposer(lines) ? "send" : "wait";
  }
  return "send";
}

/** Claude Code's trust dialog in every wording seen so far: "Accessing workspace: … Yes, I trust this folder" and "Do you trust the files in this folder?". */
export function asksTrust(lines: readonly string[]): boolean {
  return lines.some((l) => l.includes("Yes, I trust this folder") || l.includes("Do you trust the files in this folder") || l.trim() === "Accessing workspace:");
}

/** Claude Code's prompt box: a "❯" (or ">") row right under a rule of "─". The trust dialog's "❯ No, exit" has no rule above it. */
export function hasPromptBox(lines: readonly string[]): boolean {
  for (let i = 1; i < lines.length; i++) {
    const row = lines[i]!.trim();
    const above = lines[i - 1]!.trim();
    if ((row.startsWith("❯") || row.startsWith(">")) && above.startsWith("───")) return true;
  }
  return false;
}

/** Codex's composer: a row that starts with "›", with no dialog on the screen (checked before). */
export function hasCodexComposer(lines: readonly string[]): boolean {
  return lines.some((l) => l.trimStart().startsWith("›"));
}
