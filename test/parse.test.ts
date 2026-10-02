import { describe, expect, it } from "vitest";
import {
  agentCommand,
  buildHistory,
  buildScreen,
  historyRange,
  splitGeometry,
  stripAnsi,
  expandCwd,
  keyToTmux,
  lastNonEmptyLine,
  parsePaneGeometry,
  parseSessionList,
  sessionIdFor,
  slugify,
  tmuxEnv,
  trimTrailingEmpty,
  type PaneGeometry,
} from "../src/tmux/parse.js";

const geo = (g: Pick<PaneGeometry, "cursor" | "cols" | "rows"> & Partial<PaneGeometry>): PaneGeometry => ({
  historySize: 0,
  alternate: false,
  ...g,
});

describe("parseSessionList", () => {
  it("splits names and ignores blanks", () => {
    expect(parseSessionList("gr-a\n\ngr-b\nother\n")).toEqual(["gr-a", "gr-b", "other"]);
    expect(parseSessionList("")).toEqual([]);
  });
});

describe("parsePaneGeometry", () => {
  it("reads y x w h, history size and alternate screen", () => {
    expect(parsePaneGeometry("5 12 120 40 1800 0\n")).toEqual({
      cursor: { row: 5, col: 12 }, cols: 120, rows: 40, historySize: 1800, alternate: false,
    });
    expect(parsePaneGeometry("0 0 46 30 0 1").alternate).toBe(true);
  });
  it("splits the geometry line off a combined display + capture output", () => {
    const { geo, dump } = splitGeometry("1 2 46 3 10 0\nh1\nv1\nv2\nv3\n");
    expect(geo.historySize).toBe(10);
    expect(dump).toBe("h1\nv1\nv2\nv3\n");
  });
  it("throws on garbage", () => {
    expect(() => parsePaneGeometry("nope")).toThrow();
  });
});

describe("buildScreen", () => {
  it("drops trailing blank lines and re-bases the cursor onto the visible pane", () => {
    // 3 history lines + a 4-row pane whose cursor is on its 2nd row
    const dump = "h1\nh2\nh3\nv1   \nv2\n\n\n";
    const screen = buildScreen(dump, geo({ cursor: { row: 1, col: 3 }, cols: 80, rows: 4 }));
    expect(screen.lines).toEqual(["h1", "h2", "h3", "v1", "v2"]);
    expect(screen.cursor).toEqual({ row: 4, col: 3 });
    expect(screen.cols).toBe(80);
  });
  it("clamps the cursor when the pane is mostly empty", () => {
    const screen = buildScreen("$ \n\n\n", geo({ cursor: { row: 0, col: 2 }, cols: 80, rows: 3 }));
    expect(screen.lines).toEqual(["$"]);
    expect(screen.cursor.row).toBe(0);
  });
  it("keeps colors in styled and plain text in lines, row for row", () => {
    const dump = "\x1b[38;2;215;119;87m›\x1b[39m hi  \n\x1b[1mbold\x1b[0m\n\x1b[0m   \n\n";
    const screen = buildScreen(dump, geo({ cursor: { row: 0, col: 0 }, cols: 80, rows: 4 }));
    expect(screen.lines).toEqual(["› hi", "bold"]);
    expect(screen.styled).toEqual(["\x1b[38;2;215;119;87m›\x1b[39m hi", "\x1b[1mbold\x1b[0m"]);
  });
});

describe("buildScreen history index", () => {
  it("numbers the first row from the pane's history size", () => {
    // 1000 rows of history; the capture holds the newest 3 of them above a 2-row pane
    const screen = buildScreen("h997\nh998\nh999\nv1\nv2\n", geo({ cursor: { row: 0, col: 0 }, cols: 40, rows: 2, historySize: 1000 }));
    expect(screen.start).toBe(997);
  });
  it("starts at 0 when the whole history fits in the capture", () => {
    expect(buildScreen("h0\nv1\n", geo({ cursor: { row: 0, col: 0 }, cols: 40, rows: 1, historySize: 1 })).start).toBe(0);
  });
});

