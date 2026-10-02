/**
 * The daemon's side of updates. Every 6 hours it asks for the latest release (the tap's formula for a Homebrew copy,
 * npm's registry for an npm one), and unless turned off (`grenade update --auto off`) installs it itself with the
 * same installer (`installer.ts`); a failed install is tried again an hour later. Every minute it reads the version
 * on disk. When a newer one has been installed (by itself, `grenade update`, `brew upgrade`) and no session is busy,
 * it calls `restart`: under launchd the daemon exits and launchd starts the new version. The Mac app shows all of it
 * and asks for an install now through the control API (`POST /update/install`).
 */
import type { Logger } from "../log.js";
import { runInstall, type InstallOutcome } from "./installer.js";
import {
  isNewer,
  latestFromFormula,
  latestFromNpm,
  NPM_ADMIN_COMMAND,
  NPM_LATEST_URL,
  restartDecision,
  TAP_FORMULA_URL,
  type Installer,
  type UpdateStatus,
} from "./versions.js";

export const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
export const DISK_EVERY_MS = 60 * 1000;
export const RETRY_MS = 60 * 60 * 1000;
const FIRST_CHECK_MS = 10 * 1000;
const FETCH_TIMEOUT_MS = 10 * 1000;

export interface UpdateCheckerDeps {
  running: string;
  log: Logger;
  /** The version on disk now, or null when it cannot be read. */
  installed(): string | null;
  /** A session would be interrupted by a restart. */
  busy(): boolean;
  /** Read the tap's formula. Defaults to `fetch`. */
  fetchFormula?(): Promise<string>;
  /** Called once a newer version is on disk and nothing is busy. Absent: only log that a restart would run it. */
  restart?(installed: string): void;
  /** Ask the tap. Off for tests and with GRENADE_UPDATE_CHECK=off; the disk is still watched. */
  checkTap: boolean;
  /** What installs a newer release for this copy (`installerFor`). Absent or null: built from source, never installed. */
  installer?: Installer | null;
  /** Read npm's `latest` (NPM_LATEST_URL). Defaults to `fetch`. */
  fetchNpm?(): Promise<string>;
  /** Install the latest release. Defaults to `runInstall`. */
  install?(i: Installer): Promise<InstallOutcome>;
  /** Install by itself when one is out. Read at every check; absent: never by itself. */
  auto?(): boolean;
}

export class UpdateChecker {
  private status: UpdateStatus = {};
  private readonly timers: NodeJS.Timeout[] = [];
  private restarting = false;
  private toldInstalled: string | null = null;
  private toldLatest: string | null = null;
  private retryTimer: NodeJS.Timeout | null = null;

  constructor(private readonly d: UpdateCheckerDeps) {}

  start(): void {
    this.readDisk();
    if (this.d.checkTap) {
      this.timers.push(setTimeout(() => void this.checkTap(), FIRST_CHECK_MS));
      this.timers.push(setInterval(() => void this.checkTap(), CHECK_EVERY_MS));
    }
    this.timers.push(setInterval(() => this.watchDisk(), DISK_EVERY_MS));
    for (const t of this.timers) t.unref();
  }

  stop(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    for (const t of this.timers) clearTimeout(t);
    this.timers.length = 0;
  }

  current(): UpdateStatus {
    const auto = this.d.auto?.() ?? false;
    const method = this.d.installer?.method ?? ("source" as const);
    return { ...this.status, method, auto, restarts: this.d.restart !== undefined };
  }

  /** Reads the tap now. `grenade update` and `grenade status --check` call it through the control API. */
  async checkTap(): Promise<UpdateStatus> {
    this.readDisk();
    const checkedAt = new Date().toISOString();
    try {
      const npm = this.d.installer?.method === "npm";
      const latest = npm ? latestFromNpm(await (this.d.fetchNpm ?? fetchNpm)()) : latestFromFormula(await (this.d.fetchFormula ?? fetchFormula)());
      if (!latest) throw new Error(npm ? "npm names no version" : "the tap's formula names no version");
      this.status = { ...this.status, latest, checkedAt };
      delete this.status.error;
      if (latest !== this.toldLatest && isNewer(latest, this.status.installed ?? this.d.running)) {
        this.toldLatest = latest;
        this.d.log.info(`Grenade ${latest} is out (running ${this.d.running}). Update with: grenade update`);
      }
      void this.install(false);
    } catch (e) {
      this.status = { ...this.status, checkedAt, error: e instanceof Error ? e.message : String(e) };
      this.d.log.debug("Could not check for a new version", { error: e });
    }
    return this.current();
  }

  /** The Mac app's Update (and Try Again): install the latest release now, automatic or not. Answers at once. */
  async installNow(): Promise<UpdateStatus> {
    if (!this.status.latest) await this.checkTap();
    void this.install(true);
    return this.current();
  }

