/**
 * Pure: reads the output of a tmux control-mode client (`tmux -C`), the interface iTerm2's tmux integration uses.
 * Feed it stdout as it arrives; it hands back whole events. Lines are bytes, not text: `%output` carries the pane's
 * bytes with only control characters and backslashes escaped as `\ooo`, so a UTF-8 character can arrive split.
 */

export type ControlEvent =
  /** Bytes a pane wrote (`%output %<pane> …`), unescaped. */
  | { kind: "output"; pane: string; data: Buffer }
  /** The reply to one command: its lines, and whether it failed (`%error`). `fromClient` is false for attach's own. */
  | { kind: "reply"; ok: boolean; lines: Buffer[]; fromClient: boolean }
  /** The client was detached or the session ended. */
  | { kind: "exit" };

const NEWLINE = 0x0a;
const BACKSLASH = 0x5c;
const OUTPUT = Buffer.from("%output ");
const BEGIN = /^%begin (\d+) (\d+) (\d+)$/;
const END = /^%(end|error) (\d+) (\d+) (\d+)$/;

export class ControlParser {
  private partial: Buffer = Buffer.alloc(0);
  /** The open reply block: its number and lines so far. */
  private block: { num: string; fromClient: boolean; lines: Buffer[] } | null = null;

  feed(chunk: Buffer): ControlEvent[] {
    const events: ControlEvent[] = [];
    let data = this.partial.length > 0 ? Buffer.concat([this.partial, chunk]) : chunk;
    let at = data.indexOf(NEWLINE);
    while (at !== -1) {
      const line = data.subarray(0, at);
      data = data.subarray(at + 1);
      const event = this.line(line);
      if (event) events.push(event);
      at = data.indexOf(NEWLINE);
    }
    this.partial = Buffer.from(data);
    return events;
  }

  private line(raw: Buffer): ControlEvent | null {
    const line = raw.length > 0 && raw[raw.length - 1] === 0x0d ? raw.subarray(0, raw.length - 1) : raw;
    if (this.block) {
      const end = END.exec(line.toString("latin1"));
      if (end && end[3] === this.block.num) {
        const done: ControlEvent = { kind: "reply", ok: end[1] === "end", lines: this.block.lines, fromClient: this.block.fromClient };
        this.block = null;
        return done;
      }
      this.block.lines.push(Buffer.from(line));
      return null;
    }
    if (line.subarray(0, OUTPUT.length).equals(OUTPUT)) {
      const rest = line.subarray(OUTPUT.length);
      const space = rest.indexOf(0x20);
      if (space === -1) return null;
      return { kind: "output", pane: rest.subarray(0, space).toString("latin1"), data: unescapeOutput(rest.subarray(space + 1)) };
    }
    const text = line.toString("latin1");
    const begin = BEGIN.exec(text);
    if (begin) {
      this.block = { num: begin[2]!, fromClient: (Number(begin[3]) & 1) === 1, lines: [] };
      return null;
    }
    if (text === "%exit" || text.startsWith("%exit ")) return { kind: "exit" };
    return null;
  }
}

/** `\ooo` (three octal digits) back to the byte; everything else is the byte itself. */
export function unescapeOutput(escaped: Buffer): Buffer {
  if (escaped.indexOf(BACKSLASH) === -1) return Buffer.from(escaped);
  const out = Buffer.alloc(escaped.length);
  let n = 0;
  for (let i = 0; i < escaped.length; i++) {
    const b = escaped[i]!;
    if (b === BACKSLASH && i + 3 < escaped.length &&isOctal(escaped[i + 1]) && isOctal(escaped[i + 2]) && isOctal(escaped[i + 3])) {
      out[n++] = ((escaped[i + 1]! - 48) << 6) | ((escaped[i + 2]! - 48) << 3) | (escaped[i + 3]! - 48);
      i += 3;
    } else {
      out[n++] = b;
    }
  }
  return out.subarray(0, n);
}

const isOctal = (b: number | undefined) => b !== undefined && b >= 0x30 && b <= 0x37;