describe("history rows", () => {
  it("maps a history request to capture-pane offsets", () => {
    expect(historyRange(900, 500, 1000)).toEqual({ start: 400, from: -600, to: -101 });
    expect(historyRange(300, 500, 1000)).toEqual({ start: 0, from: -1000, to: -701 });
    expect(historyRange(0, 500, 1000)).toBeNull();
  });
  it("never reaches into the visible pane", () => {
    expect(historyRange(5000, 10, 1000)).toEqual({ start: 990, from: -10, to: -1 });
  });
  it("keeps blank rows so indexes stay contiguous", () => {
    const rows = buildHistory("\x1b[31ma\x1b[39m  \n\nb\n", 40);
    expect(rows).toEqual({ start: 40, lines: ["a", "", "b"], styled: ["\x1b[31ma\x1b[39m", "", "b"] });
  });
});

describe("stripAnsi", () => {
  it("removes SGR, other CSI, and OSC 8 hyperlinks", () => {
    expect(stripAnsi("\x1b[31;1mred\x1b[0m")).toBe("red");
    expect(stripAnsi("a\x1b[2Kb")).toBe("ab");
    expect(stripAnsi("\x1b]8;;https://x.dev\x1b\\link\x1b]8;;\x1b\\")).toBe("link");
    expect(stripAnsi("\x1b]8;;https://x.dev\x07link\x1b]8;;\x07")).toBe("link");
  });
});

describe("helpers", () => {
  it("trimTrailingEmpty / lastNonEmptyLine", () => {
    expect(trimTrailingEmpty(["a", "", " ", ""])).toEqual(["a"]);
    expect(lastNonEmptyLine(["a", "b  ", "", ""])).toBe("b");
    expect(lastNonEmptyLine([])).toBe("");
    expect(lastNonEmptyLine(["x".repeat(300)])).toHaveLength(200);
  });
  it("slugify and sessionIdFor", () => {
    expect(slugify("My Project!")).toBe("my-project");
    expect(slugify("  ")).toBe("session");
    expect(sessionIdFor("Deploy Scripts")).toBe("gr-deploy-scripts");
  });
  it("keyToTmux covers every key", () => {
    expect(keyToTmux("enter")).toBe("Enter");
    expect(keyToTmux("ctrl-c")).toBe("C-c");
    expect(keyToTmux("backspace")).toBe("BSpace");
  });
  it("agentCommand", () => {
    expect(agentCommand("claude")).toBe("claude");
    expect(agentCommand("codex")).toBe("codex");
    expect(agentCommand("shell", "/bin/fish")).toBe("/bin/fish");
  });
});

describe("tmuxEnv", () => {
  it("drops the pane of a daemon started inside tmux, so untargeted commands cannot land on it", () => {
    const env = tmuxEnv({ PATH: "/bin", TMUX: "/tmp/tmux-501/default,1,0", TMUX_PANE: "%44" });
    expect(env).toEqual({ PATH: "/bin", TMUX: "" });
    expect("TMUX_PANE" in env).toBe(false);
  });
});

describe("expandCwd", () => {
  const home = "/Users/me";
  it("expands a leading ~", () => {
    expect(expandCwd("~", home)).toBe("/Users/me");
    expect(expandCwd("~/code/app", home)).toBe("/Users/me/code/app");
  });
  it("keeps absolute paths, trimming spaces, double and trailing slashes", () => {
    expect(expandCwd("  /tmp//work/  ", home)).toBe("/tmp/work");
    expect(expandCwd("/", home)).toBe("/");
  });
  it("rejects relative paths and ~user", () => {
    expect(expandCwd("code/app", home)).toBeNull();
    expect(expandCwd("~bob/x", home)).toBeNull();
    expect(expandCwd("", home)).toBeNull();
  });
});
