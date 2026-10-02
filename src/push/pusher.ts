/**
 * Turns sessions that start waiting into push notifications (PROTOCOL.md "Push notifications").
 * Listens to the registry, applies the rules in `pushPolicy.ts`, seals one push per registered phone and
 * posts it to the relay's push route. Knows no sockets: `register` / `unregister` are called by a Connection.
 */
import { randomBytes } from "node:crypto";
import type { DaemonInfo, PushContent, PushRegisterFrame, PushRequest, PushStateFrame, Session, PushableEvent } from "@grenade/protocol";
import type { Logger } from "../log.js";
import type { X25519Pair } from "../relay/e2e.js";
import { isAtMac, readMacPresence, type MacPresence } from "./macPresence.js";
import { pushContentFor, testPushContent } from "./pushContent.js";
import type { PushGateway, PushMode } from "./pushConfig.js";
import type { PushDevice, PushDevices } from "./pushDevices.js";
import { postPush, type PushResult } from "./pushGateway.js";
import { PUSH_GRACE_MS, busyFor, decide, eventOf, settled, startedWaiting, trackBusy, worthPushing, type BusyState, type PendingPush } from "./pushPolicy.js";
import { collapseId, sealPush } from "./pushSeal.js";

/** The slice of SessionRegistry the pusher needs. Tests pass a fake. */
export interface PusherRegistryPort {
  get(id: string): Session | undefined;
  /** A hook has spoken for this session, so its status does not come from watching the screen. */
  hookDriven(id: string): boolean;
  on(event: "updated", cb: (s: Session) => void): unknown;
  on(event: "removed", cb: (id: string) => void): unknown;
  off(event: "updated", cb: (s: Session) => void): unknown;
  off(event: "removed", cb: (id: string) => void): unknown;
}

export interface PairedPhone {
  /** Device id, `p_…`. */
  id: string;
  token: string;
}

export interface PusherDeps {
  registry: PusherRegistryPort;
  devices: PushDevices;
  /** The phones paired right now. */
  paired(): PairedPhone[];
  daemon: Pick<DaemonInfo, "id" | "name">;
  staticKey: X25519Pair;
  /** Where pushes go; null while push is turned off. Read on every push, so a reload takes effect at once. */
  gateway(): PushGateway | null;
  /** Input on the Mac within this long holds a push. 0 never holds. */
  atMacMs(): number;
  /** What the user chose, for `status()`. Absent means `on`. */
  mode?: () => PushMode;
  log: Logger;
  presence?: () => Promise<MacPresence | null>;
  post?: (gateway: PushGateway, request: PushRequest) => Promise<PushResult>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  newId?: () => string;
  graceMs?: number;
  /** How often pending pushes are looked at. 0 runs no timer: the caller calls `tick()`. */
  tickMs?: number;
  /** One more try after this long, when the route could not be reached. */
  retryMs?: number;
  /** A presence reading is reused for this long. */
  presenceMaxAgeMs?: number;
}

export interface PushStatus {
  /** Pushes are sent right now. */
  enabled: boolean;
  /** What was chosen: `auto` sends while this Mac uses a relay for remote access. */
  mode: PushMode;
  gateway?: string;
  atMacSeconds: number;
  pending: number;
  devices: Array<Pick<PushDevice, "id" | "environment" | "events" | "registeredAt">>;
  /** The last push that was tried, for `grenade push status`. */
  last?: { at: string; device: string; outcome: string; error?: string };
}

export interface TestPushResult {
  device: string;
  outcome: string;
  error?: string;
}

export class Pusher {
  private readonly pending = new Map<string, PendingPush>();
  private readonly last = new Map<string, Session>();
  private readonly busy = new Map<string, BusyState>();
  /** What each session asked, from the hook that made it wait. */
  private readonly asked = new Map<string, string>();
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private reading: { at: number; presence: MacPresence | null } | null = null;
  private lastResult: PushStatus["last"];
  /** Whether pushes were being sent when the watchers were last told. */
  private sending: boolean | null = null;
  private readonly watchers = new Set<() => void>();
  private readonly now: () => number;
  private readonly onUpdated = (s: Session) => this.sessionChanged(s);
  private readonly onRemoved = (id: string) => this.forget(id);

  constructor(private readonly d: PusherDeps) {
    this.now = d.now ?? Date.now;
  }

  start(): void {
    this.d.registry.on("updated", this.onUpdated);
    this.d.registry.on("removed", this.onRemoved);
    this.pairingsChanged();
    this.sending = this.d.gateway() !== null;
  }

  stop(): void {
    this.d.registry.off("updated", this.onUpdated);
    this.d.registry.off("removed", this.onRemoved);
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.pending.clear();
  }

  // ---- phones -----------------------------------------------------------------

