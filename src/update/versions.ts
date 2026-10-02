/**
 * Pure logic of updates: which version is newer, what the tap's formula says is the latest release, how this copy
 * of grenade was installed and what command brings it up to date, and the lines the CLI prints about all that.
 */

/** The Homebrew formula in the tap: what `brew upgrade grenade` installs, so "latest" and the upgrade can never disagree. */
export const TAP_FORMULA_URL = "https://raw.githubusercontent.com/holdgrenade/homebrew-tap/main/Formula/grenade.rb";
/** npm's `latest` of the package: what `npm install -g @holdgrenade/cli@latest` installs. An npm copy asks this, not the tap. */
export const NPM_LATEST_URL = "https://registry.npmjs.org/@holdgrenade/cli/latest";

export type InstallMethod = "brew" | "npm" | "source";

export interface UpdateStatus {
  /** The version on disk under the command the daemon was started with, when it could be read. */
  installed?: string;
  /** The latest release its installer offers (the tap for Homebrew, the registry for npm), once a check succeeded. */
  latest?: string;
  /** When the tap was last read (ISO). */
  checkedAt?: string;
  /** Why the last check failed, when it did. */
  error?: string;
  /** How this copy was installed: what installs a newer one, if anything. */
  method?: InstallMethod;
  /** The daemon installs a newer release by itself (`grenade update --auto on|off`, on unless turned off). */
  auto?: boolean;
  /**
   * The daemon can restart itself into a newer version on disk: it runs as the launchd agent. False for one started
   * by hand, which keeps running the old version until someone restarts it. Absent from a status written before 1.0.7.
   */
  restarts?: boolean;
  /** The daemon's own install of the latest release, while it runs or when it could not. Absent otherwise. */
  install?: InstallState;
}

/**
 * The daemon's install: `installing` while brew or npm runs; `failed` (tried again at `retryAt` when automatic);
 * `needsAdmin` when npm's global folder is not this user's, so only `command` (with sudo) can do it; `pinned` when
 * `brew pin grenade` holds it back on purpose.
 */
export type InstallState =
  | { state: "installing"; version: string }
  | { state: "failed"; version: string; error: string; retryAt?: string }
  | { state: "needsAdmin"; version: string; command: string }
  | { state: "pinned"; version: string };

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

/** The version in npm's answer for `latest` (NPM_LATEST_URL). Null when it is not one. */
export function latestFromNpm(body: string): string | null {
  try {
    const v = (JSON.parse(body) as { version?: unknown }).version;
    return typeof v === "string" && /^\d+\.\d+\.\d+/.test(v) ? v : null;
  } catch {
    return null;
  }
}

/**
 * Where the installer of this copy lives, from the resolved path of the `grenade` command, with absolute paths: the
 * daemon runs under launchd, whose PATH has neither brew nor npm. Homebrew: `<prefix>/Cellar/grenade/…` → its
 * `<prefix>/bin/brew`. npm: `<prefix>/lib/node_modules/@holdgrenade/cli/…` → `<prefix>/bin/npm` (nvm, Homebrew's
 * node and the nodejs.org installer all keep npm there), else the npm beside the node running this; npm must be able
 * to write `writes`. Null for a copy built from source.
 */
export type Installer =
  | { method: "brew"; brew: string }
  | { method: "npm"; npm: string[]; writes: string[] };

export function installerFor(resolvedProgram: string, nodePath: string): Installer | null {
  const brew = resolvedProgram.match(/^(.*)\/Cellar\/grenade\//);
  if (brew) return { method: "brew", brew: `${brew[1]}/bin/brew` };
  const npm = resolvedProgram.match(/^((.*)\/lib\/node_modules)\/@holdgrenade\/cli\//);
  if (npm) {
    const nodeBin = nodePath.slice(0, nodePath.lastIndexOf("/"));
    return { method: "npm", npm: [`${npm[2]}/bin/npm`, `${nodeBin}/npm`], writes: [npm[1]!, `${npm[2]}/bin`] };
  }
  return null;
}

/** The commands that install the latest release with that installer, in order (`brew update` first, or brew may not know it yet). */
export function installCommands(i: Installer, npm: string): string[][] {
  if (i.method === "brew") return [[i.brew, "update", "--quiet"], [i.brew, "upgrade", "grenade"]];
  return [[npm, "install", "-g", "@holdgrenade/cli@latest"]];
}

/** What the user can run instead when npm cannot write its global folder. */
export const NPM_ADMIN_COMMAND = "sudo npm install -g @holdgrenade/cli@latest";

/** What a newer release means for a daemon running `running`, given what is on disk and what the tap says. */
export type UpdateState = { kind: "current" } | { kind: "available"; latest: string } | { kind: "installed"; installed: string };

export function updateState(running: string, u: UpdateStatus): UpdateState {
  if (u.installed && isNewer(u.installed, running)) return { kind: "installed", installed: u.installed };
  if (u.latest && isNewer(u.latest, u.installed ?? running)) return { kind: "available", latest: u.latest };
  return { kind: "current" };
}

/** The line after a command's output when there is something to do. Null when there is not. */
export function updateNotice(running: string, u: UpdateStatus): string | null {
  if (u.install?.state === "installing") return `Installing Grenade ${u.install.version}…`;
  if (u.install?.state === "needsAdmin") return `Grenade ${u.install.version} is out. npm needs admin rights to install it: ${u.install.command}`;
  const state = updateState(running, u);
  if (state.kind === "available") return `A new version of Grenade is out: ${running} → ${state.latest}. Update with: grenade update`;
  if (state.kind === "installed" && u.restarts === false) return `Grenade ${state.installed} is installed, but grenaded ${running} was started by hand: stop it and start it again to run it`;
  if (state.kind === "installed") return `Grenade ${state.installed} is installed; grenaded ${running} restarts into it when no session is working (or now: grenade update)`;
  return null;
}

/** The `update:` line of `grenade status`. */
export function updateLine(running: string, u: UpdateStatus, now: number = Date.now()): string {
  const install = u.install;
  if (install?.state === "installing") return `installing ${install.version}…`;
  if (install?.state === "failed" && !(u.installed && isNewer(u.installed, running))) {
    return `${install.version} available; installing it failed (${install.error})${install.retryAt ? ", tries again later" : ""}. Or: grenade update`;
  }
  if (install?.state === "needsAdmin") return `${install.version} available; npm needs admin rights: ${install.command}`;
  if (install?.state === "pinned") return `${install.version} available; held back by brew pin grenade`;
  const state = updateState(running, u);
  if (state.kind === "available") return `${state.latest} available (running ${running}). Install it with: grenade update`;
  if (state.kind === "installed" && u.restarts === false) return `${state.installed} is installed; grenaded was started by hand, so stop it and start it again to run it`;
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
