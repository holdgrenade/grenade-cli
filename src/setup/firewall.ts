/**
 * Is a firewall on this Linux in the way of a phone on the same Wi‑Fi? ufw (Omarchy and Ubuntu ship it) refuses
 * every incoming connection unless a rule allows the port. Its rules can only be read as root, so setup cannot tell
 * whether Grenade's port is open: it says what opens it and never runs sudo itself. The relay needs no rule, since
 * the daemon dials out to it. The parser and the lines are pure; `ufwIsOn` reads the one file anyone may read.
 */
import { readFileSync } from "node:fs";

export const UFW_CONF = "/etc/ufw/ufw.conf";

/** `ENABLED=yes` in ufw.conf: ufw starts with the system. */
export function ufwEnabledIn(conf: string): boolean {
  return /^\s*ENABLED\s*=\s*yes\s*$/im.test(conf);
}

export function ufwIsOn(platform: string = process.platform, file: string = UFW_CONF): boolean {
  if (platform !== "linux") return false;
  try {
    return ufwEnabledIn(readFileSync(file, "utf8"));
  } catch {
    return false;
  }
}

export function firewallNotice(port: number): string[] {
  return [
    `A firewall (ufw) is on. For a phone on the same Wi‑Fi to reach this computer, open Grenade's port once:`,
    `  sudo ufw allow ${port}/tcp`,
    `Through a relay the phone gets in without it.`,
  ];
}
