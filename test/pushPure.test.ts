import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { OFFICIAL_RELAY_URL, PushContent, type Session } from "@grenade/protocol";
import { statusLines, testLine } from "../src/cli/pushCommand.js";
import { isAtMac, parseHidIdle, parseScreenLocked, readMacPresence } from "../src/push/macPresence.js";
import { atMacMs, loadPushConfig, pushConfigOn, pushGatewayFor, pushMode, savePushConfig } from "../src/push/pushConfig.js";
import { clip, pushContentFor, pushText, testPushContent } from "../src/push/pushContent.js";
import { outcomeOf, postPush } from "../src/push/pushGateway.js";
import { AT_MAC_MS, MIN_BUSY_MS, SAME_STRETCH_MS, busyFor, decide, settled, startedWaiting, trackBusy, worthPushing, type PendingPush } from "../src/push/pushPolicy.js";
import { collapseId, sealPushText } from "../src/push/pushSeal.js";
import { x25519FromRaw } from "../src/relay/e2e.js";

const fixtures = join(import.meta.dirname, "..", "..", "grenade-protocol", "fixtures");
const read = (name: string) => JSON.parse(readFileSync(join(fixtures, name), "utf8"));
const b = (s: string) => Buffer.from(s, "base64");

const session: Session = {
  id: "gr-grenade",
  name: "grenade",
  agent: "claude",
  cwd: "/tmp",
  status: "waiting",
  statusSince: "2026-09-29T12:14:22.000Z",
  waitingFor: "answer",
  lastLine: "❯ 1. Yes",
  summary: "Running the test suite.",
  createdAt: "2026-09-29T12:01:00.000Z",
};

describe("sealPush (fixtures/push.vectors.json)", () => {
  const v = read("push.vectors.json");
  it("seals the same bytes as every other implementation", () => {
    const sealed = sealPushText(v.plaintext, x25519FromRaw(b(v.daemonStaticPrivate)), b(v.phonePushPublic), x25519FromRaw(b(v.daemonEphemeralPrivate)));
    expect(sealed).toEqual({ e: v.e, c: v.c });
  });

  it("uses a fresh key for every push", () => {
    const seal = () => sealPushText(v.plaintext, x25519FromRaw(b(v.daemonStaticPrivate)), b(v.phonePushPublic));
    expect(seal().e).not.toBe(seal().e);
  });

  it("refuses a phone key that is not 32 bytes", () => {
    expect(() => sealPushText("{}", x25519FromRaw(b(v.daemonStaticPrivate)), Buffer.alloc(8))).toThrow();
  });

  it("the collapse id is the fixture's and differs per session and per phone", () => {
    expect(collapseId(v.collapse.token, v.collapse.sessionId)).toBe(v.collapse.collapse);
    expect(collapseId(v.collapse.token, "gr-other")).not.toBe(v.collapse.collapse);
    expect(collapseId("grt_another", v.collapse.sessionId)).not.toBe(v.collapse.collapse);
  });
});

describe("push content", () => {
  const daemon = { id: "d_9f8e7d", name: "MacBook Pro" };
  it("a question shows what was asked, a finished turn the summary", () => {
    expect(pushText("answer", session, "Claude needs your permission to use Bash")).toBe("Claude needs your permission to use Bash");
    expect(pushText("done", session, "Claude needs your permission to use Bash")).toBe("Running the test suite.");
  });

  it("falls back to the last line", () => {
    expect(pushText("answer", session)).toBe("❯ 1. Yes");
    expect(pushText("done", { lastLine: "Done. 3 files changed." })).toBe("Done. 3 files changed.");
  });

  it("clips to 200 characters on one line", () => {
    const long = clip(`first\nsecond ${"é".repeat(300)}`);
    expect([...long]).toHaveLength(200);
    expect(long.startsWith("first second é")).toBe(true);
    expect(long.endsWith("…")).toBe(true);
  });

  it("builds content the protocol accepts", () => {
    const content = pushContentFor({ id: "n_1", at: Date.parse("2026-09-29T12:14:25.000Z"), event: "answer", daemon, session, asked: "Allow Bash?" });
    expect(PushContent.parse(content)).toEqual({
      v: 1,
      id: "n_1",
      at: "2026-09-29T12:14:25.000Z",
      event: "answer",
      daemonId: "d_9f8e7d",
      daemonName: "MacBook Pro",
      sessionId: "gr-grenade",
      sessionName: "grenade",
      agent: "claude",
      text: "Allow Bash?",
    });
    expect(PushContent.safeParse(testPushContent("n_2", 0, daemon)).success).toBe(true);
  });
});

