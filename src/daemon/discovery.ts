/**
 * Advertises the daemon on the local network as `_grenade._tcp`.
 *
 * On macOS the registration goes through the system responder (`dns-sd -R`, mDNSResponder). It owns the
 * SRV/A/AAAA records, so when the Mac joins another Wi‑Fi the service resolves to the new address at once.
 * The JS mDNS stack (`bonjour-service`) is the fallback elsewhere; it snapshots the interfaces at publish
 * time and keeps answering with stale addresses after a network change, which is exactly what we must avoid.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { Bonjour } from "bonjour-service";
import { BONJOUR_TYPE } from "@grenade/protocol";
import type { Logger } from "../log.js";

export interface DiscoveryOptions {
  port: number;
  id: string;
  name: string;
  /** The daemon's public key, base64. Advertised so a phone can check a typed pairing code against it. */
  key: string;
  log: Logger;
  /** Force one backend; default is `dns-sd` on darwin, `bonjour-service` elsewhere. */
  backend?: "dns-sd" | "bonjour-service";
}

export interface Discovery {
  backend: "dns-sd" | "bonjour-service";
  stop(): Promise<void>;
}

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

export function startDiscovery(opts: DiscoveryOptions): Discovery {
  const backend = opts.backend ?? (process.platform === "darwin" ? "dns-sd" : "bonjour-service");
  return backend === "dns-sd" ? startDnsSd(opts) : startBonjourService(opts);
}

function startDnsSd(opts: DiscoveryOptions): Discovery {
  let child: ChildProcess | null = null;
  let stopped = false;
  let restarts = 0;

  const launch = () => {
    child = spawn("/usr/bin/dns-sd", dnsSdArgs(opts), { stdio: ["ignore", "ignore", "pipe"] });
    child.stderr?.on("data", (d: Buffer) => opts.log.warn(`dns-sd: ${d.toString().trim()}`));
    child.on("exit", (code, signal) => {
      if (stopped) return;
      // mDNSResponder registrations die with the process; bring it back with a small backoff.
      restarts += 1;
      const delay = Math.min(1000 * restarts, 10_000);
      opts.log.warn(`Bonjour advertiser stopped; restarting in ${delay / 1000}s`, { code, signal: signal ?? undefined });
      setTimeout(launch, delay).unref();
    });
  };
  launch();
  opts.log.debug("Advertising on the local network", { backend: "dns-sd", type: `_${BONJOUR_TYPE}._tcp`, port: opts.port, name: opts.name });

  return {
    backend: "dns-sd",
    stop: () =>
      new Promise<void>((resolve) => {
        stopped = true;
        if (!child || child.exitCode !== null) return resolve();
        child.once("exit", () => resolve());
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
