/**
 * Pausing after wrong codes (PROTOCOL.md "Pausing after wrong codes"): every fifth wrong pairing try, across codes,
 * secrets and routes, pauses all pairing for longer each time. Strict: nothing ends a pause early.
 * `PairingPause` is pure apart from the file it keeps its count in (inject `now`, leave `path` out in tests).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const TRIES_PER_STRIKE = 5;
/** Strike 1, 2, 3, then 4 and on. */
export const PAUSE_STEPS_MS = [60_000, 10 * 60_000, 60 * 60_000, 24 * 60 * 60_000] as const;
/** The count goes back to zero this long after the last wrong try. */
export const FORGET_AFTER_MS = 24 * 60 * 60_000;

export type PairRoute = "lan" | "relay";

/** What the owner is told about a strike: never the digits tried. */
export interface Strike {
  strike: number;
  /** Epoch ms. */
  at: number;
  pausedUntil: number;
  route: PairRoute;
  tries: number;
}

interface Saved {
  wrong: number;
  strikes: number;
  lastWrongAt: number | null;
  pausedUntil: number | null;
  lastStrike: Strike | null;
}

const EMPTY: Saved = { wrong: 0, strikes: 0, lastWrongAt: null, pausedUntil: null, lastStrike: null };

export function pauseFor(strike: number): number {
  return PAUSE_STEPS_MS[Math.min(Math.max(strike, 1), PAUSE_STEPS_MS.length) - 1]!;
}

export class PairingPause {
  private s: Saved = { ...EMPTY };

  constructor(private readonly path?: string, private readonly now: () => number = Date.now) {
    this.load();
  }

  /** The end of the running pause (epoch ms), or null when pairing is open. */
  pausedUntil(): number | null {
    const until = this.s.pausedUntil;
    return until !== null && this.now() < until ? until : null;
  }

  /** A wrong try made while a code was live. Returns the strike when this try started a pause. */
  wrong(route: PairRoute): Strike | null {
    const now = this.now();
    if (this.s.lastWrongAt !== null && now - this.s.lastWrongAt > FORGET_AFTER_MS) this.s = { ...EMPTY, lastStrike: this.s.lastStrike };
    this.s.wrong++;
    this.s.lastWrongAt = now;
    let strike: Strike | null = null;
    if (this.s.wrong >= TRIES_PER_STRIKE) {
      this.s.strikes++;
      this.s.wrong = 0;
      const pausedUntil = now + pauseFor(this.s.strikes);
      this.s.pausedUntil = pausedUntil;
      strike = { strike: this.s.strikes, at: now, pausedUntil, route, tries: TRIES_PER_STRIKE };
      this.s.lastStrike = strike;
    }
    this.save();
    return strike;
  }

  /** A phone paired: the count starts again. */
  succeeded(): void {
    if (this.s.wrong === 0 && this.s.strikes === 0) return;
    this.s = { ...EMPTY, lastStrike: this.s.lastStrike };
    this.save();
  }

  /** For `GET /status`: the Mac app tells its owner about a new strike. */
  status(): { pausedUntil: number | null; strikes: number; lastStrike: Strike | null } {
    return { pausedUntil: this.pausedUntil(), strikes: this.s.strikes, lastStrike: this.s.lastStrike };
  }

  private load(): void {
    if (!this.path || !existsSync(this.path)) return;
    try {
      this.s = { ...EMPTY, ...(JSON.parse(readFileSync(this.path, "utf8")) as Partial<Saved>) };
    } catch {
      /* corrupt file: start open, the next wrong try rewrites it */
    }
  }

  private save(): void {
    if (!this.path) return;
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(this.s, null, 2) + "\n", { mode: 0o600 });
  }
}

/** "1 minute", "10 minutes", "1 hour", "24 hours". */
export function pauseWords(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return minutes === 1 ? "1 minute" : `${minutes} minutes`;
  const hours = Math.round(minutes / 60);
  return hours === 1 ? "1 hour" : `${hours} hours`;
}
