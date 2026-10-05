/** Reads usage off the end of a Codex rollout, and the user's own Claude Code status line (PROTOCOL.md "Usage"). */
import { readFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { codexUsageIn, type CodexUsage } from "./codexUsage.js";
import { userStatusLineIn, type UserStatusLine } from "./claudeStatusLine.js";

/** The last replies; a `token_count` comes after every Codex turn. */
const TAIL_BYTES = 256 * 1024;

async function readTail(path: string): Promise<string> {
  const file = await open(path, "r");
  try {
    const { size } = await file.stat();
    const length = Math.min(size, TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    await file.read(buffer, 0, length, size - length);
    return buffer.toString("utf8");
  } finally {
    await file.close();
  }
}

export async function readCodexUsage(rolloutPath: string): Promise<CodexUsage | null> {
  return codexUsageIn(await readTail(rolloutPath));
}

/** The user's status line from their Claude Code settings, read when a session starts; none when there is none or no file. */
export function readUserStatusLine(settingsPath: string): UserStatusLine | undefined {
  try {
    return userStatusLineIn(JSON.parse(readFileSync(settingsPath, "utf8")));
  } catch {
    return undefined;
  }
}
