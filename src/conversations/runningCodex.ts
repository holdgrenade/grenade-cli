/**
 * Which Codex threads are open outside Grenade (PROTOCOL.md "Conversations", Codex's "Open elsewhere"). Codex writes no
 * file that says so, as Claude Code does, so two signs count: a running `codex` whose arguments name the thread (`codex
 * resume <id>`, `codex fork <id>`), or a rollout written in the last RECENT_WRITE_MS. A thread one of Grenade's own
 * sessions is in (running or ended) is never counted: its process and its writes are Grenade's.
 */
import { execFile } from "node:child_process";

/** A rollout written this recently may still be open in a terminal. */
export const RECENT_WRITE_MS = 2 * 60 * 1000;

/** Pure: whether a command line runs Codex itself (`codex …`, or `node …/codex.js …`), not a program that names it. */
export function isCodexProcess(line: string): boolean {
  const [program = "", script = ""] = line.trim().split(/\s+/, 2);
  const base = (path: string) => path.slice(path.lastIndexOf("/") + 1);
  if (base(program) === "codex") return true;
  return ["node", "bun"].includes(base(program)) && /^codex(\.js)?$/.test(base(script));
}

/** Pure: the thread ids among `ids` that a `codex` process's arguments name, from `ps -A -o args=`. */
export function codexIdsInProcesses(psArgs: string, ids: readonly string[]): Set<string> {
  const out = new Set<string>();
  const codexLines = psArgs.split("\n").filter(isCodexProcess);
  for (const id of ids) {
    const lower = id.toLowerCase();
    if (codexLines.some((line) => line.toLowerCase().includes(lower))) out.add(id);
  }
  return out;
}

/** Pure: the threads open elsewhere, from what the processes name and when each rollout was last written. */
export function codexOpenElsewhere(o: {
  rollouts: readonly { id: string; mtimeMs: number }[];
  named: ReadonlySet<string>;
  ours: ReadonlySet<string>;
  now: number;
}): Set<string> {
  const out = new Set<string>();
  for (const r of o.rollouts) {
    if (o.ours.has(r.id)) continue;
    if (o.named.has(r.id) || o.now - r.mtimeMs < RECENT_WRITE_MS) out.add(r.id);
  }
  return out;
}

/** Every process's command line (`ps -A -o args=`); empty when ps fails. */
export function processArgs(): Promise<string> {
  return new Promise((resolve) => {
    execFile("ps", ["-A", "-o", "args="], { timeout: 3000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => resolve(err ? "" : stdout));
  });
}
