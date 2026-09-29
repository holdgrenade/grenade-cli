/**
 * What `grenade pair` prints: the two ways to pair, each under its own heading with where it works.
 * Option 1 is the QR code, option 2 the typed code. The phone's pairing screen names them the same. Pure.
 */
import { spacedCode } from "../daemon/pairCheck.js";
import { qrRows, qrWidth } from "./qrText.js";

export interface PairScreenInput {
  /** The pairing offer's URL. */
  offer: string;
  /** The code with its check digits. */
  typed: string;
  /** The relay link is online, so the offer also works away from this Mac's Wi‑Fi. */
  relayOnline: boolean;
  /** Width of the terminal, when known. */
  columns: number | undefined;
  color: boolean;
}

const INDENT = "  ";
/** The typed code stands alone, further in, so it is found at a glance. */
const CODE_INDENT = "      ";
const BOLD = "\u001b[1m";
const RESET = "\u001b[0m";

export function pairScreen(i: PairScreenInput): string[] {
  const bold = (text: string) => (i.color ? `${BOLD}${text}${RESET}` : text);
  const needed = qrWidth(i.offer) + INDENT.length;
  const fits = i.columns === undefined || i.columns >= needed;
  const lines: string[] = [""];

  lines.push(`${INDENT}${bold("Pair your phone with this Mac")}`);
  lines.push(`${INDENT}Pick one of the two. Each works once and runs out in 2 minutes.`);
  lines.push("");

  lines.push(`${INDENT}${bold("OPTION 1 · SCAN THE QR CODE")}`);
  if (fits) {
    lines.push(`${INDENT}In the Grenade app, tap "Scan QR code".`);
    lines.push(`${INDENT}${i.relayOnline ? "Works from any network: the relay is on." : "Works on this Mac's Wi‑Fi. For any network, turn the relay on first: grenade relay on"}`);
    lines.push("");
    lines.push(...qrRows(i.offer, i.color).map((row) => INDENT + row));
  } else {
    lines.push(`${INDENT}This window is too narrow for the QR code.`);
    lines.push(`${INDENT}Make it ${needed} columns wide and run grenade pair again.`);
  }
  lines.push("");

  lines.push(`${INDENT}${bold("OPTION 2 · TYPE THE CODE")}`);
  lines.push(`${INDENT}In the Grenade app, pick this Mac and type the code. Same Wi‑Fi only.`);
  lines.push("");
  lines.push(`${CODE_INDENT}${bold(spacedCode(i.typed))}`);
  lines.push("");
  return lines;
}
