/**
 * The phones that asked for push notifications: `~/.grenade/push-devices.json` (mode 0600), one registration
 * per paired phone, keyed by its device id (`p_…`, the same id `grenade devices` shows). A registration
 * lives no longer than its pairing: `prune` drops the ones whose phone is gone.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { PushEnvironment, PushProvider, PushableEvent } from "@grenade/protocol";

export interface PushDevice {
  /** The paired phone's device id. */
  id: string;
  provider: PushProvider;
  deviceToken: string;
  environment: PushEnvironment;
  topic: string;
  /** The phone's push key: X25519 public, base64. */
  key: string;
  events: PushableEvent[];
  registeredAt: string;
}

export class PushDevices {
  private readonly devices = new Map<string, PushDevice>();

  constructor(private readonly path?: string) {
    this.load();
  }

  get(id: string): PushDevice | undefined {
    return this.devices.get(id);
  }

  list(): PushDevice[] {
    return [...this.devices.values()];
  }

  /** Replaces the phone's registration. */
  set(device: PushDevice): void {
    this.devices.set(device.id, device);
    this.save();
  }

  remove(id: string): boolean {
    if (!this.devices.delete(id)) return false;
    this.save();
    return true;
  }

  /** Drops every registration whose phone is no longer paired. Returns the ids that went. */
  prune(paired: ReadonlySet<string>): string[] {
    const gone = this.list().map((d) => d.id).filter((id) => !paired.has(id));
    if (gone.length === 0) return gone;
    for (const id of gone) this.devices.delete(id);
    this.save();
    return gone;
  }

  private load(): void {
    if (!this.path || !existsSync(this.path)) return;
    try {
      for (const d of JSON.parse(readFileSync(this.path, "utf8")) as PushDevice[]) {
        if (typeof d?.id === "string" && typeof d.deviceToken === "string" && typeof d.key === "string") this.devices.set(d.id, d);
      }
    } catch {
      /* corrupt file: start empty, phones register again on their next connection */
    }
  }

  private save(): void {
    if (!this.path) return;
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(this.list(), null, 2) + "\n", { mode: 0o600 });
  }
}
