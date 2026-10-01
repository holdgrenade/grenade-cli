/**
 * Pure rules for the order groups are listed in (PROTOCOL.md "Group order"). The order is the user's:
 * a status change never moves a group, so every client shows the groups the same way.
 */
import type { Session } from "@grenade/protocol";
import { placeAt } from "./groups.js";

/** The group id of a session; a session without one (older data) is a group of its own. */
const groupOf = (s: Session): string => s.group ?? s.id;

/**
 * `order` brought in line with `sessions`: groups without a session are dropped, and groups not
 * placed yet go to the top, newest first (by their oldest member's `createdAt`).
 */
export function reconcileGroupOrder(order: readonly string[], sessions: readonly Session[]): string[] {
  const born = new Map<string, string>();
  for (const s of sessions) {
    const g = groupOf(s);
    const at = born.get(g);
    if (at === undefined || s.createdAt < at) born.set(g, s.createdAt);
  }
  const kept = [...new Set(order)].filter((g) => born.has(g));
  const arrivals = [...born.keys()]
    .filter((g) => !kept.includes(g))
    .sort((a, b) => (born.get(b) as string).localeCompare(born.get(a) as string) || a.localeCompare(b));
  return [...arrivals, ...kept];
}

/** `order` with `group`, a group a session was just moved out into, right under the group it left. */
export function placeUnder(order: readonly string[], group: string, left: string): string[] {
  const rest = order.filter((g) => g !== group);
  const at = rest.indexOf(left);
  return at === -1 ? [group, ...rest] : placeAt(rest, group, at + 1);
}

/** `order` with `group` moved to `index` (clamped to the end). */
export function moveGroup(order: readonly string[], group: string, index: number): string[] {
  return placeAt(order, group, index);
}

export function sameOrder(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((g, i) => g === b[i]);
}
