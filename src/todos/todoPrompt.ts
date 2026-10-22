/**
 * What every Claude Code session Grenade starts is told about its to-do list (`claudeHookFlags`:
 * `--append-system-prompt`, after the canvas's; Jeff, 2026-10-21): so "add these as to-dos" in a prompt adds them to the
 * list the person sees in Grenade, through `grenade todo`, rather than a list in the reply.
 */
export const TODO_INSTRUCTIONS = [
  "This session has a to-do list in Grenade, which the person sees in the app and on their phone. When they ask you to",
  "add something to their to-dos (or to keep it for later), run `grenade todo add \"<short title>\" --text \"<the detail>\"`",
  "once per item, in their terms; `grenade todo list` prints the list. Never add to-dos they did not ask for.",
].join("\n");
