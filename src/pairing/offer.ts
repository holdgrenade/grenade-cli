/** Builds the pairing offer `grenade pair` shows as a QR code (PROTOCOL.md "Pairing offer (QR code)"). Pure. */
import { PAIR_OFFER_MAX_HOSTS, PAIR_OFFER_VERSION, encodePairingOffer, type DaemonInfo, type PairingOffer } from "@grenade/protocol";

export function offerFor(daemon: DaemonInfo, secret: string, hosts: string[], port: number): PairingOffer {
  if (!daemon.key) throw new Error("the daemon has no end-to-end key to offer");
  return {
    v: PAIR_OFFER_VERSION,
    id: daemon.id,
    name: daemon.name.slice(0, 100),
    key: daemon.key,
    secret,
    hosts: hosts.slice(0, PAIR_OFFER_MAX_HOSTS),
    port,
    ...(daemon.relay ? { relay: { url: daemon.relay.url, id: daemon.relay.id } } : {}),
  };
}

export function offerUrlFor(daemon: DaemonInfo, secret: string, hosts: string[], port: number): string {
  return encodePairingOffer(offerFor(daemon, secret, hosts, port));
}
