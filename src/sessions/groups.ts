/**
 * Pure rules for session groups (see "Groups" in PROTOCOL.md). A group is an opaque id shared by
 * sessions that belong together; it only changes how sessions are shown, never how they run.
 */
import { GROUP_NAME_MAX, type Session } from "@grenade/protocol";

const live = (s: Session): boolean => s.status !== "gone";

/** The group a new session in `cwd` joins by default: the oldest live session in that folder's, or null. */
export function defaultGroupFor(cwd: string, sessions: readonly Session[]): string | null {
  const sameFolder = sessions
    .filter((s) => live(s) && s.group !== undefined && s.cwd === cwd && cwd !== "")
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return sameFolder[0]?.group ?? null;
}

/** True when a live session other than `exceptId` is in `group`, so it can be joined. */
export function isJoinableGroup(group: string, sessions: readonly Session[], exceptId?: string): boolean {
  return sessions.some((s) => live(s) && s.id !== exceptId && s.group === group);
}

/** Group order: `order` first (missing goes last), then oldest, then id. */
export function byGroupOrder(a: Session, b: Session): number {
  const ao = a.order ?? Number.MAX_SAFE_INTEGER;
  const bo = b.order ?? Number.MAX_SAFE_INTEGER;
  if (ao !== bo) return ao - bo;
  return a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
}

/** Every member of `group` (live and gone), in group order. */
export function membersInOrder(group: string, sessions: readonly Session[]): Session[] {
  return sessions.filter((s) => s.group === group).sort(byGroupOrder);
}

/** Live members of `group` other than `exceptId`, in group order. */
export function otherMembers(group: string, sessions: readonly Session[], exceptId: string): Session[] {
  return membersInOrder(group, sessions).filter((s) => live(s) && s.id !== exceptId);
}

/** The name the user gave `group` (PROTOCOL.md "Group names"): what a member other than `exceptId` carries. */
export function groupNameOf(group: string, sessions: readonly Session[], exceptId?: string): string | undefined {
  return sessions.find((s) => s.group === group && s.id !== exceptId && s.groupName !== undefined)?.groupName;
}

/** `session` carrying `name` as its group's name, or none. */
export function named(session: Session, name: string | undefined): Session {
  const { groupName: _was, ...rest } = session;
  return name === undefined ? rest : { ...rest, groupName: name };
}

/** A name as it was typed, ready to keep: trimmed, at most `GROUP_NAME_MAX` long. Undefined when nothing is left. */
export function cleanGroupName(name: string | null): string | undefined {
  const clean = (name ?? "").trim().slice(0, GROUP_NAME_MAX).trim();
  return clean === "" ? undefined : clean;
}

/** The `order` for a session added last to `group`. */
export function nextOrder(group: string, sessions: readonly Session[], exceptId?: string): number {
  const orders = sessions.filter((s) => s.group === group && s.id !== exceptId && s.order !== undefined).map((s) => s.order as number);
  return orders.length === 0 ? 0 : Math.max(...orders) + 1;
}

/**
 * The group's member ids after `id` is placed at `index` (clamped to the end); `id` is taken out
 * of `ids` first if it is there. Index 0 is first.
 */
export function placeAt(ids: readonly string[], id: string, index: number): string[] {
  const rest = ids.filter((x) => x !== id);
  const at = Math.max(0, Math.min(index, rest.length));
  return [...rest.slice(0, at), id, ...rest.slice(at)];
}
