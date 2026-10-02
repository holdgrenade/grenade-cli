/**
 * Which conversations a Claude Code process has open right now. Claude Code writes `<claude dir>/sessions/<pid>.json`
 * for every process it runs, naming the conversation (`sessionId`); a file whose process is alive is a conversation
 * in use. These files are Claude Code's own and not a documented format, so anything unexpected counts as nothing.
 */
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

/** Pure: the pid and conversation id of one sessions file, or null when it does not have both. */
export function parseClaudeProcess(json: string): { pid: number; sessionId: string } | null {
  try {
    const value = JSON.parse(json) as { pid?: unknown; sessionId?: unknown };
    if (typeof value?.pid !== "number" || !Number.isInteger(value.pid) || value.pid <= 0) return null;
    if (typeof value.sessionId !== "string" || !value.sessionId) return null;
    return { pid: value.pid, sessionId: value.sessionId };
  } catch {
    return null;
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: it runs, as someone else.
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The ids of the conversations that live Claude Code processes have open. Empty when the folder is missing. */
export async function runningConversationIds(sessionsDir: string, alive: (pid: number) => boolean = isAlive): Promise<Set<string>> {
  const ids = new Set<string>();
  let names: string[];
  try {
    names = await readdir(sessionsDir);
  } catch {
    return ids;
  }
  for (const name of names.filter((n) => /^\d+\.json$/.test(n))) {
    const proc = parseClaudeProcess(await readFile(join(sessionsDir, name), "utf8").catch(() => ""));
    if (proc && alive(proc.pid)) ids.add(proc.sessionId);
  }
  return ids;
}
