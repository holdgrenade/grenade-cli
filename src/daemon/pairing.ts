/**
 * Pairing: `grenade pair` mints a 6-digit code and a one-time secret (for the QR code); the phone exchanges either for a token that works until the
 * pairing ends (PROTOCOL.md "Unpairing"). `PairingCodes` is pure (inject `now`); `TokenStore` owns the file.
 */
import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ClientInfo } from "@grenade/protocol";

export const CODE_TTL_MS = 2 * 60 * 1000;
export const MAX_ATTEMPTS = 5;

export type VerifyResult = "ok" | "invalid_code" | "too_many_attempts";

export class PairingCodes {
  private code: { value: string; secret: string; expiresAt: number; attempts: number } | null = null;
  private readonly listeners: Array<() => void> = [];

  constructor(
    private readonly now: () => number = Date.now,
    private readonly random: () => string = randomCode,
    private readonly randomSecretText: () => string = randomSecret,
  ) {}

  /**
   * Mint a new code and, with it, the secret a pairing offer carries (PROTOCOL.md "Pairing offer (QR code)").
   * Any previous pair is voided.
   */
  mint(): { code: string; secret: string; expiresAt: number } {
    const value = this.random();
    const secret = this.randomSecretText();
    const expiresAt = this.now() + CODE_TTL_MS;
    this.code = { value, secret, expiresAt, attempts: 0 };
    this.changed();
    return { code: value, secret, expiresAt };
  }

  /** The candidate is the code or the secret. A correct one is single-use and voids both. Five wrong tries void both. */
  verify(candidate: string): VerifyResult {
    const c = this.code;
    if (!c || this.now() > c.expiresAt) return "invalid_code";
    if (c.attempts >= MAX_ATTEMPTS) return "too_many_attempts";
    if (candidate === c.value || sameText(candidate, c.secret)) {
      this.code = null;
      this.changed();
      return "ok";
    }
    c.attempts++;
    if (c.attempts < MAX_ATTEMPTS) return "invalid_code";
    this.changed();
    return "too_many_attempts";
  }

  /** The secret a phone can still pair with, for the relay's access list. Null once it was used, voided or expired. */
  liveSecret(): string | null {
    const c = this.code;
    return c && this.now() <= c.expiresAt && c.attempts < MAX_ATTEMPTS ? c.secret : null;
  }

  /** Called when `liveSecret` may have changed by a mint or a `verify`. Expiry is the caller's timer. */
  onChange(listener: () => void): void {
    this.listeners.push(listener);
  }

  private changed(): void {
    for (const l of this.listeners) l();
  }
}

function randomCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

/** 16 random bytes as base64url: 22 characters. */
function randomSecret(): string {
  return randomBytes(16).toString("base64url");
}

function sameText(a: string, b: string): boolean {
  const x = Buffer.from(a, "utf8");
  const y = Buffer.from(b, "utf8");
  return x.length === y.length && timingSafeEqual(x, y);
}

/** A phone unseen for this long is unpaired (PROTOCOL.md "Unpairing"). */
export const DEVICE_IDLE_MS = 90 * 24 * 60 * 60 * 1000;

export interface TokenRecord {
  /** What people and the CLI call this phone: `p_` + 8 hex, derived from the token, so old files need no rewrite. */
  id: string;
  token: string;
  client: ClientInfo;
  issuedAt: string;
  /** ISO time of the phone's last `hello` or disconnect. Pairing counts as being seen. */
  lastSeen: string;
  /** The phone paired or has connected encrypted. From then on a plain `hello` with this token is refused. */
  sealed?: boolean;
}

export function deviceIdFor(token: string): string {
  return `p_${createHash("sha256").update(token).digest("hex").slice(0, 8)}`;
}

export class TokenStore {
  private tokens = new Map<string, TokenRecord>();
  private readonly listeners: Array<() => void> = [];

  constructor(private readonly path?: string, private readonly now: () => number = Date.now) {
    this.load();
  }

  issue(client: ClientInfo, opts: { sealed?: boolean } = {}): string {
    const token = `grt_${randomBytes(24).toString("hex")}`;
    const at = new Date(this.now()).toISOString();
    this.tokens.set(token, { id: deviceIdFor(token), token, client, issuedAt: at, lastSeen: at, ...(opts.sealed ? { sealed: true } : {}) });
    this.changed();
    return token;
  }

  /** Called after the set of tokens changed: one was issued or revoked (the relay link re-sends its access hashes). */
  onChange(listener: () => void): void {
    this.listeners.push(listener);
  }

  has(token: string): boolean {
    return this.tokens.has(token);
  }

  get(token: string): TokenRecord | undefined {
    return this.tokens.get(token);
  }

  list(): TokenRecord[] {
    return [...this.tokens.values()];
  }

  /** The phone said `hello` or went away. `sealed` sticks once set. Does not count as a change of the token set. */
  touch(token: string, seen: { sealed?: boolean; client?: ClientInfo } = {}): void {
    const record = this.tokens.get(token);
    if (!record) return;
    record.lastSeen = new Date(this.now()).toISOString();
    if (seen.sealed) record.sealed = true;
    if (seen.client) record.client = seen.client;
    this.save();
  }

  /** Ends one pairing, by device id. Returns the record that went, for closing its connections. */
  revoke(id: string): TokenRecord | undefined {
    const record = this.list().find((r) => r.id === id);
    if (!record) return undefined;
    this.tokens.delete(record.token);
    this.changed();
    return record;
  }

  revokeAll(): TokenRecord[] {
    const gone = this.list();
    if (gone.length === 0) return gone;
    this.tokens.clear();
    this.changed();
    return gone;
  }

  /** Ends the pairing of every phone unseen for `maxIdleMs`. */
  revokeIdle(maxIdleMs: number = DEVICE_IDLE_MS): TokenRecord[] {
    const gone = this.list().filter((r) => this.now() - Date.parse(r.lastSeen) > maxIdleMs);
    if (gone.length === 0) return gone;
    for (const r of gone) this.tokens.delete(r.token);
    this.changed();
    return gone;
  }

  private changed(): void {
    this.save();
    for (const l of this.listeners) l();
  }

  private load(): void {
    if (!this.path || !existsSync(this.path)) return;
    try {
      const list = JSON.parse(readFileSync(this.path, "utf8")) as Array<Omit<TokenRecord, "id" | "lastSeen"> & Partial<TokenRecord>>;
      // Files written before devices had ids and a last-seen time: the clock for "unseen" starts now.
      const seen = new Date(this.now()).toISOString();
      for (const t of list) this.tokens.set(t.token, { ...t, id: t.id ?? deviceIdFor(t.token), lastSeen: t.lastSeen ?? seen });
    } catch {
      /* corrupt file: start empty, next save rewrites it */
    }
  }

  private save(): void {
    if (!this.path) return;
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(this.list(), null, 2) + "\n", { mode: 0o600 });
  }
}
