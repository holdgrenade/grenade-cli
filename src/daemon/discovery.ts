/**
 * Advertises the daemon on the local network as `_grenade._tcp`.
 *
 * The registration goes through the system's responder wherever there is one: `dns-sd -R` (mDNSResponder) on
 * macOS, `avahi-publish -s` (avahi-daemon) on Linux. The responder owns the SRV/A/AAAA records, so when the
 * computer joins another Wi‑Fi the service resolves to the new address at once. The JS mDNS stack
 * (`bonjour-service`) is the fallback, for a Linux without avahi; it snapshots the interfaces at publish time and
 * keeps answering with stale addresses after a network change, which is exactly what we must avoid.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { Bonjour } from "bonjour-service";
import { BONJOUR_TYPE } from "@grenade/protocol";
import type { Logger } from "../log.js";
import { findOnPath } from "../platform/findOnPath.js";

export type DiscoveryBackend = "dns-sd" | "avahi" | "bonjour-service";

export interface DiscoveryOptions {
  port: number;
  id: string;
  name: string;
  /** The daemon's public key, base64. Advertised so a phone can check a typed pairing code against it. */
  key: string;
  log: Logger;
  /** Force one backend; default is `defaultBackend`. */
  backend?: DiscoveryBackend;
}

export interface Discovery {
  /** The backend in use now: `avahi` gives way to `bonjour-service` when avahi-daemon never answered. */
  readonly backend: DiscoveryBackend;
  stop(): Promise<void>;
}

const DNS_SD = "/usr/bin/dns-sd";
const AVAHI_PUBLISH = "avahi-publish";

/** Instance name the phone sees in its browser: "MacBook Pro (d_abc123)". */
export function instanceName(o: { name: string; id: string }): string {
  return `${o.name} (${o.id})`;
}

/** The TXT record (PROTOCOL.md "Transport"): `e2e=1` says `/ws` takes the encrypted handshake. Pure. */
export function txtRecord(o: { name: string; id: string; key: string }): Record<string, string> {
  return { v: "1", id: o.id, name: o.name, e2e: "1", ...(o.key ? { key: o.key } : {}) };
}

/** Arguments for `dns-sd -R`: name, type, domain, port, then TXT key=value pairs. Pure, tested. */
export function dnsSdArgs(o: { name: string; id: string; port: number; key: string }): string[] {
  const txt = Object.entries(txtRecord(o)).map(([k, v]) => `${k}=${v}`);
  return ["-R", instanceName(o), `_${BONJOUR_TYPE}._tcp`, ".", String(o.port), ...txt];
}

/** Arguments for `avahi-publish -s`: name, type, port, then TXT key=value pairs. Pure, tested. */
export function avahiArgs(o: { name: string; id: string; port: number; key: string }): string[] {
  const txt = Object.entries(txtRecord(o)).map(([k, v]) => `${k}=${v}`);
  return ["-s", instanceName(o), `_${BONJOUR_TYPE}._tcp`, String(o.port), ...txt];
}

/** Which backend a system gets: its own responder when it has one. Pure. */
export function defaultBackend(platform: string, hasAvahi: boolean): DiscoveryBackend {
  if (platform === "darwin") return "dns-sd";
  return hasAvahi ? "avahi" : "bonjour-service";
}

export function startDiscovery(opts: DiscoveryOptions): Discovery {
  const backend = opts.backend ?? defaultBackend(process.platform, findOnPath(AVAHI_PUBLISH) !== null);
  if (backend === "dns-sd") return startResponder(opts, { backend, command: DNS_SD, args: dnsSdArgs(opts) });
  if (backend === "avahi") return startAvahi(opts);
  return startBonjourService(opts);
}

/** avahi-publish, or the JS stack in its place when avahi-daemon is not running (the tool is there, the daemon is off). */
function startAvahi(opts: DiscoveryOptions): Discovery {
  let fallback: Discovery | null = null;
  let stopped = false;
  const responder = startResponder(opts, {
    backend: "avahi",
    command: AVAHI_PUBLISH,
    args: avahiArgs(opts),
    // It prints "Established under name '…'" once the daemon took the registration.
    established: /Established under name/,
    onNeverEstablished: () => {
      if (stopped) return;
      opts.log.info("avahi-daemon did not take the registration; advertising without it");
      fallback = startBonjourService(opts);
    },
  });
  return {
    get backend() {
      return fallback ? fallback.backend : responder.backend;
    },
    stop: async () => {
      stopped = true;
      await responder.stop();
      await fallback?.stop();
    },
  };
}

interface Responder {
  backend: DiscoveryBackend;
  command: string;
  args: string[];
  /** What the command prints once the registration stands. Without it every exit is followed by a restart. */
  established?: RegExp;
  /** The command ended before it ever printed `established`: it is not started again. */
  onNeverEstablished?(): void;
}

/** Keeps one registering command alive: the registration dies with the process, so it is brought back with a small backoff. */
function startResponder(opts: DiscoveryOptions, r: Responder): Discovery {
  let child: ChildProcess | null = null;
  let stopped = false;
  let restarts = 0;
  let everEstablished = r.established === undefined;

  const launch = () => {
    child = spawn(r.command, r.args, { stdio: ["ignore", "ignore", "pipe"] });
    child.stderr?.on("data", (d: Buffer) => {
      const text = d.toString().trim();
      if (r.established?.test(text)) {
        everEstablished = true;
        return opts.log.debug(`${r.backend}: ${text}`);
      }
      opts.log.warn(`${r.backend}: ${text}`);
    });
    // A command that cannot be started (not there) ends like one that exited.
    child.on("error", (e) => opts.log.warn(`${r.backend} could not be started`, { error: e }));
    child.on("close", (code, signal) => {
      if (stopped) return;
      if (!everEstablished) return r.onNeverEstablished?.();
      restarts += 1;
      const delay = Math.min(1000 * restarts, 10_000);
      opts.log.warn(`Bonjour advertiser stopped; restarting in ${delay / 1000}s`, { code: code ?? undefined, signal: signal ?? undefined });
      setTimeout(launch, delay).unref();
    });
  };
  launch();
  opts.log.debug("Advertising on the local network", { backend: r.backend, type: `_${BONJOUR_TYPE}._tcp`, port: opts.port, name: opts.name });

  return {
    backend: r.backend,
    stop: () =>
      new Promise<void>((resolve) => {
        stopped = true;
        if (!child || child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return resolve();
        child.once("close", () => resolve());
        child.kill("SIGTERM");
      }),
  };
}

function startBonjourService(opts: DiscoveryOptions): Discovery {
  const bonjour = new Bonjour();
  const service = bonjour.publish({
    name: instanceName(opts),
    type: BONJOUR_TYPE,
    port: opts.port,
    txt: txtRecord(opts),
  });
  service.on("error", (e: unknown) => opts.log.warn("Bonjour error", { error: e }));
  opts.log.debug("Advertising on the local network", { backend: "bonjour-service", type: `_${BONJOUR_TYPE}._tcp`, port: opts.port, name: opts.name });
  return {
    backend: "bonjour-service",
    stop: () =>
      new Promise<void>((resolve) => {
        bonjour.unpublishAll(() => {
          bonjour.destroy();
          resolve();
        });
      }),
  };
}
