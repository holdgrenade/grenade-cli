/**
 * What every Claude Code session Grenade starts is told about the canvas (`claudeHookFlags`: `--append-system-prompt`,
 * after `BROWSER_INSTRUCTIONS` on a Mac). Nothing else tells an agent its group, so agents guessed: boards drawn in
 * another group's folder, or one made up, were missing from the session's canvas card (a turn of four boards showed one).
 */
export const CANVAS_INSTRUCTIONS = [
  "When you draw boards on the Grenade canvas, run `grenade canvas` first: it prints this session's group's canvas",
  "folders (`.grenade/canvas/<group>/canvas-<n>`) and the folder for a new one. Save each board directly in one of",
  "them with your file-writing tool (Write or Edit), never in another group's folder or one you make up, so the boards",
  "show on this session's canvas card.",
].join("\n");
