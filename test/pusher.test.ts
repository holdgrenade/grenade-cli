import { EventEmitter } from "node:events";
import { createDecipheriv, createPublicKey, diffieHellman, hkdfSync } from "node:crypto";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PUSH_INFO, PushContent, PushRequest, type PushRegisterFrame, type Session } from "@grenade/protocol";
import { deviceIdFor } from "../src/daemon/pairing.js";
import type { LogData, Logger } from "../src/log.js";
import type { MacPresence } from "../src/push/macPresence.js";
import type { PushGateway } from "../src/push/pushConfig.js";
import { PushDevices } from "../src/push/pushDevices.js";
import type { PushResult } from "../src/push/pushGateway.js";
import { Pusher } from "../src/push/pusher.js";
import { collapseId } from "../src/push/pushSeal.js";
import { generateX25519, type X25519Pair } from "../src/relay/e2e.js";

const TOKEN = "grt_example_token";
const DEVICE = deviceIdFor(TOKEN);
const DEVICE_TOKEN = "9f3c".repeat(16);

const base: Session = {
  id: "gr-grenade",
  name: "grenade",
  agent: "claude",
  cwd: "/tmp",
  status: "working",
  statusSince: "2026-09-29T12:00:00.000Z",
  lastLine: "⎿ Bash(npm test)",
  summary: "Running the test suite.",
  createdAt: "2026-09-29T11:00:00.000Z",
};

class FakeRegistry extends EventEmitter {
  sessions = new Map<string, Session>();
  hooked = new Set<string>();
  get(id: string) { return this.sessions.get(id); }
  hookDriven(id: string) { return this.hooked.has(id); }
  set(s: Session) {
    this.sessions.set(s.id, s);
    this.emit("updated", s);
  }
}

function collectingLogger(): Logger & { lines: string[] } {
  const lines: string[] = [];
  const write = (m: string, d?: LogData) => void lines.push(`${m} ${JSON.stringify(d ?? {})}`);
  return { lines, debug: write, info: write, warn: write, error: write, close() {} };
}

function setup(opts: { gateway?: PushGateway | null; presence?: MacPresence | null; answers?: PushResult[]; paired?: boolean; hooked?: boolean; devicesPath?: string } = {}) {
  const registry = new FakeRegistry();
  if (opts.hooked !== false) registry.hooked.add(base.id);
  const phone = generateX25519();
  const staticKey = generateX25519();
  const posts: Array<{ gateway: PushGateway; request: PushRequest }> = [];
  const answers = [...(opts.answers ?? [])];
  const log = collectingLogger();
  const clock = { now: Date.parse("2026-09-29T12:10:00.000Z") };
  const paired = { value: opts.paired !== false };
  let presence: MacPresence | null = opts.presence === undefined ? null : opts.presence;
  const pusher = new Pusher({
    registry,
    devices: new PushDevices(opts.devicesPath),
    paired: () => (paired.value ? [{ id: DEVICE, token: TOKEN }] : []),
    daemon: { id: "d_9f8e7d", name: "MacBook Pro" },
    staticKey,
    gateway: () => (opts.gateway === undefined ? { url: "https://relay.example.com" } : opts.gateway),
    atMacMs: () => 120_000,
    log,
    presence: async () => presence,
    post: async (gateway, request) => {
      posts.push({ gateway, request });
      return answers.shift() ?? { outcome: "sent", status: 200 };
    },
    now: () => clock.now,
    sleep: async () => {},
    newId: () => "n_test",
    tickMs: 0,
    presenceMaxAgeMs: 0,
  });
  pusher.start();
  const frame: PushRegisterFrame = {
    type: "push.register",
    provider: "apns",
    deviceToken: DEVICE_TOKEN,
    environment: "production",
    topic: "com.adamchew.grenade",
    key: phone.publicKey.toString("base64"),
    events: ["answer", "done"],
  };
  const waiting = (waitingFor: "answer" | "done", since = clock.now): Session => ({ ...base, status: "waiting", waitingFor, statusSince: new Date(since).toISOString() });
  return {
    registry, pusher, posts, log, clock, paired, phone, staticKey, frame, waiting,
    setPresence: (p: MacPresence | null) => { presence = p; },
    async after(ms: number) {
      clock.now += ms;
      await pusher.tick();
    },
  };
}

