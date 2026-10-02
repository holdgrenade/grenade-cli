import { describe, expect, it } from "vitest";
import { ControlParser, unescapeOutput } from "../src/tmux/controlParser.js";
import { PANE_STATE_FORMAT, firstPaint, isInterrupt, parsePaneState, sendBytesCommands, type PaneState } from "../src/tmux/termPaint.js";

const b = (s: string) => Buffer.from(s, "latin1");

describe("ControlParser", () => {
  it("reads output, replies and exit, across split chunks", () => {
    const p = new ControlParser();
    const raw = b("%begin 1 284 0\n%end 1 284 0\n%session-changed $0 x\n%output %0 hi\\015\\012\\134\n%begin 2 290 1\n%0 8\n%end 2 290 1\n%begin 3 291 1\n%error 3 291 1\n%exit\n");
    const events = [...p.feed(raw.subarray(0, 37)), ...p.feed(raw.subarray(37, 61)), ...p.feed(raw.subarray(61))];
    expect(events).toEqual([
      { kind: "reply", ok: true, lines: [], fromClient: false },
      { kind: "output", pane: "%0", data: b("hi\r\n\\") },
      { kind: "reply", ok: true, lines: [b("%0 8")], fromClient: true },
      { kind: "reply", ok: false, lines: [], fromClient: true },
      { kind: "exit" },
    ]);
  });

  it("keeps a reply's lines as raw bytes, even ones that look like notifications", () => {
    const p = new ControlParser();
    const events = p.feed(b("%begin 5 10 1\n\x1b[1mbold\x1b[0m\n%output %9 x\n%end 5 10 1\n"));
    expect(events).toEqual([{ kind: "reply", ok: true, lines: [b("\x1b[1mbold\x1b[0m"), b("%output %9 x")], fromClient: true }]);
  });

  it("passes UTF-8 bytes through and leaves a lone backslash alone", () => {
    expect(unescapeOutput(Buffer.from("✓\\033[A\\9"))).toEqual(Buffer.from("✓\x1b[A\\9"));
  });
});

const state = (over: Partial<PaneState> = {}): PaneState => ({
  paneId: "%3", height: 2, cursorX: 4, cursorY: 1, cursorVisible: true, alternate: false, bracketedPaste: false,
  cursorKeys: false, keypad: false, mouseStandard: false, mouseButton: false, mouseAll: false, mouseSgr: false,
  mouseUtf8: false, insert: false, wrap: true, ...over,
});

describe("first paint", () => {
  it("parses the pane state the format asks for", () => {
    expect(PANE_STATE_FORMAT.split(" ")).toHaveLength(16);
    expect(parsePaneState("%3 2 4 1 1 0 1 1 0 0 0 0 1 0 0 1\n")).toEqual(state({ bracketedPaste: true, cursorKeys: true, mouseSgr: true }));
    expect(parsePaneState("nope")).toBeNull();
  });

  it("writes scrollback and screen, then the modes and the cursor", () => {
    const paint = firstPaint([b("old"), b("\x1b[1mtop"), b("> /")], state({ bracketedPaste: true, cursorVisible: false }));
    expect(paint.toString("latin1")).toBe("\x1bcold\r\n\x1b[1mtop\r\n> /\x1b[0m\x1b[?2004h\x1b[?25l\x1b[2;5H");
  });

  it("draws an alternate screen without scrollback", () => {
    const paint = firstPaint([b("a"), b("b")], state({ alternate: true, cursorKeys: true, mouseButton: true, mouseSgr: true }));
    expect(paint.toString("latin1")).toBe("\x1bc\x1b[0m\x1b[?1049h\x1b[Ha\r\nb\x1b[0m\x1b[?1h\x1b[?1002h\x1b[?1006h\x1b[2;5H");
  });
});

describe("typed bytes", () => {
  it("become send-keys -H commands, split into short ones", () => {
    expect(sendBytesCommands("=gr-a:", Buffer.from("\x1b[Z"))).toEqual(["send-keys -t =gr-a: -H 1b 5b 5a"]);
    expect(sendBytesCommands("=gr-a:", Buffer.alloc(300, 0x61))).toHaveLength(2);
  });

  it("know an interrupt", () => {
    expect(isInterrupt(Buffer.from([0x1b]))).toBe(true);
    expect(isInterrupt(Buffer.from([0x03]))).toBe(true);
    expect(isInterrupt(Buffer.from("\x1b[A"))).toBe(false);
  });
});