  /**
   * Installs the latest release when it is newer than what is on disk: by itself only when `auto` is on and it has not
   * just failed, given up (npm needs admin rights) or been held back (`brew pin`) for that version; always when asked.
   * Sets `installing` before it awaits anything, so `installNow` answers with it.
   */
  private async install(asked: boolean): Promise<void> {
    const i = this.d.installer;
    const latest = this.status.latest;
    if (!i || !latest || !isNewer(latest, this.readDisk() ?? this.d.running)) return;
    const prior = this.status.install;
    if (prior?.state === "installing") return;
    if (!asked) {
      if (!(this.d.auto?.() ?? false)) return;
      if (prior && prior.version === latest && prior.state !== "failed") return;
      if (prior?.state === "failed" && prior.version === latest && (!prior.retryAt || Date.parse(prior.retryAt) > Date.now())) return;
    }
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.status = { ...this.status, install: { state: "installing", version: latest } };
    this.d.log.info(`Installing Grenade ${latest} with ${i.method === "brew" ? "Homebrew" : "npm"}`);
    const outcome = await (this.d.install ?? runInstall)(i).catch((e: unknown) => ({ kind: "failed" as const, error: e instanceof Error ? e.message : String(e) }));
    const onDisk = this.readDisk();
    const { install: _, ...rest } = this.status;
    if (outcome.kind === "done" && onDisk && !isNewer(latest, onDisk)) {
      this.status = rest;
      this.d.log.info(`Grenade ${onDisk} is installed`);
      return;
    }
    if (outcome.kind === "needsAdmin") {
      this.status = { ...rest, install: { state: "needsAdmin", version: latest, command: NPM_ADMIN_COMMAND } };
      this.d.log.warn(`Grenade ${latest} is out, but npm's global folder needs admin rights. Install it with: ${NPM_ADMIN_COMMAND}`);
      return;
    }
    if (outcome.kind === "pinned") {
      this.status = { ...rest, install: { state: "pinned", version: latest } };
      this.d.log.info(`Grenade ${latest} is out; not installing it, as grenade is pinned (brew unpin grenade)`);
      return;
    }
    const error = outcome.kind === "failed" ? outcome.error : `the install ran, but Grenade on disk is still ${onDisk ?? "unreadable"}`;
    const retry = this.d.auto?.() ?? false;
    const retryAt = retry ? new Date(Date.now() + RETRY_MS).toISOString() : undefined;
    this.status = { ...rest, install: { state: "failed", version: latest, error, ...(retryAt ? { retryAt } : {}) } };
    this.d.log.warn(`Could not install Grenade ${latest}: ${error}`);
    if (retry) {
      this.retryTimer = setTimeout(() => void this.install(false), RETRY_MS);
      this.retryTimer.unref();
    }
  }

  /**
   * The Mac app's Restart: run what is on disk now instead of waiting for the sessions. Refused when this daemon was
   * started by hand (nothing would start it again) and, unless `force`, while a session is busy: a restart loses the
   * hooks of those seconds and closes a card the phone is about to answer.
   */
  restartNow(force: boolean): "restarting" | "busy" | "cannotRestart" {
    if (!this.d.restart) return "cannotRestart";
    if (this.d.busy() && !force) return "busy";
    if (this.restarting) return "restarting";
    this.restarting = true;
    const installed = this.readDisk() ?? this.d.running;
    this.d.log.info(`Restarting into Grenade ${installed}, as asked`, { from: this.d.running, force });
    const restart = this.d.restart;
    setTimeout(() => restart(installed), 100); // after the answer has gone out
    return "restarting";
  }

  /** Once a minute: a newer version on disk is run as soon as no session is busy. */
  watchDisk(): void {
    const installed = this.readDisk();
    if (this.restarting) return;
    const decision = restartDecision(this.d.running, installed, this.d.busy());
    if (decision === "none" || !installed) return;
    if (!this.d.restart) {
      if (this.toldInstalled !== installed) {
        this.toldInstalled = installed;
        this.d.log.warn(`Grenade ${installed} is installed. Restart grenaded to run it (it was started by hand, so it cannot restart itself).`);
      }
      return;
    }
    if (decision === "wait") {
      if (this.toldInstalled !== installed) {
        this.toldInstalled = installed;
        this.d.log.info(`Grenade ${installed} is installed; restarting into it once no session is working`);
      }
      return;
    }
    this.restarting = true;
    this.d.log.info(`Restarting into Grenade ${installed}`, { from: this.d.running });
    this.d.restart(installed);
  }

  private readDisk(): string | null {
    const installed = this.d.installed();
    if (installed) this.status = { ...this.status, installed };
    return installed;
  }
}

/** The tap's formula. Also what `grenade update` reads. */
export async function fetchFormula(): Promise<string> {
  const res = await fetch(TAP_FORMULA_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), headers: { "cache-control": "no-cache" } });
  if (!res.ok) throw new Error(`the tap answered HTTP ${res.status}`);
  return res.text();
}

/** npm's `latest` of the package, for an npm copy. */
export async function fetchNpm(): Promise<string> {
  const res = await fetch(NPM_LATEST_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`npm answered HTTP ${res.status}`);
  return res.text();
}
