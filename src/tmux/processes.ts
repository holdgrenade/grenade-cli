/** Pure helpers for finding a tmux session's process tree from `ps` output. No I/O. */

/** `tmux list-panes -F '#{pane_pid}'` → pids. */
export function parsePidList(out: string): number[] {
  return out
    .split("\n")
    .map((l) => Number.parseInt(l.trim(), 10))
    .filter((n) => Number.isInteger(n) && n > 1);
}

/** `ps -A -o pid=,ppid=` → [pid, ppid] pairs. */
export function parsePsTable(out: string): [pid: number, ppid: number][] {
  const rows: [number, number][] = [];
  for (const line of out.split("\n")) {
    const [pid, ppid] = line.trim().split(/\s+/).map((n) => Number.parseInt(n, 10));
    if (pid !== undefined && ppid !== undefined && !Number.isNaN(pid) && !Number.isNaN(ppid)) rows.push([pid, ppid]);
  }
  return rows;
}

/** The roots and all their descendants, deepest first so children go before the parents that might respawn them. Never includes pid 0 or 1. */
export function processTree(table: [number, number][], roots: number[]): number[] {
  const children = new Map<number, number[]>();
  for (const [pid, ppid] of table) children.set(ppid, [...(children.get(ppid) ?? []), pid]);
  const seen = new Set<number>();
  const order: number[] = [];
  const visit = (pid: number) => {
    if (pid <= 1 || seen.has(pid)) return;
    seen.add(pid);
    for (const c of children.get(pid) ?? []) visit(c);
    order.push(pid);
  };
  roots.forEach(visit);
  return order;
}
