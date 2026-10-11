import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { shellLaunch, shellPromptFiles, writeShellPrompt } from "../src/platform/shellPrompt.js";
import { agentCommand } from "../src/tmux/parse.js";

const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

describe("shell prompt", () => {
  it("starts zsh from Grenade's ZDOTDIR, bash with its rc file, and any other shell as it is", () => {
    expect(shellLaunch("/bin/zsh", "/h/shell")).toBe("ZDOTDIR='/h/shell/zsh' '/bin/zsh'");
    expect(shellLaunch("/bin/zsh", "/h/shell", "/u/zdot")).toBe("ZDOTDIR='/h/shell/zsh' GRENADE_USER_ZDOTDIR='/u/zdot' '/bin/zsh'");
    expect(shellLaunch("/opt/homebrew/bin/bash", "/h/shell")).toBe("'/opt/homebrew/bin/bash' --rcfile '/h/shell/bash/rc'");
    expect(shellLaunch("/opt/homebrew/bin/fish", "/h/shell")).toBe("/opt/homebrew/bin/fish");
  });

  it("is how a shell session starts when the daemon gives it", () => {
    expect(agentCommand("shell", "/bin/zsh", undefined, { shell: (s) => shellLaunch(s, "/h") })).toBe("ZDOTDIR='/h/zsh' '/bin/zsh'");
    expect(agentCommand("shell", "/bin/zsh")).toBe("/bin/zsh");
  });

  it("writes its files once, readable by this user alone, and puts back a file changed by hand", () => {
    const dir = mkdtempSync(join(tmpdir(), "grenade-prompt-"));
    writeShellPrompt(dir);
    for (const [path, content] of Object.entries(shellPromptFiles())) {
      expect(readFileSync(join(dir, path), "utf8")).toBe(content);
      expect(statSync(join(dir, path)).mode & 0o777).toBe(0o600);
    }
    writeFileSync(join(dir, "zsh/prompt.zsh"), "edited");
    writeShellPrompt(dir);
    expect(readFileSync(join(dir, "zsh/prompt.zsh"), "utf8")).toBe(shellPromptFiles()["zsh/prompt.zsh"]);
  });

  it("keeps a shell's `${` in the scripts", () => {
    expect(shellPromptFiles()["zsh/prompt.zsh"]).toContain("${GRENADE_PROMPT:-on}");
    expect(shellPromptFiles()["bash/rc"]).toContain("${GRENADE_PROMPT:-on}");
  });

  describe.runIf(existsSync("/bin/zsh"))("in zsh", () => {
    const run = (script: string, zshrc?: string) => {
      const home = mkdtempSync(join(tmpdir(), "grenade-home-"));
      if (zshrc !== undefined) writeFileSync(join(home, ".zshrc"), zshrc);
      const dir = join(home, ".grenade", "shell");
      writeShellPrompt(dir);
      const out = execFileSync("/bin/zsh", ["-i", "-c", script], {
        cwd: home,
        env: { PATH: process.env["PATH"], HOME: home, ZDOTDIR: join(dir, "zsh"), COLUMNS: "60", TERM: "xterm-256color" },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      return { out: plain(out), home };
    };

    it("draws two lines: the folder at the left and the time at the right, then the arrow", () => {
      const { out } = run(`_grenade_precmd; print -rP -- "$PROMPT"`);
      const [top, arrow] = out.split("\n");
      expect(top).toMatch(/^grenade-home-\w+ +\d\d:\d\d$/);
      expect(top).toHaveLength(59);
      expect(arrow).toBe("❯ ");
    });

    it("says a command failed, with its status", () => {
      const { out } = run(`_grenade_ran=false; false; _grenade_precmd; print -rP -- "$PROMPT"`);
      expect(out.split("\n")[1]).toMatch(/✕ 1 · \d\d:\d\d$/);
    });

    it("runs the user's .zshrc first, and keeps their history file", () => {
      const { out, home } = run(`print -r -- "$GREETING|$HISTFILE|$ZDOTDIR"`, "GREETING=hello\n");
      expect(out.trim()).toBe(`hello|${home}/.zsh_history|${home}`);
    });

    it("leaves a prompt of the user's own alone, and stays off when told", () => {
      expect(run(`print -r -- "$PROMPT"`, "PROMPT='mine> '\n").out.trim()).toBe("mine>");
      expect(run(`print -r -- "$+functions[_grenade_precmd]"`, "GRENADE_PROMPT=off\n").out.trim()).toBe("0");
    });
  });
});
