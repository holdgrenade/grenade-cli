/**
 * Pure: what a live terminal stream (PROTOCOL.md "Live terminal") writes first, and how typed bytes reach the pane.
 * The first paint puts a fresh terminal emulator in the state the pane is in: scrollback and screen as tmux holds
 * them, the cursor, and the modes the agent switched on before the client came (bracketed paste, cursor keys, mouse).
 */

/** Rows of scrollback the first paint carries above the screen. */
export const PAINT_HISTORY_ROWS = 1000;

/** The pane's state, read with `display-message -p` and `PANE_STATE_FORMAT`. */
export interface PaneState {
  paneId: string;
  height: number;
  cursorX: number;
  cursorY: number;
  cursorVisible: boolean;
  alternate: boolean;
  bracketedPaste: boolean;
  cursorKeys: boolean;
  keypad: boolean;
  mouseStandard: boolean;
  mouseButton: boolean;
  mouseAll: boolean;
  mouseSgr: boolean;
  mouseUtf8: boolean;
  insert: boolean;
  wrap: boolean;
}

export const PANE_STATE_FORMAT = [
  "#{pane_id}", "#{pane_height}", "#{cursor_x}", "#{cursor_y}", "#{cursor_flag}", "#{alternate_on}",
  "#{bracket_paste_flag}", "#{keypad_cursor_flag}", "#{keypad_flag}", "#{mouse_standard_flag}", "#{mouse_button_flag}",
  "#{mouse_all_flag}", "#{mouse_sgr_flag}", "#{mouse_utf8_flag}", "#{insert_flag}", "#{wrap_flag}",
].join(" ");

export function parsePaneState(line: string): PaneState | null {
  const f = line.trim().split(" ");
  if (f.length !== 16 || !f[0]!.startsWith("%")) return null;
  const n = f.slice(1, 4).map(Number);
  if (n.some((v) => !Number.isInteger(v) || v < 0)) return null;
  const on = (i: number) => f[i] === "1";
  return {
    paneId: f[0]!, height: n[0]!, cursorX: n[1]!, cursorY: n[2]!, cursorVisible: on(4), alternate: on(5),
    bracketedPaste: on(6), cursorKeys: on(7), keypad: on(8), mouseStandard: on(9), mouseButton: on(10),
    mouseAll: on(11), mouseSgr: on(12), mouseUtf8: on(13), insert: on(14), wrap: on(15),
  };
}

const ESC = "\x1b";

/**
 * The bytes that bring a reset terminal to the pane's state. `rows` is `capture-pane -p -e -S -<n>` split on newlines
 * (scrollback, then the visible pane's `state.height` rows, each with its SGR sequences).
 */
export function firstPaint(rows: Buffer[], state: PaneState): Buffer {
  const visible = Math.min(state.height, rows.length);
  const history = state.alternate ? [] : rows.slice(0, rows.length - visible);
  const screen = rows.slice(rows.length - visible);
  const parts: Buffer[] = [Buffer.from(`${ESC}c`)];
  const crlf = Buffer.from("\r\n");
  const lines = [...history, ...(state.alternate ? [] : screen)];
  lines.forEach((row, i) => {
    if (i > 0) parts.push(crlf);
    parts.push(row);
  });
  if (state.alternate) {
    // The alternate screen has no scrollback: switch to it, then draw the screen from its top.
    parts.push(Buffer.from(`${ESC}[0m${ESC}[?1049h${ESC}[H`));
    screen.forEach((row, i) => {
      if (i > 0) parts.push(crlf);
      parts.push(row);
    });
  }
  parts.push(Buffer.from(`${ESC}[0m${modes(state)}${ESC}[${state.cursorY + 1};${state.cursorX + 1}H`));
  return Buffer.concat(parts);
}

function modes(s: PaneState): string {
  const set = (on: boolean, mode: number) => (on ? `${ESC}[?${mode}h` : "");
  return [
    set(s.cursorKeys, 1),
    s.keypad ? `${ESC}=` : "",
    s.wrap ? "" : `${ESC}[?7l`,
    s.insert ? `${ESC}[4h` : "",
    set(s.mouseStandard, 1000),
    set(s.mouseButton, 1002),
    set(s.mouseAll, 1003),
    set(s.mouseUtf8, 1005),
    set(s.mouseSgr, 1006),
    set(s.bracketedPaste, 2004),
    s.cursorVisible ? "" : `${ESC}[?25l`,
  ].join("");
}

/** Bytes per `send-keys -H` command, so no command line grows long. */
const KEYS_PER_COMMAND = 256;

/** Control-mode command lines that hand `bytes` to the pane unchanged (`send-keys -H`: one hex byte per key). */
export function sendBytesCommands(target: string, bytes: Buffer): string[] {
  const out: string[] = [];
  for (let i = 0; i < bytes.length; i += KEYS_PER_COMMAND) {
    const hex = [...bytes.subarray(i, i + KEYS_PER_COMMAND)].map((b) => b.toString(16).padStart(2, "0"));
    out.push(`send-keys -t ${target} -H ${hex.join(" ")}`);
  }
  return out;
}

/** Typed bytes that interrupt the agent (Esc alone, or Ctrl-C): an interrupt fires no hook, so the transcript is read. */
export function isInterrupt(bytes: Buffer): boolean {
  return (bytes.length === 1 && bytes[0] === 0x1b) || bytes.includes(0x03);
}
