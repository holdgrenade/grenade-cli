/**
 * iTerm2 as a terminal for the mirror: one tab per session, a group's sessions as split panes of one tab.
 * Tabs are tagged with the iTerm session variable `user.grenadeSession = <id>`, so they are found again
 * whatever their title says. The AppleScript builders are pure and tested.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { asString, attachCommand, parseLines, runAppleScript, type ScriptRunner, type TabOf, type TerminalAdapter } from "./adapter.js";

export const TAG_VARIABLE = "user.grenadeSession";

export function isITermInstalled(): boolean {
  return existsSync("/Applications/iTerm.app") || existsSync(join(homedir(), "Applications", "iTerm.app"));
}

// ---- AppleScript builders (pure, tested) -----------------------------------

/** AppleScript lines that open a tab (or a window when iTerm has none) and leave it in `s`. */
function newTabLines(command: string): string {
  return `  if (count of windows) = 0 then
    set w to (create window with default profile command ${command})
    set s to current session of w
  else
    tell current window
      set t to (create tab with default profile command ${command})
      set s to current session of t
    end tell
  end if`;
}

function tagLines(id: string, title: string): string {
  return `  tell s
    set variable named ${asString(TAG_VARIABLE)} to ${asString(id)}
    set name to ${asString(title)}
  end tell`;
}

/** Opens a tab attached to the session and tags it. A window is created when iTerm has none. */
export function openTabScript(o: { tmuxBin: string; id: string; title: string }): string {
  return `tell application "iTerm2"
${newTabLines(attachCommand(o.tmuxBin, o.id))}
${tagLines(o.id, o.title)}
end tell`;
}

/**
 * Splits the pane tagged `nextTo` and attaches the new pane to the session. When no pane has that
 * tag (closed by hand), it opens a tab instead. Returns "split" or "tab".
 */
export function splitPaneScript(o: { tmuxBin: string; id: string; title: string; nextTo: string }): string {
  const command = attachCommand(o.tmuxBin, o.id);
  return `tell application "iTerm2"
  set target to missing value
  repeat with w in windows
    repeat with t in tabs of w
      repeat with x in sessions of t
        try
          if (variable named ${asString(TAG_VARIABLE)}) of x is ${asString(o.nextTo)} then set target to x
        end try
      end repeat
    end repeat
  end repeat
  if target is missing value then
${newTabLines(command)}
    set how to "tab"
  else
    tell target
      set s to (split vertically with default profile command ${command})
    end tell
    set how to "split"
  end if
${tagLines(o.id, o.title)}
  return how
end tell`;
}

/** Closes every tab tagged with the session id. Returns the count closed. */
export function closeTabScript(id: string): string {
  return `tell application "iTerm2"
  set closed to 0
  repeat with w in windows
    repeat with t in tabs of w
      repeat with s in sessions of t
        try
          if (variable named ${asString(TAG_VARIABLE)}) of s is ${asString(id)} then
            close s
            set closed to closed + 1
          end if
        end try
      end repeat
    end repeat
  end repeat
  return closed
end tell`;
}

/** Lists the session ids of all tagged tabs, one per line. */
export function listTaggedScript(): string {
  return `tell application "iTerm2"
  set found to {}
  repeat with w in windows
    repeat with t in tabs of w
      repeat with s in sessions of t
        try
          set v to (variable named ${asString(TAG_VARIABLE)}) of s
          if v is not missing value then set end of found to v
        end try
      end repeat
    end repeat
  end repeat
  set AppleScript's text item delimiters to linefeed
  return found as text
end tell`;
}

export const parseTaggedList = parseLines;

// ---- the adapter ---------------------------------------------------------------

export class ITermAdapter implements TerminalAdapter {
  readonly name = "iTerm2";
  readonly splits = true;
  constructor(
    private readonly tmuxBin: string,
    private readonly run: ScriptRunner = runAppleScript,
  ) {}

  async list(): Promise<string[]> {
    return parseTaggedList(await this.run(listTaggedScript()));
  }

  async open(tab: TabOf): Promise<void> {
    await this.run(openTabScript({ tmuxBin: this.tmuxBin, ...tab }));
  }

  async split(tab: TabOf & { nextTo: string }): Promise<"split" | "tab"> {
    const how = await this.run(splitPaneScript({ tmuxBin: this.tmuxBin, ...tab }));
    return how === "split" ? "split" : "tab";
  }

  async close(id: string): Promise<number> {
    return Number(await this.run(closeTabScript(id))) || 0;
  }
}
