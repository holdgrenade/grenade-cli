import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CODE_TTL_MS, DEVICE_IDLE_MS, MAX_ATTEMPTS, PairingCodes, TokenStore, deviceIdFor } from "../src/daemon/pairing.js";

describe("PairingCodes", () => {
  it("accepts the minted code once", () => {
    let now = 1000;
    const codes = new PairingCodes(() => now, () => "123456");
    codes.mint();
    expect(codes.verify("123456")).toBe("ok");
    expect(codes.verify("123456")).toBe("invalid_code");
  });
  it("expires after 2 minutes", () => {
    let now = 1000;
    const codes = new PairingCodes(() => now, () => "123456");
    codes.mint();
    now += CODE_TTL_MS + 1;
    expect(codes.verify("123456")).toBe("invalid_code");
  });
  it("voids the code after 5 wrong attempts", () => {
    const codes = new PairingCodes(() => 0, () => "123456");
    codes.mint();
    for (let i = 0; i < MAX_ATTEMPTS - 1; i++) expect(codes.verify("000000")).toBe("invalid_code");
    expect(codes.verify("000000")).toBe("too_many_attempts");
    expect(codes.verify("123456")).toBe("too_many_attempts");
  });
  it("minting again replaces the old code", () => {
    let value = "111111";
    const codes = new PairingCodes(() => 0, () => value);
    codes.mint();
    value = "222222";
    codes.mint();
    expect(codes.verify("111111")).toBe("invalid_code");
    expect(codes.verify("222222")).toBe("ok");
  });
});

describe("TokenStore", () => {
  const dir = mkdtempSync(join(tmpdir(), "grenade-tokens-"));
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const phone = { name: "phone", platform: "ios" as const, version: "0.1.0" };
  const T0 = Date.parse("2026-09-29T08:00:00.000Z");

  it("gives each phone an id derived from its token, and a last-seen time", () => {
    const store = new TokenStore(undefined, () => T0);
    const token = store.issue(phone);
    const record = store.get(token);
    expect(record?.id).toMatch(/^p_[0-9a-f]{8}$/);
    expect(record?.id).toBe(deviceIdFor(token));
    expect(record).toMatchObject({ issuedAt: "2026-09-29T08:00:00.000Z", lastSeen: "2026-09-29T08:00:00.000Z" });
    expect(record?.sealed).toBeUndefined();
    expect(store.get(store.issue(phone, { sealed: true }))?.sealed).toBe(true);
  });

  it("swaps a whole new file in, readable by this user only, and leaves no half-written copy", () => {
    const path = join(dir, "whole", "tokens.json");
    const store = new TokenStore(path, () => T0);
    store.issue(phone);
    store.issue(phone);
    expect(existsSync(`${path}.tmp`)).toBe(false);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(path, "utf8"))).toHaveLength(2);
  });

  it("reads a file written before phones had ids, and starts their clock now", () => {
    const path = join(dir, "old", "tokens.json");
    new TokenStore(path).issue(phone); // makes the folder
    writeFileSync(path, JSON.stringify([{ token: "grt_old", client: phone, issuedAt: "2025-01-01T00:00:00.000Z" }]));
    const store = new TokenStore(path, () => T0);
    expect(store.get("grt_old")).toMatchObject({ id: deviceIdFor("grt_old"), lastSeen: "2026-09-29T08:00:00.000Z" });
    expect(store.revokeIdle()).toEqual([]);
  });

  it("touch moves last seen, keeps `sealed` once set, and is not a change of the token set", () => {
    let now = T0;
    const store = new TokenStore(undefined, () => now);
    const token = store.issue(phone);
    let changes = 0;
    store.onChange(() => changes++);
    now += 60_000;
    store.touch(token, { sealed: true });
    now += 60_000;
    store.touch(token, { sealed: false });
    expect(store.get(token)).toMatchObject({ lastSeen: "2026-09-29T08:02:00.000Z", sealed: true });
    store.touch("grt_nope");
    expect(changes).toBe(0);
  });

  it("revoke deletes one phone, persists, and tells the listeners", () => {
    const path = join(dir, "revoke", "tokens.json");
    const store = new TokenStore(path);
    const a = store.issue({ ...phone, name: "a" });
    const b = store.issue({ ...phone, name: "b" });
    let changes = 0;
    store.onChange(() => changes++);
    expect(store.revoke("p_nope")).toBeUndefined();
    expect(changes).toBe(0);
    expect(store.revoke(deviceIdFor(a))?.token).toBe(a);
    expect(changes).toBe(1);
    expect(store.has(a)).toBe(false);
    const reloaded = new TokenStore(path);
    expect(reloaded.has(a)).toBe(false);
    expect(reloaded.has(b)).toBe(true);
  });

  it("revokeAll deletes every phone and reports them", () => {
    const store = new TokenStore();
    store.issue(phone);
    store.issue(phone);
    let changes = 0;
    store.onChange(() => changes++);
    expect(store.revokeAll()).toHaveLength(2);
    expect(store.list()).toEqual([]);
    expect(store.revokeAll()).toEqual([]);
    expect(changes).toBe(1);
  });

  it("revokeIdle unpairs only phones unseen for 90 days", () => {
    let now = T0;
    const store = new TokenStore(undefined, () => now);
    const idle = store.issue({ ...phone, name: "idle" });
    const used = store.issue({ ...phone, name: "used" });
    now += DEVICE_IDLE_MS - 1000;
    store.touch(used);
    expect(store.revokeIdle()).toEqual([]);
    now += 2000;
    expect(store.revokeIdle().map((r) => r.token)).toEqual([idle]);
    expect(store.has(used)).toBe(true);
  });

  it("issues grt_ tokens and persists them", () => {
    const path = join(dir, "tokens.json");
    const store = new TokenStore(path);
    const token = store.issue({ name: "phone", platform: "ios", version: "0.1.0" });
    expect(token.startsWith("grt_")).toBe(true);
    expect(store.has(token)).toBe(true);
    expect(store.has("grt_nope")).toBe(false);
    expect(JSON.parse(readFileSync(path, "utf8"))).toHaveLength(1);
    expect(new TokenStore(path).has(token)).toBe(true);
  });
});
