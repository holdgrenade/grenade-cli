/**
 * What counts for a turn's highlights (PROTOCOL.md "Highlights"), apart from where it is found. Pure.
 * - A turn starts with the owner's prompt. Claude Code also sends prompts of its own, such as a `<task-notification>`
 *   when a background task ends (a dev server the agent stopped); those are part of the turn already running, and
 *   taking one for a new turn left only the last seconds of the turn in its window.
 * - A picture the owner sent is in `attachments/<session>`, where the agent's own browser screenshots are saved too
 *   (`grenade browser screenshot`, named `AGENT_SCREENSHOT_NAME`); those are the agent's, found in its transcript.
 */
import { typedPromptText } from "@grenade/protocol";

/** The name the daemon saves the agent's browser screenshots under, before the time stamp and the extension. */
export const AGENT_SCREENSHOT_NAME = "browser";

/** Whether a hook's prompt starts a turn: the owner's words (or a slash command), not text the agent wrote itself. */
export function startsTurn(prompt: string): boolean {
  return typedPromptText(prompt) !== null;
}

/** Whether a file in `attachments/<session>` is one of the agent's browser screenshots: `<stamp>-browser[-n].<ext>`. */
export function isAgentScreenshot(fileName: string): boolean {
  return new RegExp(`^\\d{8}-\\d{6}-${AGENT_SCREENSHOT_NAME}(-\\d+)?\\.[a-z0-9]+$`).test(fileName);
}
