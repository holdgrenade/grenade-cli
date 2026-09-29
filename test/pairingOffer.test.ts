import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parsePairingOffer, type DaemonInfo } from "@grenade/protocol";
import { CODE_TTL_MS, MAX_ATTEMPTS, PairingCodes } from "../src/daemon/pairing.js";
import { offerFor, offerUrlFor } from "../src/pairing/offer.js";
import { PairingWatch } from "../src/pairing/pairingWatch.js";
import { accessHash, accessKey } from "../src/relay/access.js";

const fixture = JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "grenade-protocol", "fixtures", "pair.offer.json"), "utf8")) as {
  offer: { id: string; name: string; key: string; secret: string; hosts: string[]; port: number; relay: { url: string; id: string } };
  url: string;
  access: string;
  accessHash: string;
};
const SECRET = fixture.offer.secret;
const codes = (now: () => number = () => 0) => new PairingCodes(now, () => "123456", () => SECRET);

describe("the secret minted with a pairing code", () => {
  it("is 16 random bytes as base64url, new each time", () => {
    const c = new PairingCodes();
    const a = c.mint().secret;
    const b = c.mint().secret;
    expect(a).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(b).not.toBe(a);
  });

  it("pairs once, and takes the code with it", () => {
    const c = codes();
    c.mint();
    expect(c.verify(SECRET)).toBe("ok");
    expect(c.verify(SECRET)).toBe("invalid_code");
    expect(c.verify("123456")).toBe("invalid_code");
  });

  it("is gone once the code was used", () => {
    const c = codes();
    c.mint();
    expect(c.verify("123456")).toBe("ok");
    expect(c.verify(SECRET)).toBe("invalid_code");
    expect(c.liveSecret()).toBeNull();
  });

  it("shares the five tries with the code", () => {
    const c = codes();
    c.mint();
    for (let i = 0; i < MAX_ATTEMPTS - 1; i++) expect(c.verify(i % 2 ? "000000" : "x".repeat(22))).toBe("invalid_code");
    expect(c.verify("000000")).toBe("too_many_attempts");
    expect(c.verify(SECRET)).toBe("too_many_attempts");
    expect(c.liveSecret()).toBeNull();
  });

  it("is live until it runs out", () => {
    let now = 1000;
    const c = codes(() => now);
    expect(c.liveSecret()).toBeNull();
    c.mint();
    expect(c.liveSecret()).toBe(SECRET);
    now += CODE_TTL_MS + 1;
    expect(c.liveSecret()).toBeNull();
    expect(c.verify(SECRET)).toBe("invalid_code");
  });

  it("tells listeners when it is minted, used and voided, not on a plain wrong try", () => {
    const c = codes();
    let changes = 0;
    c.onChange(() => changes++);
    c.mint();
    expect(changes).toBe(1);
    c.verify("000000");
    expect(changes).toBe(1);
    c.verify(SECRET);
    expect(changes).toBe(2);
    c.mint();
    for (let i = 0; i < MAX_ATTEMPTS; i++) c.verify("000000");
    expect(changes).toBe(4);
  });

  it("opens the relay with the access key of the protocol fixture", () => {
    expect(accessKey(SECRET)).toBe(fixture.access);
    expect(accessHash(SECRET)).toBe(fixture.accessHash);
  });
});

describe("offerFor", () => {
  const daemon: DaemonInfo = { id: fixture.offer.id, name: fixture.offer.name, version: "0.1.0", key: fixture.offer.key, e2e: 1, relay: fixture.offer.relay };

  it("builds the offer and the URL of the protocol fixture", () => {
    expect(offerFor(daemon, SECRET, fixture.offer.hosts, fixture.offer.port)).toEqual(fixture.offer);
    expect(offerUrlFor(daemon, SECRET, fixture.offer.hosts, fixture.offer.port)).toBe(fixture.url);
  });

  it("has no relay while the daemon has none, and at most 4 hosts", () => {
    const { relay: _relay, ...local } = daemon;
    const url = offerUrlFor(local, SECRET, ["10.0.0.1", "10.0.0.2", "10.0.0.3", "10.0.0.4", "10.0.0.5"], 7788);
    const parsed = parsePairingOffer(url);
    expect(parsed.ok && parsed.offer.relay).toBeUndefined();
    expect(parsed.ok && parsed.offer.hosts).toEqual(["10.0.0.1", "10.0.0.2", "10.0.0.3", "10.0.0.4"]);
  });

  it("refuses a daemon without a key", () => {
    expect(() => offerFor({ id: "d_1", name: "Mac", version: "0.1.0" }, SECRET, [], 7788)).toThrow(/key/);
  });
});

describe("PairingWatch", () => {
  const phone = { name: "Adam's iPhone", platform: "ios" as const, version: "0.1.0" };

  it("goes from none to waiting to paired", () => {
    const w = new PairingWatch(() => 0);
    expect(w.state()).toEqual({ state: "none" });
    w.minted(1000);
    expect(w.state()).toEqual({ state: "waiting", expiresAt: 1000 });
    w.paired(phone, "relay");
    expect(w.state()).toEqual({ state: "paired", phone: "Adam's iPhone", platform: "ios", route: "relay" });
  });

  it("expires by the clock and when the tries ran out", () => {
    let now = 0;
    const w = new PairingWatch(() => now);
    w.minted(1000);
    now = 1001;
    expect(w.state()).toEqual({ state: "expired" });
    w.minted(5000);
    w.voided();
    expect(w.state()).toEqual({ state: "expired" });
  });

  it("a new code forgets the last phone", () => {
    const w = new PairingWatch(() => 0);
    w.minted(1000);
    w.paired(phone, "lan");
    w.voided();
    expect(w.state().state).toBe("paired");
    w.minted(2000);
    expect(w.state().state).toBe("waiting");
  });
});