/** What the phone does with a push: PROTOCOL.md "Push encryption". */
function open(request: PushRequest, phone: X25519Pair, daemonStaticPublic: Buffer): PushContent {
  const pub = (raw: Buffer) => createPublicKey({ key: { kty: "OKP", crv: "X25519", x: raw.toString("base64url") }, format: "jwk" });
  const e = Buffer.from(request.e, "base64");
  const ikm = Buffer.concat([diffieHellman({ privateKey: phone.privateKey, publicKey: pub(e) }), diffieHellman({ privateKey: phone.privateKey, publicKey: pub(daemonStaticPublic) })]);
  const key = Buffer.from(hkdfSync("sha256", ikm, Buffer.concat([e, daemonStaticPublic, phone.publicKey]), PUSH_INFO, 32));
  const sealed = Buffer.from(request.c, "base64");
  const d = createDecipheriv("chacha20-poly1305", key, Buffer.alloc(12), { authTagLength: 16 });
  d.setAuthTag(sealed.subarray(sealed.length - 16));
  return PushContent.parse(JSON.parse(Buffer.concat([d.update(sealed.subarray(0, sealed.length - 16)), d.final()]).toString("utf8")));
}

describe("Pusher: registering", () => {
  it("answers push.register with the state, and keeps one registration per phone", () => {
    const t = setup();
    expect(t.pusher.register(TOKEN, t.frame)).toEqual({ type: "push.state", registered: true, delivery: "gateway", events: ["answer", "done"] });
    expect(t.pusher.register(TOKEN, { ...t.frame, events: ["answer"] })).toEqual({ type: "push.state", registered: true, delivery: "gateway", events: ["answer"] });
    expect(t.pusher.status().devices).toHaveLength(1);
  });

  it("says `off` when push is turned off on the Mac", () => {
    const t = setup({ gateway: null });
    expect(t.pusher.register(TOKEN, t.frame).delivery).toBe("off");
    expect(t.pusher.status().enabled).toBe(false);
  });

  it("push.unregister removes it", () => {
    const t = setup();
    t.pusher.register(TOKEN, t.frame);
    expect(t.pusher.unregister(TOKEN)).toEqual({ type: "push.state", registered: false, delivery: "gateway", events: [] });
    expect(t.pusher.status().devices).toEqual([]);
  });

  it("a token that is not paired registers nothing", () => {
    const t = setup({ paired: false });
    expect(t.pusher.register(TOKEN, t.frame).registered).toBe(false);
  });

  it("a registration goes when its pairing ends", () => {
    const t = setup();
    t.pusher.register(TOKEN, t.frame);
    t.paired.value = false;
    t.pusher.pairingsChanged();
    expect(t.pusher.status().devices).toEqual([]);
  });

  it("keeps registrations in a file only the user can read", () => {
    const path = join(mkdtempSync(join(tmpdir(), "grenade-push-")), "push-devices.json");
    const t = setup({ devicesPath: path });
    t.pusher.register(TOKEN, t.frame);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(path, "utf8"))[0].id).toBe(DEVICE);
    expect(new PushDevices(path).get(DEVICE)?.deviceToken).toBe(DEVICE_TOKEN);
  });
});