describe("push policy", () => {
  const pending: PendingPush = { sessionId: session.id, event: "answer", statusSince: session.statusSince, dueAt: 3000 };

  it("a session that starts waiting, or waits for something else, is an event", () => {
    expect(startedWaiting(undefined, session)).toBe(true);
    expect(startedWaiting({ ...session, status: "working" }, session)).toBe(true);
    expect(startedWaiting(session, { ...session, lastLine: "changed" })).toBe(false);
    expect(startedWaiting({ ...session, waitingFor: "done" }, session)).toBe(true);
    expect(startedWaiting(session, { ...session, status: "idle" })).toBe(false);
  });

  it("waits out the grace, then sends", () => {
    expect(decide(pending, session, false, 2999)).toBe("wait");
    expect(decide(pending, session, false, 3000)).toBe("send");
  });

  it("drops when the session was seen, answered, or ended", () => {
    expect(decide(pending, { ...session, status: "idle" }, false, 5000)).toBe("drop");
    expect(decide(pending, { ...session, status: "working" }, false, 5000)).toBe("drop");
    expect(decide(pending, undefined, false, 5000)).toBe("drop");
    expect(decide(pending, { ...session, statusSince: "2026-09-29T12:20:00.000Z" }, false, 5000)).toBe("drop");
  });

  it("holds while someone is at the Mac, and sends when they left", () => {
    expect(decide(pending, session, true, 5000)).toBe("hold");
    expect(decide(pending, session, false, 200_000)).toBe("send");
  });

  it("a quick command in a shell is not worth a push, a long one is", () => {
    expect(worthPushing("done", false, 2000)).toBe(false);
    expect(worthPushing("done", false, MIN_BUSY_MS)).toBe(true);
    expect(worthPushing("done", true, 2000)).toBe(true);
    expect(worthPushing("answer", false, 0)).toBe(true);
  });

  it("short pauses belong to the same stretch of work", () => {
    let s = trackBusy(settled, "working", 0);
    s = trackBusy(s, "waiting", 40_000);
    expect(busyFor(s, 40_000)).toBe(40_000);
    s = trackBusy(s, "working", 40_000 + SAME_STRETCH_MS - 1);
    s = trackBusy(s, "waiting", 55_000);
    expect(busyFor(s, 55_000)).toBe(55_000);
  });

  it("work after a long pause is a new stretch", () => {
    let s = trackBusy(settled, "working", 0);
    s = trackBusy(s, "waiting", 40_000);
    s = trackBusy(s, "idle", 50_000);
    s = trackBusy(s, "working", 100_000);
    s = trackBusy(s, "waiting", 102_000);
    expect(busyFor(s, 102_000)).toBe(2000);
  });
});

