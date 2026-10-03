import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { computerWord, daemonOs, systemName } from "../src/platform/computer.js";
import { findOnPath } from "../src/platform/findOnPath.js";
import { loginShell } from "../src/platform/loginShell.js";

describe("findOnPath", () => {
  it("takes the first folder of PATH that holds the command", () => {
    const has = new Set(["/usr/bin/tmux", "/opt/bin/tmux"]);
    expect(findOnPath("tmux", "/home/adam/bin:/opt/bin:/usr/bin", (f) => has.has(f))).toBe("/opt/bin/tmux");
    expect(findOnPath("codex", "/opt/bin:/usr/bin", (f) => has.has(f))).toBeNull();
  });

  it("skips empty and relative entries, and finds nothing on an empty PATH", () => {
    expect(findOnPath("tmux", "::bin:/usr/bin", (f) => f === "/usr/bin/tmux" || f === "bin/tmux")).toBe("/usr/bin/tmux");
    expect(findOnPath("tmux", "", () => true)).toBeNull();
  });

  it("counts only a file that may be run", () => {
    const dir = mkdtempSync(join(tmpdir(), "grenade-path-"));
    try {
      writeFileSync(join(dir, "plain"), "");
      chmodSync(join(dir, "plain"), 0o644);
      writeFileSync(join(dir, "tool"), "#!/bin/sh\n");
      chmodSync(join(dir, "tool"), 0o755);
      mkdirSync(join(dir, "folder"));
      expect(findOnPath("tool", dir)).toBe(join(dir, "tool"));
      expect(findOnPath("plain", dir)).toBeNull();
      expect(findOnPath("folder", dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("loginShell", () => {
  it("is $SHELL, else the user's own shell, else the system's usual one", () => {
    expect(loginShell({ SHELL: "/usr/bin/fish" }, () => "/bin/bash", "linux")).toBe("/usr/bin/fish");
    expect(loginShell({}, () => "/bin/bash", "linux")).toBe("/bin/bash");
    // zsh is the Mac's shell; most Linux systems do not have it.
    expect(loginShell({}, () => null, "linux")).toBe("/bin/sh");
    expect(loginShell({}, () => null, "darwin")).toBe("/bin/zsh");
    expect(loginShell({ SHELL: "" }, () => "", "linux")).toBe("/bin/sh");
  });
});

describe("what the machine is called", () => {
  it("is a Mac on macOS and a computer elsewhere", () => {
    expect(computerWord("darwin")).toBe("Mac");
    expect(computerWord("linux")).toBe("computer");
    // What the apps choose their word from (PROTOCOL.md `os`).
    expect(daemonOs("darwin")).toBe("macos");
    expect(daemonOs("linux")).toBe("linux");
    expect(daemonOs("freebsd")).toBe("freebsd");
    expect(systemName("darwin")).toBe("macOS");
    expect(systemName("linux")).toBe("Linux");
  });
});
