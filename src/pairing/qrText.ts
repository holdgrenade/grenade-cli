/**
 * A pairing offer's URL as a QR code made of half-block characters, for the terminal. Pure.
 * With `color` the rows are forced to white on black, so the code reads the same on a light and a dark terminal;
 * without it (not a TTY, NO_COLOR) the terminal's own colors draw it.
 */
import { renderUnicodeCompact } from "uqr";

const WHITE_ON_BLACK = "\u001b[97;40m";
const RESET = "\u001b[0m";
/** Blank modules around the code. Scanners want 4; 2 reads fine on a screen and saves 4 columns. */
const BORDER = 2;

export function qrRows(text: string, color: boolean): string[] {
  const rows = renderUnicodeCompact(text, { ecc: "L", border: BORDER }).split("\n");
  return color ? rows.map((r) => `${WHITE_ON_BLACK}${r}${RESET}`) : rows;
}

/** Columns the code takes: a row's visible width. */
export function qrWidth(text: string): number {
  return qrRows(text, false)[0]?.length ?? 0;
}
