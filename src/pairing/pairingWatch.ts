/**
 * What became of the last `grenade pair`: still waiting, a phone paired, or the time ran out.
 * `grenade pair` and `grenade setup` ask for it while the QR code is on screen. Pure: inject `now`.
 */
import type { ClientInfo } from "@grenade/protocol";

export type PairingState =
  | { state: "none" }
  | { state: "waiting"; expiresAt: number }
  | { state: "expired" }
  | { state: "paired"; phone: string; platform: ClientInfo["platform"]; route: "lan" | "relay" };

export class PairingWatch {
  private current: PairingState = { state: "none" };

  constructor(private readonly now: () => number = Date.now) {}

  minted(expiresAt: number): void {
    this.current = { state: "waiting", expiresAt };
  }

  paired(client: ClientInfo, route: "lan" | "relay"): void {
    this.current = { state: "paired", phone: client.name, platform: client.platform, route };
  }

  /** Five wrong tries voided the code and the secret. */
  voided(): void {
    if (this.current.state === "waiting") this.current = { state: "expired" };
  }

  state(): PairingState {
    if (this.current.state === "waiting" && this.now() > this.current.expiresAt) this.current = { state: "expired" };
    return this.current;
  }
}
