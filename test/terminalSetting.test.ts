import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { terminalLines } from "../src/cli/terminalCommand.js";
import { parseTerminalSetting, readTerminalSetting, writeTerminalSetting } from "../src/terminal/terminalSetting.js";

describe("terminal setting", () => {
  it("is none when missing, unreadable or unknown", () => {
    expect(parseTerminalSetting(null)).toBe("none");
    expect(parseTerminalSetting("not json")).toBe("none");
    expect(parseTerminalSetting('{"terminal":"kitty"}')).toBe("none");
    expect(parseTerminalSetting('{"terminal":"iterm"}')).toBe("iterm");
  });

  it("reads back what it wrote", () => {
    const file = join(mkdtempSync(join(tmpdir(), "gr-term-")), "terminal.json");
    expect(readTerminalSetting(file)).toBe("none");
    writeTerminalSetting("terminal", file);
    expect(readTerminalSetting(file)).toBe("terminal");
    writeFileSync(file, "{");
    expect(readTerminalSetting(file)).toBe("none");
  });
});

describe("terminalLines", () => {
  it("says how to turn it on while off, and off while on", () => {
    expect(terminalLines("none", { terminal: "none", using: null, pinned: false }).join("\n")).toContain("grenade terminal iterm");
    const on = terminalLines("iterm", { terminal: "iterm", using: "iTerm2", pinned: false }).join("\n");
    expect(on).toContain("Sessions open in iTerm2");
    expect(on).toContain("grenade terminal none");
  });

  it("warns when the daemon was started with a terminal that overrides the setting", () => {
    expect(terminalLines("iterm", { terminal: "none", using: null, pinned: true }).join("\n")).toContain("grenaded ignores this");
  });

  it("says on Linux that no window opens, and how to clear a setting left over", () => {
    const off = terminalLines("none", null, "linux").join("\n");
    expect(off).toContain("grenade open <name>");
    expect(off).not.toContain("grenade terminal iterm");
    expect(terminalLines("iterm", { terminal: "iterm", using: null, pinned: false }, "linux").join("\n")).toContain("grenade terminal none");
  });

  it("says when the daemon is not there to ask", () => {
    expect(terminalLines("iterm", null).join("\n")).toContain("takes effect when it starts");
  });
});
