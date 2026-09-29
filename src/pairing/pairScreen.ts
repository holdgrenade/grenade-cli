/** What `grenade pair` prints: the QR code, the typed code, and where each of them works. Pure. */
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

export function pairScreen(i: PairScreenInput): string[] {
  const needed = qrWidth(i.offer) + INDENT.length;
  const fits = i.columns === undefined || i.columns >= needed;
  const lines: string[] = [""];
  if (fits) {
    lines.push(`${INDENT}Scan this in Grenade on your phone:`, "");
    lines.push(...qrRows(i.offer, i.color).map((row) => INDENT + row));
    lines.push("");
    lines.push(`${INDENT}${i.relayOnline ? "Works from any network: the relay is on." : "Works on this Mac's Wi‑Fi. For any network, turn the relay on first: grenade relay on"}`);
    lines.push("");
    lines.push(`${INDENT}Or pick this Mac in the app and type:  ${spacedCode(i.typed)}   (same Wi‑Fi only)`);
  } else {
    lines.push(`${INDENT}This window is too narrow for the QR code. Make it ${needed} columns wide and run grenade pair again,`);
    lines.push(`${INDENT}or pick this Mac in the app and type:  ${spacedCode(i.typed)}   (same Wi‑Fi only)`);
  }
  lines.push(`${INDENT}The last four digits let the phone check that it is talking to this Mac.`);
  lines.push("");
  lines.push(`${INDENT}Both work once and run out in 2 minutes.`);
  lines.push("");
  return lines;
}
