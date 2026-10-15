/**
 * The Library's items (PROTOCOL.md "Library"), from what the store found: which group a canvas or plan came from and
 * where that group stands, a canvas's counts, the list's order and cap. Pure.
 */
import {
  boardNameOf,
  LIBRARY_GROUP_GONE,
  LIBRARY_GROUP_KEPT,
  LIBRARY_GROUP_LIVE,
  LIBRARY_ITEMS_MAX,
  LIBRARY_KIND_CANVAS,
  LIBRARY_KIND_PLAN,
  LIBRARY_PLAN_PLANNING,
  LIBRARY_TITLE_MAX,
  type KeptGroup,
  type LibraryItem,
  type Session,
} from "@grenade/protocol";

/** A group the Library remembers: its folder and the name the user gave it, kept after it ended. */
export interface GroupRecord {
  group: string;
  cwd: string;
  name?: string;
}

/** A plan file a session's agent wrote, as the Library remembers it. */
export interface PlanRecord {
  /** The file's bare name in the plans folder. */
  file: string;
  /** The project folder of the session that wrote it. */
  cwd: string;
  group?: string;
  /** The session's title then. */
  session?: string;
  /** `approved` once the agent left plan mode with it; absent when not known (found in an old conversation). */
  state?: "approved" | "draft";
}

/** What the groups are now: the sessions the daemon lists and the groups it keeps. */
export interface GroupsNow {
  sessions: readonly Session[];
  kept: readonly KeptGroup[];
  remembered: ReadonlyMap<string, GroupRecord>;
}

const groupOf = (s: Session): string => s.group ?? s.id;

/** `live`, `kept` or `gone`, and the group's name, for a group id. */
export function groupStateOf(group: string, now: GroupsNow): { groupState: string; groupName?: string } {
  const live = now.sessions.find((s) => groupOf(s) === group && s.status !== "gone");
  if (live) return { groupState: LIBRARY_GROUP_LIVE, ...(live.groupName ? { groupName: live.groupName } : {}) };
  const kept = now.kept.find((k) => k.group === group);
  if (kept) return { groupState: LIBRARY_GROUP_KEPT, ...(kept.name ? { groupName: kept.name } : {}) };
  const ended = now.sessions.find((s) => groupOf(s) === group);
  const name = ended?.groupName ?? now.remembered.get(group)?.name;
  return { groupState: LIBRARY_GROUP_GONE, ...(name ? { groupName: name } : {}) };
}

/** How many revisions a canvas's boards are in: each `R<n>` once, and the boards without one as one more. */
export function revisionsOf(files: readonly string[]): number {
  const revisions = new Set<string>();
  for (const f of files) revisions.add(String(boardNameOf(f).revision ?? "none"));
  return revisions.size;
}

/** What the store found of one canvas. */
export interface FoundCanvas {
  folder: string;
  cwd: string;
  /** The group folder it is in; absent for `shared`. */
  group?: string;
  canvas: string;
  title: string;
  files: string[];
  /** The newest board's save time, ms. */
  modifiedMs: number;
}

export function canvasItem(found: FoundCanvas, now: GroupsNow): LibraryItem {
  return {
    kind: LIBRARY_KIND_CANVAS,
    id: `canvas:${found.folder}`,
    title: found.title.slice(0, LIBRARY_TITLE_MAX),
    cwd: found.cwd,
    ...(found.group ? { group: found.group, ...groupStateOf(found.group, now) } : {}),
    modified: new Date(found.modifiedMs).toISOString(),
    canvas: found.canvas,
    boards: found.files.length,
    revisions: revisionsOf(found.files),
  };
}

/** What the store read of a plan's file. */
export interface FoundPlan {
  record: PlanRecord;
  title: string;
  preview: string;
  modifiedMs: number;
}

/** A plan is `planning` while a session that is not gone plans in it now; else what the record says. */
export function planItem(found: FoundPlan, now: GroupsNow, planningFiles: ReadonlySet<string>): LibraryItem {
  const { record } = found;
  const state = planningFiles.has(record.file) ? LIBRARY_PLAN_PLANNING : record.state;
  return {
    kind: LIBRARY_KIND_PLAN,
    id: `plan:${record.file}`,
    title: found.title.slice(0, LIBRARY_TITLE_MAX),
    cwd: record.cwd,
    ...(record.group ? { group: record.group, ...groupStateOf(record.group, now) } : {}),
    modified: new Date(found.modifiedMs).toISOString(),
    plan: record.file,
    ...(state ? { planState: state } : {}),
    ...(record.session ? { session: record.session.slice(0, 120) } : {}),
    ...(found.preview ? { preview: found.preview } : {}),
  };
}

/** Newest first, at most `LIBRARY_ITEMS_MAX`. */
export function libraryList(items: LibraryItem[]): { items: LibraryItem[]; truncated?: true } {
  const sorted = [...items].sort((a, b) => (a.modified === b.modified ? a.id.localeCompare(b.id) : a.modified < b.modified ? 1 : -1));
  return sorted.length > LIBRARY_ITEMS_MAX ? { items: sorted.slice(0, LIBRARY_ITEMS_MAX), truncated: true } : { items: sorted };
}

/** The plan files a transcript line names in `plansFolder`, by bare name. */
export function planFilesIn(line: string, plansFolder: string): string[] {
  const out = new Set<string>();
  const escaped = plansFolder.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`${escaped}/([A-Za-z0-9][A-Za-z0-9._-]{0,200}\\.md)`, "g");
  for (const m of line.matchAll(re)) out.add(m[1]!);
  return [...out];
}

/** The `cwd` a Claude Code transcript line carries, or undefined. */
export function cwdIn(line: string): string | undefined {
  const m = /"cwd":"((?:[^"\\]|\\.)*)"/.exec(line);
  if (!m) return undefined;
  try {
    return JSON.parse(`"${m[1]}"`) as string;
  } catch {
    return undefined;
  }
}
