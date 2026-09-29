/** `grenade pair`: shows the QR code and the typed code, then waits for the phone. */
import type { PairingState } from "../pairing/pairingWatch.js";
import { spacedCode } from "../daemon/pairCheck.js";
import { pairScreen } from "../pairing/pairScreen.js";
import type { RelayStatus } from "../relay/relayLink.js";
import type { Control } from "./controlClient.js";

interface PairCode {
  code: string;
  typed: string;
  /** Absent from a daemon that was started before it knew pairing offers. */
  offer?: string;
  expiresAt: number;
}

const POLL_MS = 1000;

/** Returns true when a phone paired, false when the code ran out. With `wait: false` it returns true right after printing. */
export async function showPairing(control: Control, o: { wait: boolean }): Promise<boolean> {
  const status = await control<{ relayLink: RelayStatus }>("GET", "/status");
  const minted = await control<PairCode>("POST", "/pair-code");
  if (!minted.offer) {
    console.log(`\n  Pairing code:  ${spacedCode(minted.typed ?? minted.code)}   (same Wi‑Fi only, runs out in 2 minutes)`);
    console.log("  The running grenaded is older than this command and has no QR code yet. Restart it to get one.\n");
    return true;
  }
  const lines = pairScreen({
    offer: minted.offer,
    typed: minted.typed,
    relayOnline: status.relayLink.state === "online",
    columns: process.stdout.isTTY ? process.stdout.columns : undefined,
    color: process.stdout.isTTY === true && !process.env["NO_COLOR"],
  });
  console.log(lines.join("\n"));
  if (!o.wait) return true;

  console.log("  Waiting for the phone… (Ctrl-C to stop)");
  for (;;) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    const s = await control<PairingState>("GET", "/pair-code");
    if (s.state === "paired") {
      console.log(`\n  Paired with ${s.phone} ${s.route === "relay" ? "through the relay" : "on the Wi‑Fi"}. See your phones with: grenade devices\n`);
      return true;
    }
    if (s.state !== "waiting") {
      console.log("\n  The code ran out before a phone paired. Run it again: grenade pair\n");
      return false;
    }
  }
}
