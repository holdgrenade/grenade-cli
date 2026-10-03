/**
 * `grenade terminal [iterm | terminal | auto | none]`: whether each session also opens in a terminal on the Mac.
 * Off (`none`) unless asked for: the Mac app and the phone show every session. Writes `~/.grenade/terminal.json`,
 * then tells a running daemon, which opens the tabs at once. Without a kind it says what is set.
 */
import { InvalidArgumentError, type Command } from "commander";
import { isTerminalKind, TERMINAL_KINDS, type TerminalKind, type TerminalStatus } from "../terminal/mirror.js";
import { readTerminalSetting, writeTerminalSetting } from "../terminal/terminalSetting.js";
import type { Control } from "./controlClient.js";

export interface TerminalCommandDeps {
  control: Control;
}

export function registerTerminalCommand(program: Command, d: TerminalCommandDeps): void {
  program
    .command("terminal [kind]")
    .description("also open each session in a terminal on the Mac: iterm (one tab per folder), terminal (Terminal.app), auto, or none (the default)")
    .action(async (kind: string | undefined) => {
      if (kind !== undefined) {
        if (!isTerminalKind(kind)) throw new InvalidArgumentError(`expected ${TERMINAL_KINDS.join(", ")}`);
        writeTerminalSetting(kind);
      }
      const method = kind === undefined ? "GET" : "POST";
      const s = await d.control<TerminalStatus>(method, kind === undefined ? "/terminal" : "/terminal/reload").catch(() => null);
      for (const line of terminalLines(readTerminalSetting(), s, process.platform)) console.log(line);
    });
}

/** What `grenade terminal` prints: the setting, what the daemon does with it, and how to change it. Pure. */
export function terminalLines(setting: TerminalKind, s: TerminalStatus | null, platform: string = "darwin"): string[] {
  if (platform !== "darwin") return linuxLines(setting);
  const lines = [`terminal  ${setting}  (${describe(setting)})`];
  if (!s) lines.push("grenaded is not running, or is older than this command; it takes effect when it starts.");
  else if (s.pinned && s.terminal !== setting) {
    lines.push(`grenaded ignores this: it was started with --terminal ${s.terminal} or GRENADE_TERMINAL=${s.terminal}.`);
    lines.push("Run grenade service install to start it without, then this setting counts.");
  } else if (s.terminal !== "none" && s.using === null) lines.push("No such terminal is installed, so nothing opens.");
  else if (s.using) lines.push(`Sessions open in ${s.using}. The first time, allow grenaded (node) to control it when macOS asks.`);
  if (setting === "none") lines.push("Open each session in a terminal too with: grenade terminal iterm (or terminal for Terminal.app)");
  else lines.push("Turn it off with: grenade terminal none");
  return lines;
}

/** iTerm2 and Terminal.app are Mac terminals: on Linux no window opens, whatever is set. */
function linuxLines(setting: TerminalKind): string[] {
  const lines = ["Sessions open in no terminal window on Linux: iTerm2 and Terminal.app are Mac terminals.", "Watch them on your phone, or attach from any terminal with: grenade open <name>"];
  if (setting !== "none") lines.push(`The setting (${setting}) does nothing here. Clear it with: grenade terminal none`);
  return lines;
}

function describe(kind: TerminalKind): string {
  switch (kind) {
    case "none":
      return "sessions open in no terminal; watch them in the Grenade app or attach with grenade open <name>";
    case "iterm":
      return "each folder's sessions side by side in one iTerm2 tab";
    case "terminal":
      return "each session in a Terminal.app window";
    case "auto":
      return "iTerm2 when it is installed, else Terminal.app";
  }
}
