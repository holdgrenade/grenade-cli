/** Looks at this Mac for what `requirements.ts` judges. */
import { execFileSync } from "node:child_process";
import { isITermInstalled } from "../terminal/iterm.js";
import type { Found } from "./requirements.js";

export function findRequirements(): Found {
  return {
    platform: process.platform,
    node: process.versions.node,
    tmux: output(process.env["TMUX_BIN"] ?? "tmux", ["-V"]),
    brew: onPath("brew"),
    claude: Boolean(process.env["CLAUDE_BIN"]) || onPath("claude"),
    codex: onPath("codex"),
    iterm: isITermInstalled(),
  };
}

function onPath(command: string): boolean {
  return output("/usr/bin/which", [command]) !== null;
}

function output(command: string, args: string[]): string | null {
  try {
    return execFileSync(command, args, { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return null;
  }
}