describe("Mac presence", () => {
  const hid = '    | |   "HIDIdleTime" = 206985692250\n';
  const unlocked = '"IOConsoleUsers" = ({"kCGSSessionOnConsoleKey"=Yes,"kCGSSessionUserNameKey"="adam"})';
  const locked = '"IOConsoleUsers" = ({"kCGSSessionOnConsoleKey"=Yes,"CGSSessionScreenIsLocked"=Yes,"kCGSSessionUserNameKey"="adam"})';

  it("reads the idle time in milliseconds", () => {
    expect(parseHidIdle(hid)).toBe(206_985);
    expect(parseHidIdle("nothing here")).toBeNull();
  });

  it("reads the lock", () => {
    expect(parseScreenLocked(unlocked)).toBe(false);
    expect(parseScreenLocked(locked)).toBe(true);
  });

  it("someone is at the Mac when it was used lately and is not locked", () => {
    expect(isAtMac({ idleMs: 5000, locked: false }, AT_MAC_MS)).toBe(true);
    expect(isAtMac({ idleMs: AT_MAC_MS, locked: false }, AT_MAC_MS)).toBe(false);
    expect(isAtMac({ idleMs: 0, locked: true }, AT_MAC_MS)).toBe(false);
    expect(isAtMac(null, AT_MAC_MS)).toBe(false);
    expect(isAtMac({ idleMs: 0, locked: false }, 0)).toBe(false);
  });

  it("runs ioreg on macOS only, and a failure reads as unknown", async () => {
    const run = async (_file: string, args: string[]) => (args.includes("IOHIDSystem") ? hid : locked);
    expect(await readMacPresence(run, "darwin")).toEqual({ idleMs: 206_985, locked: true });
    expect(await readMacPresence(run, "linux")).toBeNull();
    expect(await readMacPresence(async () => Promise.reject(new Error("no ioreg")), "darwin")).toBeNull();
  });
});

describe("push config", () => {
  const relay = { url: "https://relay.example.com", key: "k", id: "r_0123456789abcdef0123456789abcdef", secret: "s" };

  it("a Mac that talks to no relay sends no pushes until it is told to", () => {
    expect(pushGatewayFor({}, null)).toBeNull();
    expect(pushMode({})).toBe("auto");
    expect(pushGatewayFor({ url: "https://push.example.com" }, null)).toBeNull();
  });

  it("follows remote access when nobody chose", () => {
    expect(pushGatewayFor({}, relay)).toEqual({ url: "https://relay.example.com", key: "k" });
    expect(pushGatewayFor({ atMacSeconds: 30 }, relay)).toEqual({ url: "https://relay.example.com", key: "k" });
  });

  it("after `push on`: where it was told, else the Mac's relay, else the main relay", () => {
    expect(pushGatewayFor({ enabled: true }, null)).toEqual({ url: OFFICIAL_RELAY_URL });
    expect(pushGatewayFor({ enabled: true }, relay)).toEqual({ url: "https://relay.example.com", key: "k" });
    expect(pushGatewayFor({ enabled: true, url: "https://push.example.com" }, relay)).toEqual({ url: "https://push.example.com" });
    expect(pushMode({ enabled: true })).toBe("on");
  });

  it("after `push off`: nowhere, relay or not", () => {
    expect(pushGatewayFor({ enabled: false, url: "https://push.example.com" }, relay)).toBeNull();
    expect(pushGatewayFor({ enabled: false }, relay)).toBeNull();
    expect(pushMode({ enabled: false })).toBe("off");
  });

  it("no file, or a file that does not say, means auto", () => {
    const dir = mkdtempSync(join(tmpdir(), "grenade-pushconfig-"));
    expect(loadPushConfig(join(dir, "push.json"))).toEqual({});
    savePushConfig(join(dir, "push.json"), { atMacSeconds: 45 });
    expect(loadPushConfig(join(dir, "push.json"))).toEqual({ atMacSeconds: 45 });
    savePushConfig(join(dir, "push.json"), { enabled: false });
    expect(loadPushConfig(join(dir, "push.json"))).toEqual({ enabled: false });
  });

  it("`push on` keeps the hold time and the key of the same route", () => {
    const first = pushConfigOn({ enabled: false, atMacSeconds: 30 }, "push.example.com/", "secret");
    expect(first).toEqual({ enabled: true, url: "https://push.example.com", key: "secret", atMacSeconds: 30 });
    expect(pushConfigOn(first, "https://push.example.com", undefined).key).toBe("secret");
    expect(pushConfigOn(first, "https://other.example.com", undefined).key).toBeUndefined();
    expect(pushConfigOn(first, undefined, undefined)).toEqual({ enabled: true, atMacSeconds: 30 });
  });

  it("holds for two minutes unless told otherwise", () => {
    expect(atMacMs({ enabled: true })).toBe(AT_MAC_MS);
    expect(atMacMs({ enabled: true, atMacSeconds: 0 })).toBe(0);
    expect(atMacMs({ enabled: true, atMacSeconds: 45 })).toBe(45_000);
  });
});

