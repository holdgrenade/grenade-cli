/**
 * Pure: the background tasks a session lists while they hold it `working` (PROTOCOL.md "Background tasks").
 * A held task is the protocol's `BackgroundTask` plus the agent's id for it, which keeps its start time from one
 * report to the next. The id stays on the Mac (sessions.json); a client gets the task without it.
 */
import { BackgroundTask, type ReportedBackgroundTask } from "@grenade/protocol";

export type HeldTask = BackgroundTask & { id: string };

/** No tasks. One shared array, so "nothing held" compares by identity. */
export const NO_TASKS: readonly HeldTask[] = Object.freeze([]);

/**
 * The tasks a report lists, each with the time it started: the time it had before, else the time a hook saw it start
 * (`starts`), else now. Returns `before` itself when nothing changed, so a repeated report sends nothing.
 */
export function heldTasks(reported: readonly ReportedBackgroundTask[], before: readonly HeldTask[], starts: ReadonlyMap<string, string>, now: string): readonly HeldTask[] {
  if (reported.length === 0) return NO_TASKS;
  const next = reported.map(({ id, kind, title, command }): HeldTask => {
    const since = before.find((t) => t.id === id)?.since ?? starts.get(id) ?? now;
    return { id, kind, ...(title ? { title } : {}), ...(command ? { command } : {}), since };
  });
  return JSON.stringify(next) === JSON.stringify(before) ? before : next;
}

/** A held task as a client sees it. */
export function shownTask({ id: _id, ...task }: HeldTask): BackgroundTask {
  return task;
}

/** `count` tasks of which only the number is known (read off a screen): shell commands without a title. */
export function countedTasks(count: number): ReportedBackgroundTask[] {
  return Array.from({ length: Math.max(0, count) }, (_, i) => ({ id: `#${i}`, kind: "shell" }));
}

/** The held tasks saved in sessions.json; anything that is not one is dropped. */
export function restoreHeld(saved: unknown): readonly HeldTask[] {
  if (!Array.isArray(saved)) return NO_TASKS;
  const held = saved.flatMap((entry: unknown): HeldTask[] => {
    const id = (entry as { id?: unknown } | null)?.id;
    const task = BackgroundTask.safeParse(entry);
    return typeof id === "string" && id && task.success ? [{ ...task.data, id }] : [];
  });
  return held.length > 0 ? held : NO_TASKS;
}
