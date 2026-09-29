/** Builds the daemon's push notifications from its files and the things it shares with the rest of the daemon. */
import type { DaemonInfo } from "@grenade/protocol";
import type { Logger } from "../log.js";
import type { X25519Pair } from "../relay/e2e.js";
import type { RelayConfig } from "../relay/relayConfig.js";
import { atMacMs, loadPushConfig, pushGatewayFor, pushMode, type PushConfig } from "./pushConfig.js";
import { PushDevices } from "./pushDevices.js";
import { Pusher, type PairedPhone, type PushStatus, type PusherDeps, type PusherRegistryPort, type TestPushResult } from "./pusher.js";

export interface PushServiceDeps {
  registry: PusherRegistryPort;
  /** The paired phones, and a call whenever one is paired or unpaired. */
  tokens: { list(): PairedPhone[]; onChange(listener: () => void): void };
  daemon: Pick<DaemonInfo, "id" | "name">;
  staticKey: X25519Pair;
  /** The relay this Mac uses for remote access right now, if any: its push route is the default one. */
  relay(): RelayConfig | null;
  /** push.json. */
  configPath: string;
  /** push-devices.json; undefined keeps registrations in memory (tests). */
  devicesPath?: string | undefined;
  log: Logger;
  /** For tests: the sender, the clock, the presence reading. */
  overrides?: Partial<Pick<PusherDeps, "post" | "presence" | "now" | "sleep" | "tickMs" | "graceMs" | "retryMs">>;
}

export interface PushService {
  pusher: Pusher;
  status(): PushStatus;
  /** Re-reads push.json. Called by `grenade push on|off|auto`. */
  reload(): PushStatus;
  /** Remote access was turned on or off: with `auto` that turns push on or off too. */
  relayChanged(): void;
  test(): Promise<TestPushResult[]>;
  stop(): void;
}

export function startPush(d: PushServiceDeps): PushService {
  let config: PushConfig = loadPushConfig(d.configPath);
  const pusher = new Pusher({
    registry: d.registry,
    devices: new PushDevices(d.devicesPath),
    paired: () => d.tokens.list().map((t) => ({ id: t.id, token: t.token })),
    daemon: d.daemon,
    staticKey: d.staticKey,
    gateway: () => pushGatewayFor(config, d.relay()),
    atMacMs: () => atMacMs(config),
    mode: () => pushMode(config),
    log: d.log,
    ...d.overrides,
  });
  d.tokens.onChange(() => pusher.pairingsChanged());
  pusher.start();
  const describe = () => {
    const s = pusher.status();
    const off = s.mode === "auto" ? "Push notifications are off: remote access is off (grenade push on turns them on)" : "Push notifications are off";
    d.log.info(s.enabled ? "Push notifications are on" : off, { ...(s.gateway ? { gateway: s.gateway } : {}), phones: s.devices.length });
    return s;
  };
  describe();
  return {
    pusher,
    status: () => pusher.status(),
    reload() {
      config = loadPushConfig(d.configPath);
      pusher.deliveryMayHaveChanged();
      return describe();
    },
    relayChanged() {
      const before = pusher.status().enabled;
      pusher.deliveryMayHaveChanged();
      if (pusher.status().enabled !== before) describe();
    },
    test: () => pusher.test(),
    stop: () => pusher.stop(),
  };
}
