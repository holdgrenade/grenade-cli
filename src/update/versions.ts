/**
 * Pure logic of updates: which version is newer, what the tap's formula says is the latest release, how this copy
 * of grenade was installed and what command brings it up to date, and the lines the CLI prints about all that.
 */

/** The Homebrew formula in the tap: what `brew upgrade grenade` installs, so "latest" and the upgrade can never disagree. */
export const TAP_FORMULA_URL = "https://raw.githubusercontent.com/holdgrenade/homebrew-tap/main/Formula/grenade.rb";

export type InstallMethod = "brew" | "npm" | "source";

export interface UpdateStatus {
  /** The version on disk under the command the daemon was started with, when it could be read. */
  installed?: string;
  /** The latest release, from the tap, once a check succeeded. */
  latest?: string;
  /** When the tap was last read (ISO). */
  checkedAt?: string;
  /** Why the last check failed, when it did. */
  error?: string;
}

/** The version of the release the formula installs: the `vX.Y.Z` in its download URL. */
export function latestFromFormula(formula: string): string | null {
  const m = formula.match(/\/releases\/download\/v(\d+\.\d+\.\d+)\//);
  return m?.[1] ?? null;
}

/** `a` is a higher version than `b`. Plain `major.minor.patch`; anything after a `-` counts as older than the release. */
export function isNewer(a: string, b: string): boolean {
  return compareVersions(a, b) > 0;
}

export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  for (let i = 0; i < 3; i++) {
    const d = (pa.parts[i] ?? 0) - (pb.parts[i] ?? 0);
    if (d !== 0) return d;
  }
  if (pa.pre === pb.pre) return 0;
  if (pa.pre === null) return 1;
  if (pb.pre === null) return -1;
  return pa.pre < pb.pre ? -1 : 1;
}

function parseVersion(v: string): { parts: number[]; pre: string | null } {
  const [core = "", ...rest] = v.replace(/^v/, "").split("-");
  return { parts: core.split(".").map((n) => Number.parseInt(n, 10) || 0), pre: rest.length ? rest.join("-") : null };
}

/** How this copy was installed, from the resolved path of the `grenade` command (symlinks followed). */
export function installMethodOf(resolvedProgram: string): InstallMethod {
  if (/\/Cellar\/grenade\//.test(resolvedProgram)) return "brew";
  if (/\/node_modules\/@holdgrenade\/cli\//.test(resolvedProgram)) return "npm";
  return "source";
}

/** The commands that install the latest release for that method, in order. `brew update` first, or brew may not know it yet. */
export function updateCommandsFor(method: InstallMethod): string[][] | null {
  if (method === "brew") return [["brew", "update", "--quiet"], ["brew", "upgrade", "grenade"]];
  if (method === "npm") return [["npm", "install", "-g", "@holdgrenade/cli@latest"]];
  return null;
}

/** What a newer release means for a daemon running `running`, given what is on disk and what the tap says. */
export type UpdateState = { kind: "current" } | { kind: "available"; latest: string } | { kind: "installed"; installed: string };

export function updateState(running: string, u: UpdateStatus): UpdateState {
  if (u.installed && isNewer(u.installed, running)) return { kind: "installed", installed: u.installed };
  if (u.latest && isNewer(u.latest, u.installed ?? running)) return { kind: "available", latest: u.latest };
  return { kind: "current" };
}

/** The line after a command's output when there is something to do. Null when there is not. */
export function updateNotice(running: string, u: UpdateStatus): string | null {
  const state = updateState(running, u);
  if (state.kind === "available") return `A new version of Grenade is out: ${running} → ${state.latest}. Update with: grenade update`;
  if (state.kind === "installed") return `Grenade ${state.installed} is installed; grenaded ${running} restarts into it when no session is working (or now: grenade update)`;
  return null;
}

/** The `update:` line of `grenade status`. */
export function updateLine(running: string, u: UpdateStatus, now: number = Date.now()): string {
  const state = updateState(running, u);
  if (state.kind === "available") return `${state.latest} available (running ${running}). Install it with: grenade update`;
  if (state.kind === "installed") return `${state.installed} is installed; grenaded restarts into it when no session is working (or now: grenade update)`;
  if (u.error && !u.latest) return `could not check for a new version: ${u.error}`;
  if (!u.checkedAt) return "not checked yet";
  return `up to date (checked ${agoText(now - Date.parse(u.checkedAt))})`;
}

function agoText(ms: number): string {
  const min = Math.max(0, Math.round(ms / 60_000));
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  return h < 24 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
}

/**
 * Whether a daemon running `running` should restart now to run the `installed` version: only into a newer one,
 * and never while a session is busy (working, or holding a question for the phone): a restart loses the hooks of
 * those seconds and closes a card the phone is about to answer.
 */
export function restartDecision(running: string, installed: string | null, busy: boolean): "restart" | "wait" | "none" {
  if (!installed || !isNewer(installed, running)) return "none";
  return busy ? "wait" : "restart";
}

/** A session that a restart would interrupt. */
export function isBusy(s: { status: string; waitingFor?: string | undefined }): boolean {
  return s.status === "working" || (s.status === "waiting" && s.waitingFor === "answer");
}
