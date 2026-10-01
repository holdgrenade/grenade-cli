/**
 * The daemon's side of updates. Every 6 hours it reads the tap's formula to learn the latest release, and every
 * minute it reads the version on disk. When a newer one has been installed (`grenade update`, `brew upgrade`) and no
 * session is busy, it calls `restart`: under launchd the daemon exits and launchd starts the new version.
 * It never installs anything itself; that is `grenade update`, run by the user.
 */
import type { Logger } from "../log.js";
import { isNewer, latestFromFormula, restartDecision, TAP_FORMULA_URL, type UpdateStatus } from "./versions.js";

export const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
export const DISK_EVERY_MS = 60 * 1000;
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
}

export class UpdateChecker {
  private status: UpdateStatus = {};
  private readonly timers: NodeJS.Timeout[] = [];
  private restarting = false;
  private toldInstalled: string | null = null;
  private toldLatest: string | null = null;

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
    for (const t of this.timers) clearTimeout(t);
    this.timers.length = 0;
  }

  current(): UpdateStatus {
    return { ...this.status };
  }

  /** Reads the tap now. `grenade update` and `grenade status --check` call it through the control API. */
  async checkTap(): Promise<UpdateStatus> {
    this.readDisk();
    const checkedAt = new Date().toISOString();
    try {
      const latest = latestFromFormula(await (this.d.fetchFormula ?? fetchFormula)());
      if (!latest) throw new Error("the tap's formula names no version");
      this.status = { ...this.status, latest, checkedAt };
      delete this.status.error;
      if (latest !== this.toldLatest && isNewer(latest, this.status.installed ?? this.d.running)) {
        this.toldLatest = latest;
        this.d.log.info(`Grenade ${latest} is out (running ${this.d.running}). Update with: grenade update`);
      }
    } catch (e) {
      this.status = { ...this.status, checkedAt, error: e instanceof Error ? e.message : String(e) };
      this.d.log.debug("Could not check for a new version", { error: e });
    }
    return this.current();
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
