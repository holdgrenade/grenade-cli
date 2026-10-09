import { describe, expect, it } from "vitest";
import { LiveConnections } from "../src/daemon/connections.js";
import { ago, deviceOf, matchDevice, type Device } from "../src/daemon/devices.js";
import { addressedToLoopback, fromWebPage, isLoopback } from "../src/daemon/loopback.js";

const device = (id: string, name: string): Device => ({
  id, name, platform: "ios", version: "0.1.0", pairedAt: "2026-09-27T12:00:00.000Z", lastSeen: "2026-09-29T08:00:00.000Z", connected: [], sealed: true,
});
const list = [device("p_3fa9c1d2", "Adam's iPhone"), device("p_3fb00000", "Adam's iPad"), device("p_77777777", "Pixel")];

describe("deviceOf", () => {
  it("leaves the token out and lists each route once", () => {
    const d = deviceOf(
      { id: "p_1", token: "grt_secret", client: { name: "iPhone", platform: "ios", version: "0.1.0" }, issuedAt: "a", lastSeen: "b" },
      ["relay", "lan", "lan"],
    );
    expect(d).toEqual({ id: "p_1", name: "iPhone", platform: "ios", version: "0.1.0", pairedAt: "a", lastSeen: "b", connected: ["lan", "relay"], sealed: false });
    expect(JSON.stringify(d)).not.toContain("grt_secret");
  });
});

describe("matchDevice", () => {
  it("finds a phone by id, by name in any case, or by a prefix only one has", () => {
    expect(matchDevice("p_3fa9c1d2", list)).toMatchObject({ found: { name: "Adam's iPhone" } });
    expect(matchDevice("pixel", list)).toMatchObject({ found: { id: "p_77777777" } });
    expect(matchDevice("adam's ipa", list)).toMatchObject({ found: { id: "p_3fb00000" } });
    expect(matchDevice("p_77", list)).toMatchObject({ found: { name: "Pixel" } });
  });

  it("never guesses between two phones", () => {
    expect(matchDevice("adam", list)).toEqual({ found: null, candidates: [list[0], list[1]] });
    expect(matchDevice("p_3f", list)).toEqual({ found: null, candidates: [list[0], list[1]] });
  });

  it("prefers an exact name over phones that merely start with it", () => {
    const both = [device("p_1", "iPhone"), device("p_2", "iPhone 2")];
    expect(matchDevice("iphone", both)).toMatchObject({ found: { id: "p_1" } });
  });

  it("finds nothing for an unknown or empty name", () => {
    expect(matchDevice("nokia", list)).toEqual({ found: null, candidates: [] });
    expect(matchDevice("  ", list)).toEqual({ found: null, candidates: [] });
  });
});

describe("ago", () => {
  const now = Date.parse("2026-09-29T08:00:00.000Z");
  it("reads like a person would say it", () => {
    expect(ago("2026-09-29T07:59:40.000Z", now)).toBe("just now");
    expect(ago("2026-09-29T07:48:00.000Z", now)).toBe("12 min ago");
    expect(ago("2026-09-29T05:00:00.000Z", now)).toBe("3 h ago");
    expect(ago("2026-09-28T07:00:00.000Z", now)).toBe("1 day ago");
    expect(ago("2026-09-20T08:00:00.000Z", now)).toBe("9 days ago");
  });
});

describe("LiveConnections", () => {
  const connection = (route: "lan" | "relay", log: string[]) => ({ route, revoked: (m: string) => log.push(`${route}:${m}`) });

  it("revokes every connection of a token, and only those", () => {
    const log: string[] = [];
    const live = new LiveConnections();
    const lan = connection("lan", log);
    live.add("grt_a", lan);
    live.add("grt_a", connection("relay", log));
    live.add("grt_b", connection("lan", log));
    expect(live.routesOf("grt_a")).toEqual(["lan", "relay"]);
    expect(live.revoke("grt_a", "gone")).toBe(2);
    expect(log).toEqual(["lan:gone", "relay:gone"]);
    expect(live.routesOf("grt_a")).toEqual([]);
    expect(live.routesOf("grt_b")).toEqual(["lan"]);
    live.remove("grt_a", lan);
    expect(live.revoke("grt_a", "gone")).toBe(0);
  });

  it("forgets a connection that ended", () => {
    const live = new LiveConnections();
    const c = connection("lan", []);
    live.add("grt_a", c);
    live.remove("grt_a", c);
    expect(live.routesOf("grt_a")).toEqual([]);
  });
});

describe("isLoopback", () => {
  it("is true for this Mac only", () => {
    for (const a of ["127.0.0.1", "::1", "::ffff:127.0.0.1", "127.0.0.53"]) expect(isLoopback(a), a).toBe(true);
    for (const a of ["192.168.1.20", "::ffff:192.168.1.20", "fe80::1", "10.0.0.1", "", undefined]) expect(isLoopback(a), String(a)).toBe(false);
  });
});

describe("fromWebPage", () => {
  const grenade = "chrome-extension://eiocljcomciaepiidgadhbbadmmnpdne";
  it("lets through no Origin and Grenade's own extension only", () => {
    for (const o of [undefined, grenade, ` ${grenade.toUpperCase()} `]) expect(fromWebPage(o), String(o)).toBe(false);
    for (const o of ["https://evil.example", "http://localhost:4321", "null", "NULL", "file://", "moz-extension://abc", "", "chrome-extension://", "chrome-extension://abcdefghijklmnopabcdefghijklmnop", `${grenade}, https://evil.example`, `${grenade}/x`]) expect(fromWebPage(o), o).toBe(true);
    expect(fromWebPage([grenade, "https://evil.example"])).toBe(true);
  });
});

describe("addressedToLoopback", () => {
  it("is true for this Mac's loopback names only", () => {
    for (const h of ["127.0.0.1:7789", "127.0.0.1", "localhost:7789", "LOCALHOST", "[::1]:7789"]) expect(addressedToLoopback(h), h).toBe(true);
    for (const h of ["evil.example:7789", "127.0.0.1.evil.example:7789", "localhost.evil.example", "192.168.1.20:7789", "", undefined]) expect(addressedToLoopback(h), String(h)).toBe(false);
  });
});