  /** `push.register` from the phone that said `hello` with `token`. */
  register(token: string, frame: PushRegisterFrame): PushStateFrame {
    const id = this.deviceId(token);
    if (!id) return this.stateOf(undefined);
    const known = this.d.devices.get(id);
    const device: PushDevice = {
      id,
      provider: frame.provider,
      deviceToken: frame.deviceToken,
      environment: frame.environment,
      topic: frame.topic,
      key: frame.key,
      events: [...new Set(frame.events)],
      registeredAt: known?.registeredAt ?? new Date(this.now()).toISOString(),
    };
    if (!known || JSON.stringify(known) !== JSON.stringify(device)) {
      this.d.devices.set(device);
      this.d.log.info(known ? "A phone updated its push registration" : "A phone registered for push notifications", { device: id, events: device.events.join(",") || "none" });
    }
    return this.stateOf(device);
  }

  /** `push.unregister`. */
  unregister(token: string): PushStateFrame {
    const id = this.deviceId(token);
    if (id && this.d.devices.remove(id)) this.d.log.info("A phone turned push notifications off", { device: id });
    return this.stateOf(undefined);
  }

  /**
   * For a connected phone: `send` gets a fresh `push.state` whenever this Mac starts or stops sending pushes
   * (`grenade push on|off`, remote access turned on or off), so the phone knows whether to notify by itself.
   * Returns how to stop watching.
   */
  watch(token: string, send: (state: PushStateFrame) => void): () => void {
    const tell = () => {
      const id = this.deviceId(token);
      const device = id ? this.d.devices.get(id) : undefined;
      if (device) send(this.stateOf(device));
    };
    this.watchers.add(tell);
    return () => void this.watchers.delete(tell);
  }

  /** push.json or the relay changed. Tells the watchers when pushes are now sent, or no longer. */
  deliveryMayHaveChanged(): void {
    const sending = this.d.gateway() !== null;
    const before = this.sending;
    this.sending = sending;
    if (before !== null && before !== sending) for (const tell of [...this.watchers]) tell();
  }

  /** A phone was paired or unpaired: registrations of phones that are gone go with them. */
  pairingsChanged(): void {
    const gone = this.d.devices.prune(new Set(this.d.paired().map((p) => p.id)));
    if (gone.length > 0) this.d.log.info("Removed the push registration of unpaired phones", { devices: gone.join(",") });
  }

  // ---- sessions ---------------------------------------------------------------

  /** What a hook said the agent is asking ("Claude needs your permission to use Bash"): the text of its push. */
  noteAsked(sessionId: string, message: string): void {
    if (message.trim()) this.asked.set(sessionId, message);
  }

  private sessionChanged(session: Session): void {
    const previous = this.last.get(session.id);
    this.last.set(session.id, session);
    const at = this.now();
    const before = this.busy.get(session.id) ?? settled;
    const busy = trackBusy(before, session.status, at);
    this.busy.set(session.id, busy);

    if (session.status !== "waiting") {
      this.pending.delete(session.id);
      if (session.status === "working") this.asked.delete(session.id);
      return;
    }
    if (!startedWaiting(previous, session)) return;
    const event = eventOf(session);
    if (!worthPushing(event, this.d.registry.hookDriven(session.id), busyFor(busy, at))) {
      this.d.log.debug("No push: the session was only busy for a moment", { session: session.id });
      return;
    }
    this.pending.set(session.id, { sessionId: session.id, event, statusSince: session.statusSince, dueAt: at + (this.d.graceMs ?? PUSH_GRACE_MS) });
    this.ensureTimer();
  }

  private forget(id: string): void {
    this.pending.delete(id);
    this.last.delete(id);
    this.busy.delete(id);
    this.asked.delete(id);
  }

