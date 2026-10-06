/**
 * Which canvases this daemon serves (PROTOCOL.md "Canvas", "Which folders"): only that of a folder a session it lists
 * works in, or of the folder a group's sessions share. So a phone cannot use the canvas to look into any other folder.
 * Pure.
 */
import { posix } from "node:path";
import { CANVAS_FOLDER, type Session } from "@grenade/protocol";
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
 * `.grenade`, that project, `projectOf`), and for a group of several the
 * folder its members share (the Mac app's `Canvas.folder(for:)`; when they share only `/`, its first member's `cwd`,
 * which is in the set already).
 */
export function canvasCwds(sessions: Session[], home: string): Set<string> {
  const allowed = new Set<string>();
  const groups = new Map<string, string[]>();
  for (const s of sessions) {
    const own = normalizeCwd(s.cwd, home);
    if (!own) continue;
    allowed.add(own);
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