describe("Pusher: telling connected phones", () => {
  it("a registered phone hears when the Mac stops and starts sending pushes", () => {
    const gateway: { value: PushGateway | null } = { value: { url: "https://relay.example.com" } };
    const registry = new FakeRegistry();
    const pusher = new Pusher({
      registry,
      devices: new PushDevices(),
      paired: () => [{ id: DEVICE, token: TOKEN }, { id: "p_other", token: "grt_other" }],
      daemon: { id: "d_9f8e7d", name: "MacBook Pro" },
      staticKey: generateX25519(),
      gateway: () => gateway.value,
      atMacMs: () => 0,
      log: collectingLogger(),
      tickMs: 0,
    });
    pusher.start();
    const heard: string[] = [];
    const unregistered: string[] = [];
    const stop = pusher.watch(TOKEN, (s) => heard.push(s.delivery));
    pusher.watch("grt_other", (s) => unregistered.push(s.delivery));
    pusher.register(TOKEN, { type: "push.register", provider: "apns", deviceToken: DEVICE_TOKEN, environment: "production", topic: "com.adamchew.grenade", key: generateX25519().publicKey.toString("base64"), events: ["answer"] });

    pusher.deliveryMayHaveChanged();
    expect(heard).toEqual([]);
    gateway.value = null;
    pusher.deliveryMayHaveChanged();
    expect(heard).toEqual(["off"]);
    gateway.value = { url: "https://relay.example.com" };
    pusher.deliveryMayHaveChanged();
    pusher.deliveryMayHaveChanged();
    expect(heard).toEqual(["off", "gateway"]);
    // A phone that never registered is told nothing.
    expect(unregistered).toEqual([]);

    stop();
    gateway.value = null;
    pusher.deliveryMayHaveChanged();
    expect(heard).toEqual(["off", "gateway"]);
  });
});