  /** Looks at every pending push once: drops, keeps or sends it. */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const at = this.now();
      const due = [...this.pending.values()].filter((p) => at >= p.dueAt);
      const atMac = due.length > 0 && isAtMac(await this.presence(), this.d.atMacMs());
      const sends: Promise<void>[] = [];
      for (const p of [...this.pending.values()]) {
        const session = this.d.registry.get(p.sessionId);
        const decision = decide(p, session, atMac, at);
        if (decision === "wait" || decision === "hold") continue;
        this.pending.delete(p.sessionId);
        if (decision === "send" && session) sends.push(this.send(p.event, session));
      }
      if (this.pending.size === 0 && this.timer) {
        clearInterval(this.timer);
        this.timer = null;
      }
      await Promise.all(sends);
    } finally {
      this.ticking = false;
    }
  }

  private ensureTimer(): void {
    const every = this.d.tickMs ?? 1000;
    if (this.timer || every <= 0) return;
    this.timer = setInterval(() => void this.tick().catch((e) => this.d.log.warn("Could not send push notifications", { error: e })), every);
    this.timer.unref();
  }

  private async presence(): Promise<MacPresence | null> {
    if (this.d.atMacMs() <= 0) return null;
    const at = this.now();
    if (this.reading && at - this.reading.at < (this.d.presenceMaxAgeMs ?? 5000)) return this.reading.presence;
    const presence = await (this.d.presence ?? readMacPresence)();
    this.reading = { at, presence };
    return presence;
  }

  // ---- sending ----------------------------------------------------------------

  private async send(event: PushableEvent, session: Session): Promise<void> {
    const gateway = this.d.gateway();
    if (!gateway) return;
    const phones = this.d.devices.list().filter((d) => d.events.includes(event));
    if (phones.length === 0) return;
    const content = pushContentFor({ id: this.newId(), at: this.now(), event, daemon: this.d.daemon, session, asked: this.asked.get(session.id) });
    const stillWaiting = () => {
      const s = this.d.registry.get(session.id);
      return s?.status === "waiting" && s.statusSince === session.statusSince;
    };
    await Promise.all(phones.map((phone) => this.sendTo(phone, gateway, content, session.id, stillWaiting)));
  }

  /** Every registered phone gets a push that says so. For `grenade push test`. */
  async test(): Promise<TestPushResult[]> {
    const gateway = this.d.gateway();
    if (!gateway) return [];
    const content = testPushContent(this.newId(), this.now(), this.d.daemon);
    return Promise.all(
      this.d.devices.list().map(async (phone) => {
        const r = await this.sendTo(phone, gateway, content, content.id, () => true);
        return { device: phone.id, outcome: r.outcome, ...(r.error ? { error: r.error } : {}) };
      }),
    );
  }

  private async sendTo(phone: PushDevice, gateway: PushGateway, content: PushContent, subject: string, stillWanted: () => boolean): Promise<PushResult> {
    const token = this.d.paired().find((p) => p.id === phone.id)?.token;
    if (!token) {
      this.d.devices.remove(phone.id);
      return { outcome: "refused", error: "not paired" };
    }
    let request: PushRequest;
    try {
      const sealed = sealPush(content, this.d.staticKey, Buffer.from(phone.key, "base64"));
      request = {
        provider: phone.provider,
        deviceToken: phone.deviceToken,
        environment: phone.environment,
        topic: phone.topic,
        collapse: collapseId(token, subject),
        e: sealed.e,
        c: sealed.c,
      };
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      this.d.log.warn("Could not seal a push for a phone", { device: phone.id, error });
      return this.note(phone, { outcome: "refused", error });
    }
    const post = this.d.post ?? postPush;
    let result = await post(gateway, request);
    if (result.outcome === "retry") {
      await (this.d.sleep ?? sleep)(this.d.retryMs ?? 5000);
      if (!stillWanted()) return this.note(phone, result);
      result = await post(gateway, request);
    }
    this.note(phone, result);
    if (result.outcome === "sent") {
      this.d.log.info(`Sent a push: ${content.event}`, { device: phone.id, ...(content.sessionId ? { session: content.sessionId } : {}) });
    } else if (result.outcome === "unregistered") {
      this.d.devices.remove(phone.id);
      this.d.log.info("A phone no longer takes pushes (the app was removed); forgot its registration", { device: phone.id });
    } else {
      this.d.log.warn("A push was not delivered", { device: phone.id, gateway: gateway.url, status: result.status, error: result.error });
    }
    return result;
  }

  private note(phone: PushDevice, result: PushResult): PushResult {
    this.lastResult = { at: new Date(this.now()).toISOString(), device: phone.id, outcome: result.outcome, ...(result.error ? { error: result.error } : {}) };
    return result;
  }

  // ---- state ------------------------------------------------------------------

  status(): PushStatus {
    const gateway = this.d.gateway();
    return {
      enabled: gateway !== null,
      mode: this.d.mode?.() ?? "on",
      ...(gateway ? { gateway: gateway.url } : {}),
      atMacSeconds: Math.round(this.d.atMacMs() / 1000),
      pending: this.pending.size,
      devices: this.d.devices.list().map((d) => ({ id: d.id, environment: d.environment, events: d.events, registeredAt: d.registeredAt })),
      ...(this.lastResult ? { last: this.lastResult } : {}),
    };
  }

  private stateOf(device: PushDevice | undefined): PushStateFrame {
    return { type: "push.state", registered: device !== undefined, delivery: this.d.gateway() ? "gateway" : "off", events: device?.events ?? [] };
  }

  private deviceId(token: string): string | undefined {
    return this.d.paired().find((p) => p.token === token)?.id;
  }

  private newId(): string {
    return (this.d.newId ?? (() => `n_${randomBytes(6).toString("hex")}`))();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms).unref());
}
