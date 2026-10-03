/**
 * What Codex's screen says about background terminals. Pure. Codex's hooks do not mention them: a command it left
 * running shows only as a line above its prompt box, "1 background terminal running · /ps to view · /stop to close",
 * which goes when the last one ends (Codex 0.160). Nothing wakes Codex then; the turn that started them was its last
 * word.
 */
const RUNNING = /^\s*(\d+) background terminals? running\b/;

/** How many background terminals the screen says are running; 0 when it says nothing. */
export function codexBackgroundIn(lines: readonly string[]): number {
  for (const line of lines) {
    const count = RUNNING.exec(line)?.[1];
    if (count) return Number(count);
  }
  return 0;
}