describe("push gateway", () => {
  const request = read("http.relay.push.request.json");
  const answer = (status: number, body: unknown) => async () => new Response(JSON.stringify(body), { status });

  it("maps the route's answers", () => {
    expect(outcomeOf(200)).toBe("sent");
    expect(outcomeOf(410)).toBe("unregistered");
    expect(outcomeOf(502)).toBe("retry");
    expect(outcomeOf(503)).toBe("retry");
    expect(outcomeOf(429)).toBe("refused");
    expect(outcomeOf(403)).toBe("refused");
  });

  it("posts the request to /v1/push with the registration key", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const result = await postPush({ url: "https://relay.example.com", key: "k" }, request, async (url, init) => {
      calls.push({ url, init });
      return new Response('{"ok":true}', { status: 200 });
    });
    expect(result).toEqual({ outcome: "sent", status: 200 });
    expect(calls[0]?.url).toBe("https://relay.example.com/v1/push");
    expect(calls[0]?.init.method).toBe("POST");
    expect((calls[0]?.init.headers as Record<string, string>)["authorization"]).toBe("Bearer k");
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual(request);
  });

  it("reports why a push was not taken", async () => {
    expect(await postPush({ url: "https://r" }, request, answer(410, { error: "unregistered" }))).toEqual({ outcome: "unregistered", status: 410, error: "unregistered" });
    expect(await postPush({ url: "https://r" }, request, answer(503, { error: "push_unavailable" }))).toEqual({ outcome: "retry", status: 503, error: "push_unavailable" });
    expect(await postPush({ url: "https://r" }, request, answer(500, "oops"))).toEqual({ outcome: "refused", status: 500, error: "http_500" });
  });

  it("a relay that cannot be reached is worth another try", async () => {
    const r = await postPush({ url: "https://r" }, request, async () => Promise.reject(new Error("getaddrinfo ENOTFOUND r")));
    expect(r).toEqual({ outcome: "retry", error: "getaddrinfo ENOTFOUND r" });
  });
});

describe("grenade push status", () => {
  it("says off, or where pushes go and to whom", () => {
    expect(statusLines({ enabled: false, mode: "off", atMacSeconds: 120, pending: 0, devices: [] })[0]).toContain("push     off. Turn it on with: grenade push on");
    const lines = statusLines({
      enabled: true,
      mode: "on",
      gateway: "https://relay.example.com",
      atMacSeconds: 120,
      pending: 1,
      devices: [{ id: "p_1a2b3c4d", environment: "sandbox", events: ["answer", "done"], registeredAt: "2026-09-29T12:00:00.000Z" }],
    });
    expect(lines[0]).toBe("push     on, through https://relay.example.com");
    expect(lines).toContain("phone    p_1a2b3c4d  answer + done  (development build)");
    expect(lines).toContain("pending  1");
  });

  it("says why push is off on a Mac without remote access, and both ways to turn it on", () => {
    const lines = statusLines({ enabled: false, mode: "auto", atMacSeconds: 120, pending: 0, devices: [] }).join("\n");
    expect(lines).toContain("remote access is off");
    expect(lines).toContain("grenade relay on");
    expect(lines).toContain("grenade push on");
  });

  it("says when push only lasts as long as remote access", () => {
    const auto = statusLines({ enabled: true, mode: "auto", gateway: "https://relay.example.com", atMacSeconds: 120, pending: 0, devices: [] });
    expect(auto[0]).toBe("push     on, through https://relay.example.com (as long as remote access is on)");
  });

  it("explains a test that did not arrive", () => {
    expect(testLine({ device: "p_1", outcome: "sent" })).toBe("sent");
    expect(testLine({ device: "p_1", outcome: "refused", error: "push_unavailable" })).toContain("no push key");
    expect(testLine({ device: "p_1", outcome: "retry", error: "timeout" })).toContain("timeout");
  });
});
