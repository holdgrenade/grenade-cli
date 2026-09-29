import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { accessHash, accessKey } from "../src/relay/access.js";
import { daemonAccept, phoneStart, SealedChannel, x25519FromRaw } from "../src/relay/e2e.js";
import { localIpv4 } from "../src/relay/localIps.js";
import { applyRelayInfo, normalizeRelayUrl, relayConfigFor, relayWsUrl } from "../src/relay/relayConfig.js";

const v = JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "grenade-protocol", "fixtures", "e2e.vectors.json"), "utf8"));
const b = (s: string) => Buffer.from(s, "base64");

describe("e2e (fixtures/e2e.vectors.json)", () => {
  const daemonStatic = x25519FromRaw(b(v.daemonStaticPrivate));
  const daemonEphemeral = x25519FromRaw(b(v.daemonEphemeralPrivate));
  const phoneEphemeral = x25519FromRaw(b(v.phoneEphemeralPrivate));

  it("derives the public keys", () => {
    expect(daemonStatic.publicKey.toString("base64")).toBe(v.daemonStaticPublic);
    expect(daemonEphemeral.publicKey.toString("base64")).toBe(v.daemonEphemeralPublic);
  });

  it("the daemon side opens the phone's samples and seals its own", () => {
    const { reply, channel } = daemonAccept({ e2e: 1, e: v.phoneEphemeralPublic }, daemonStatic, daemonEphemeral);
    expect(reply).toEqual({ e2e: 1, e: v.daemonEphemeralPublic });
    const fromPhone = v.samples.filter((s: { direction: string }) => s.direction === "phone→daemon");
    for (const s of fromPhone) expect(channel.open(s.sealed)).toBe(s.plaintext);
    const toPhone = v.samples.find((s: { direction: string }) => s.direction === "daemon→phone");
    expect(channel.seal(toPhone.plaintext)).toBe(toPhone.sealed);
  });

  it("the phone side seals the same bytes", () => {
    const phone = phoneStart(daemonStatic.publicKey, phoneEphemeral);
    expect(phone.hello.e).toBe(v.phoneEphemeralPublic);
    const channel = phone.finish({ e2e: 1, e: v.daemonEphemeralPublic });
    expect(channel.seal(v.samples[0].plaintext)).toBe(v.samples[0].sealed);
  });

  it("rejects a replayed, reordered or tampered frame, and stays broken", () => {
    const open = () => daemonAccept({ e2e: 1, e: v.phoneEphemeralPublic }, daemonStatic, daemonEphemeral).channel;
    const replay = open();
    replay.open(v.samples[0].sealed);
    expect(() => replay.open(v.samples[0].sealed)).toThrow();
    expect(() => replay.open(v.samples[1].sealed)).toThrow();
    expect(() => open().open(v.samples[1].sealed)).toThrow();
    const tampered = b(v.samples[0].sealed);
    tampered[3] = (tampered[3] ?? 0) ^ 1;
    expect(() => open().open(tampered.toString("base64"))).toThrow();
  });

  it("fresh keys round-trip both ways", () => {
    const phone = phoneStart(daemonStatic.publicKey);
    const daemon = daemonAccept(phone.hello, daemonStatic);
    const p: SealedChannel = phone.finish(daemon.reply);
    expect(daemon.channel.open(p.seal("hi"))).toBe("hi");
    expect(p.open(daemon.channel.seal("yo"))).toBe("yo");
  });

  it("refuses a malformed phone key", () => {
    expect(() => daemonAccept({ e2e: 1, e: "AAAA" }, daemonStatic)).toThrow();
  });
});

describe("access", () => {
  it("matches the vectors", () => {
    expect(accessKey(v.access.token)).toBe(v.access.access);
    expect(accessHash(v.access.token)).toBe(v.access.accessHash);
  });
});

describe("localIpv4", () => {
  it("keeps external IPv4, skips loopback, link-local, IPv6 and duplicates", () => {
    const base = { netmask: "", mac: "", cidr: null };
    expect(
      localIpv4({
        lo0: [{ ...base, address: "127.0.0.1", family: "IPv4", internal: true }],
        en0: [
          { ...base, address: "fe80::1", family: "IPv6", internal: false, scopeid: 1 },
          { ...base, address: "192.168.1.20", family: "IPv4", internal: false },
        ],
        en5: [{ ...base, address: "169.254.3.4", family: "IPv4", internal: false }],
        utun3: [{ ...base, address: "192.168.1.20", family: "IPv4", internal: false }, { ...base, address: "100.64.0.2", family: "IPv4", internal: false }],
      }),
    ).toEqual(["192.168.1.20", "100.64.0.2"]);
  });
});

describe("relay config", () => {
  let n = 0;
  const random = (bytes: number) => String(++n % 10).repeat(bytes * 2);

  it("normalizes URLs", () => {
    expect(normalizeRelayUrl("relay.example.com")).toBe("https://relay.example.com");
    expect(normalizeRelayUrl("https://relay.example.com/")).toBe("https://relay.example.com");
    expect(normalizeRelayUrl("wss://relay.example.com/grenade/")).toBe("https://relay.example.com/grenade");
    expect(normalizeRelayUrl("http://127.0.0.1:8787")).toBe("http://127.0.0.1:8787");
    expect(() => normalizeRelayUrl("ftp://x")).toThrow();
    expect(relayWsUrl("https://r.example.com", "/v1/daemon")).toBe("wss://r.example.com/v1/daemon");
    expect(relayWsUrl("http://127.0.0.1:8787", "/v1/daemon")).toBe("ws://127.0.0.1:8787/v1/daemon");
  });

  it("keeps identity and key for the same URL, makes a new one for another", () => {
    const a = relayConfigFor("https://a", "k1", null, random);
    expect(a.id).toMatch(/^r_[0-9a-f]{32}$/);
    expect(a.secret).toMatch(/^[0-9a-f]{64}$/);
    expect(relayConfigFor("https://a", undefined, a, random)).toEqual(a);
    const b2 = relayConfigFor("https://b", undefined, a, random);
    expect(b2.id).not.toBe(a.id);
    expect(b2.key).toBeUndefined();
  });

  it("applyRelayInfo sets and clears daemon.relay", () => {
    const info = { id: "d_1", name: "Mac", version: "0.1.0" } as { id: string; name: string; version: string; relay?: unknown };
    applyRelayInfo(info, { url: "https://a", id: "r_" + "0".repeat(32), secret: "0".repeat(64) });
    expect(info.relay).toEqual({ url: "https://a", id: "r_" + "0".repeat(32) });
    applyRelayInfo(info, null);
    expect(info.relay).toBeUndefined();
  });
});
