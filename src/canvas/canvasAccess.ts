/**
 * Which canvases this daemon serves (PROTOCOL.md "Canvas", "Which folders"): only that of a folder a session it lists
 * works in, or of the folder a group's sessions share. So a phone cannot use the canvas to look into any other folder.
 * Pure.
 */
import { posix } from "node:path";
import { CANVAS_FOLDER, CANVAS_SHARED, type Session } from "@grenade/protocol";
import { expandHome } from "../folders/listFolders.js";

/** `cwd` as one path: `~` expanded, `.`, `..` and a trailing `/` resolved. Null for a path that is neither absolute nor `~`. */
export function normalizeCwd(cwd: string, home: string): string | null {
  const expanded = expandHome(cwd, home);
  if (!expanded.startsWith("/")) return null;
  return posix.resolve(expanded);
}

/**
 * The project a folder belongs to when it lies inside the project's `.grenade` (a session started in its canvas
 * folder works on that project's canvas), else the folder itself. `/a/web/.grenade/canvas` → `/a/web`.
 */
export function projectOf(path: string): string {
  const at = path.split("/").indexOf(".grenade");
  if (at <= 1) return path;
  return path.split("/").slice(0, at).join("/");
}

/** The longest folder every path starts with (whole names only), or null when they share nothing but `/`. */
export function sharedFolder(paths: string[]): string | null {
  if (paths.length === 0) return null;
  let shared = paths[0]!.split("/").filter(Boolean);
  for (const path of paths.slice(1)) {
    const parts = path.split("/").filter(Boolean);
    let i = 0;
    while (i < shared.length && i < parts.length && shared[i] === parts[i]) i++;
    shared = shared.slice(0, i);
  }
  return shared.length === 0 ? null : `/${shared.join("/")}`;
}

/**
 * Every folder whose canvas may be served: each session's `cwd` (a `gone` one too; for a `cwd` inside a project's
 * `.grenade`, that project, `projectOf`) and its group's `canvasCwd`, and for a group of several the
 * folder its members share (what a client from before `canvasCwd` asks for; when they share only `/`, its first
 * member's `cwd`, which is in the set already).
 */
export function canvasCwds(sessions: Session[], home: string): Set<string> {
  const allowed = new Set<string>();
  const groups = new Map<string, string[]>();
  for (const s of sessions) {
    const own = normalizeCwd(s.cwd, home);
    if (!own) continue;
    allowed.add(own);
    const fixed = s.canvasCwd ? normalizeCwd(s.canvasCwd, home) : null;
    if (fixed) allowed.add(fixed);
    // A session inside a project's `.grenade` works on that project's canvas.
    const cwd = projectOf(own);
    allowed.add(cwd);
    const key = s.group ?? s.id;
    groups.set(key, [...(groups.get(key) ?? []), cwd]);
  }
  for (const cwds of groups.values()) {
    const shared = cwds.length > 1 ? sharedFolder(cwds) : null;
    if (shared) allowed.add(shared);
  }
  return allowed;
}

/** The folder `cwd` names when its canvas may be served, else null. */
export function allowedCanvasCwd(cwd: string, sessions: Session[], home: string): string | null {
  const normalized = normalizeCwd(cwd, home);
  return normalized && canvasCwds(sessions, home).has(normalized) ? normalized : null;
}

/** The canvas folder of a (normalized) `cwd`. */
export function canvasFolderOf(cwd: string): string {
  return posix.join(cwd, CANVAS_FOLDER);
}

/** A group's folder under a (normalized) `cwd`, where its canvases are: `<cwd>/.grenade/canvas/<group>`. */
export function groupFolderOf(cwd: string, group: string): string {
  return posix.join(cwd, CANVAS_FOLDER, group);
}

/** One of a group's canvases under a (normalized) `cwd`: `<cwd>/.grenade/canvas/<group>/canvas-2`; `shared` is `<cwd>/.grenade/canvas`. */
export function groupCanvasFolderOf(cwd: string, group: string, canvas: string): string {
  return canvas === CANVAS_SHARED ? canvasFolderOf(cwd) : posix.join(groupFolderOf(cwd, group), canvas);
}

/** Whether `group` is the group of a session the daemon lists (a `gone` one too): `group`, or `id` for a group of one. */
export function isListedGroup(group: string, sessions: Session[]): boolean {
  return sessions.some((s) => (s.group ?? s.id) === group);
}

/**
 * The folder a session's group keeps its canvases in (PROTOCOL.md "Canvas", "Where they are"): its `canvasCwd`, fixed
 * for the group; for a session that carries none, the folder every member's `cwd` (read as its project, `projectOf`)
 * starts with, else the session's own. Null when neither is a path.
 */
export function groupCwdOf(session: Session, sessions: readonly Session[], home: string): string | null {
  const fixed = session.canvasCwd ? normalizeCwd(session.canvasCwd, home) : null;
  if (fixed) return fixed;
  return sharedCwdOf(session, sessions, home);
}

/**
 * The canvas folder to fix for a group whose members carry none (saved by a daemon before `canvasCwd`): the project of
 * its oldest member that already holds the group's folder (`hasGroupFolder`, `<project>/.grenade/canvas/<group>`), so
 * canvases made there stay where they are; else the folder the members share (`sharedCwdOf`). Null with no path.
 */
export function firstCanvasCwdOf(
  group: string,
  sessions: readonly Session[],
  home: string,
  hasGroupFolder: (project: string) => boolean,
): string | null {
  const members = sessions.filter((s) => (s.group ?? s.id) === group).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const first = members[0];
  if (!first) return null;
  for (const m of members) {
    const own = normalizeCwd(m.cwd, home);
    if (own && hasGroupFolder(projectOf(own))) return projectOf(own);
  }
  return sharedCwdOf(first, members, home);
}

/** The folder a session's group shares as its members' `cwd`s give it, ignoring `canvasCwd` (what older clients ask for). */
export function sharedCwdOf(session: Session, sessions: readonly Session[], home: string): string | null {
  const key = session.group ?? session.id;
  const cwds = sessions
    .filter((s) => (s.group ?? s.id) === key)
    .map((s) => normalizeCwd(s.cwd, home))
    .flatMap((c) => (c ? [projectOf(c)] : []));
  const own = normalizeCwd(session.cwd, home);
  return (cwds.length > 1 ? sharedFolder(cwds) : null) ?? (own ? projectOf(own) : null);
}