describe("Pusher: sending", () => {
  it("pushes a question after the grace, sealed for the phone", async () => {
    const t = setup();
    t.pusher.register(TOKEN, t.frame);
    t.registry.set(base);
    t.registry.set(t.waiting("answer"));
    t.pusher.noteAsked(base.id, "Claude needs your permission to use Bash");
    await t.after(2000);
    expect(t.posts).toHaveLength(0);
    await t.after(1000);
    expect(t.posts).toHaveLength(1);

    const { gateway, request } = t.posts[0]!;
    expect(gateway.url).toBe("https://relay.example.com");
    expect(PushRequest.safeParse(request).success).toBe(true);
    expect(request.deviceToken).toBe(DEVICE_TOKEN);
    expect(request.collapse).toBe(collapseId(TOKEN, base.id));
    // Nothing the relay can read says which session or what was asked.
    const readable = JSON.stringify(request);
    for (const secret of ["gr-grenade", "MacBook", "permission", "d_9f8e7d", TOKEN]) expect(readable).not.toContain(secret);

    const content = open(request, t.phone, t.staticKey.publicKey);
    expect(content).toMatchObject({ event: "answer", daemonId: "d_9f8e7d", daemonName: "MacBook Pro", sessionId: "gr-grenade", sessionName: "grenade", text: "Claude needs your permission to use Bash" });
  });

  it("a finished turn carries the summary", async () => {
    const t = setup();
    t.pusher.register(TOKEN, t.frame);
    t.registry.set(base);
    t.registry.set(t.waiting("done"));
    await t.after(3000);
    expect(open(t.posts[0]!.request, t.phone, t.staticKey.publicKey)).toMatchObject({ event: "done", text: "Running the test suite." });
  });

  it("sends nothing when a phone that shows the session said seen", async () => {
    const t = setup();
    t.pusher.register(TOKEN, t.frame);
    t.registry.set(t.waiting("done"));
    t.registry.set({ ...t.waiting("done"), status: "idle" });
    await t.after(5000);
    expect(t.posts).toEqual([]);
    expect(t.pusher.status().pending).toBe(0);
  });

  it("sends only the events the phone asked for", async () => {
    const t = setup();
    t.pusher.register(TOKEN, { ...t.frame, events: ["answer"] });
    t.registry.set(t.waiting("done"));
    await t.after(3000);
    expect(t.posts).toEqual([]);
    t.registry.set({ ...base, statusSince: new Date(t.clock.now).toISOString() });
    t.registry.set(t.waiting("answer"));
    await t.after(3000);
    expect(t.posts).toHaveLength(1);
  });

  it("holds the push while someone is at the Mac and sends when they leave", async () => {
    const t = setup({ presence: { idleMs: 4000, locked: false } });
    t.pusher.register(TOKEN, t.frame);
    t.registry.set(t.waiting("answer"));
    await t.after(3000);
    await t.after(30_000);
    expect(t.posts).toEqual([]);
    expect(t.pusher.status().pending).toBe(1);
    t.setPresence({ idleMs: 125_000, locked: false });
    await t.after(1000);
    expect(t.posts).toHaveLength(1);
  });

  it("a locked screen sends at once", async () => {
    const t = setup({ presence: { idleMs: 1000, locked: true } });
    t.pusher.register(TOKEN, t.frame);
    t.registry.set(t.waiting("answer"));
    await t.after(3000);
    expect(t.posts).toHaveLength(1);
  });

  it("a held push is dropped when the user answers at the Mac", async () => {
    const t = setup({ presence: { idleMs: 0, locked: false } });
    t.pusher.register(TOKEN, t.frame);
    t.registry.set(t.waiting("answer"));
    await t.after(3000);
    t.registry.set({ ...base, statusSince: new Date(t.clock.now).toISOString() });
    t.setPresence({ idleMs: 500_000, locked: false });
    await t.after(1000);
    expect(t.posts).toEqual([]);
  });

  it("a quick command in a shell does not push, a long one does", async () => {
    const t = setup({ hooked: false });
    t.pusher.register(TOKEN, t.frame);
    const shell = { ...base, agent: "shell" as const };
    t.registry.set(shell);
    t.clock.now += 2000;
    t.registry.set({ ...shell, status: "waiting", waitingFor: "done", statusSince: new Date(t.clock.now).toISOString() });
    await t.after(3000);
    expect(t.posts).toEqual([]);

    t.clock.now += 60_000;
    t.registry.set({ ...shell, statusSince: new Date(t.clock.now).toISOString() });
    t.clock.now += 45_000;
    t.registry.set({ ...shell, status: "waiting", waitingFor: "done", statusSince: new Date(t.clock.now).toISOString() });
    await t.after(3000);
    expect(t.posts).toHaveLength(1);
  });

  it("forgets a phone whose app was removed", async () => {
    const t = setup({ answers: [{ outcome: "unregistered", status: 410, error: "unregistered" }] });
    t.pusher.register(TOKEN, t.frame);
    t.registry.set(t.waiting("answer"));
    await t.after(3000);
    expect(t.pusher.status().devices).toEqual([]);
    expect(t.pusher.status().last).toMatchObject({ device: DEVICE, outcome: "unregistered" });
  });

  it("tries once more when the relay could not be reached", async () => {
    const t = setup({ answers: [{ outcome: "retry", error: "fetch failed" }] });
    t.pusher.register(TOKEN, t.frame);
    t.registry.set(t.waiting("answer"));
    await t.after(3000);
    expect(t.posts).toHaveLength(2);
    expect(t.pusher.status().last?.outcome).toBe("sent");
  });

  it("sends nothing while push is off", async () => {
    const t = setup({ gateway: null });
    t.pusher.register(TOKEN, t.frame);
    t.registry.set(t.waiting("answer"));
    await t.after(3000);
    expect(t.posts).toEqual([]);
  });

  it("never logs a device token or a push key", async () => {
    const t = setup({ answers: [{ outcome: "refused", status: 403, error: "topic_not_served" }] });
    t.pusher.register(TOKEN, t.frame);
    t.registry.set(t.waiting("answer"));
    await t.after(3000);
    await t.pusher.test();
    const all = t.log.lines.join("\n");
    expect(all).toContain(DEVICE);
    expect(all).not.toContain(DEVICE_TOKEN);
    expect(all).not.toContain(t.frame.key);
    expect(all).not.toContain(TOKEN);
  });

  it("`grenade push test` reaches every registered phone", async () => {
    const t = setup();
    t.pusher.register(TOKEN, t.frame);
    expect(await t.pusher.test()).toEqual([{ device: DEVICE, outcome: "sent" }]);
    const content = open(t.posts[0]!.request, t.phone, t.staticKey.publicKey);
    expect(content).toMatchObject({ event: "test", daemonName: "MacBook Pro" });
    expect(content.sessionId).toBeUndefined();
  });
});
