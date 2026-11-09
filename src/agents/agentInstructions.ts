/**
 * Pure: what every agent session Grenade starts is told about Grenade (its canvas, its to-dos and, on a Mac, its
 * browser), and how each agent is told. Claude Code gets it as `--append-system-prompt` (`claudeHookFlags`); Codex as
 * `-c developer_instructions=…` (`codexInstructionsFlag`), after the developer instructions the user set in Codex's
 * own config, which the flag would otherwise replace. Without it Codex never knew the canvas existed (2026-11-09).
 */
import { BROWSER_INSTRUCTIONS } from "../browser/browserPrompt.js";
import { CANVAS_INSTRUCTIONS } from "../canvas/canvasPrompt.js";
import { TODO_INSTRUCTIONS } from "../todos/todoPrompt.js";
import { shellQuote } from "../hooks/shellQuote.js";

/**
 * Codex runs its commands in a sandbox that has no network, the loopback address included, so a `grenade` command
 * cannot reach the daemon from it (`CODEX_SANDBOX_NETWORK_DISABLED`). Asked for, the command runs outside it once the
 * person approves it, in the terminal or on a phone's card.
 */
export const CODEX_SANDBOX_INSTRUCTIONS = [
  "Your sandbox has no network, so the `grenade` commands above (`grenade canvas`, `grenade todo`, `grenade browser`)",
  "cannot reach Grenade from inside it: run each of them with escalated permissions (outside the sandbox) from the",
  "start. They only talk to Grenade on this computer.",
].join("\n");

/** What a session of either agent is told about Grenade. `mac`: the Grenade app's browser is there too. */
export function grenadeInstructions(mac: boolean): string {
  const shared = `${CANVAS_INSTRUCTIONS}\n\n${TODO_INSTRUCTIONS}`;
  return mac ? `${BROWSER_INSTRUCTIONS}\n\n${shared}` : shared;
}

/** What a Codex session is told: the user's own developer instructions first, then Grenade's, then its sandbox's rule. */
export function codexInstructions(mac: boolean, userInstructions?: string | null): string {
  const grenade = `${grenadeInstructions(mac)}\n\n${CODEX_SANDBOX_INSTRUCTIONS}`;
  const own = userInstructions?.trim();
  return own ? `${own}\n\n${grenade}` : grenade;
}

/** `-c 'developer_instructions="…"'`, quoted for the shell tmux runs the agent in. Not a hook: Codex asks to trust nothing. */
export function codexInstructionsFlag(instructions: string): string {
  // JSON's escapes are TOML's; TOML also wants DEL escaped, which JSON leaves alone.
  const toml = JSON.stringify(instructions).replace(/\x7f/g, "\\u007f");
  return `-c ${shellQuote(`developer_instructions=${toml}`)}`;
}
