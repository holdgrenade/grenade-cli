import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { shellLaunch, shellPromptFiles, trimShellHistory, writeShellPrompt } from "../src/platform/shellPrompt.js";
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

  describe("command history", () => {
    // An interactive shell in a home with a folder `sub`, running `commands` as if each were typed at a prompt:
    // zsh's hooks are called around each as zsh calls them, and bash's PROMPT_COMMAND after each is put in its
    // history (`history -s`), as a typed line is.
    const session = (shell: string, commands: string[], rc = "") => {
      const home = realpathSync(mkdtempSync(join(tmpdir(), "grenade-history-")));
      const zsh = shell.endsWith("zsh");
      mkdirSync(join(home, "sub"));
      writeFileSync(join(home, zsh ? ".zshrc" : ".bashrc"), rc);
      const dir = join(home, ".grenade", "shell");
      writeShellPrompt(dir);
      const q = (c: string) => `'${c.replace(/'/g, `'\\''`)}'`;
      const script = zsh
        ? commands.map((c) => `(( $+functions[_grenade_history_preexec] )) && _grenade_history_preexec ${q(c)}; eval ${q(c)}; for f in $precmd_functions; do $f; done`).join("\n")
        : ["eval \"$PROMPT_COMMAND\""].concat(commands.map((c) => `history -s ${q(c)}; eval ${q(c)}; eval "$PROMPT_COMMAND"`)).join("\n");
      const args = zsh ? ["-i", "-c", script] : ["--rcfile", join(dir, "bash", "rc"), "-i", "-c", script];
      execFileSync(shell, args, {
        cwd: home,
        env: { PATH: process.env["PATH"], HOME: home, ZDOTDIR: join(dir, "zsh"), TERM: "dumb", HISTFILE: join(home, ".history") },
        stdio: ["ignore", "ignore", "ignore"],
      });
      const file = join(dir, "history.tsv");
      const lines = existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean) : [];
      return { home, rows: lines.map((line) => line.split("\t")) };
    };

    for (const shell of ["/bin/zsh", "/bin/bash"]) {
      const name = shell.split("/").pop() ?? shell;
      describe.runIf(existsSync(shell))(`in ${name}`, () => {
        it("keeps each command with its number, status, folder before and after, and the line", () => {
          const { home, rows } = session(shell, ["echo one", "cd sub", "false", 'echo "a\\b\tc" > /dev/null', " echo secret"]);
          expect(rows.map((r) => r.slice(2))).toEqual([
            ["1", "0", home, home, "echo one"],
            ["2", "0", home, join(home, "sub"), "cd sub"],
            ["3", "1", join(home, "sub"), join(home, "sub"), "false"],
            ["4", "0", join(home, "sub"), join(home, "sub"), String.raw`echo "a\\b c" > /dev/null`],
          ]);
          expect(new Set(rows.map((r) => r[1])).size).toBe(1);
          expect(Math.abs(Number(rows[0]?.[0]) - Date.now() / 1000)).toBeLessThan(60);
          // The status goes on to Grenade's prompt, which runs after.
          expect(rows[2]?.[3]).toBe("1");
          expect(statSync(join(home, ".grenade", "shell", "history.tsv")).mode & 0o777).toBe(0o600);
        });

        it("keeps nothing when turned off, and with a prompt of the user's own still keeps it", () => {
          expect(session(shell, ["echo one"], "GRENADE_HISTORY=off\n").rows).toEqual([]);
          const own = shell.endsWith("zsh") ? "PROMPT='mine> '\n" : "PS1='mine> '\n";
          expect(session(shell, ["echo one"], own).rows.map((r) => r[6])).toEqual(["echo one"]);
        });
      });
    }

    it("hands the status on to Grenade's prompt", () => {
      if (!existsSync("/bin/zsh")) return;
      const fns = execFileSync("/bin/zsh", ["-i", "-c", `print -r -- "$precmd_functions"`], {
        env: { PATH: process.env["PATH"], HOME: mkdtempSync(join(tmpdir(), "grenade-home-")), ZDOTDIR: (() => {
          const dir = mkdtempSync(join(tmpdir(), "grenade-shell-"));
          writeShellPrompt(dir);
          return join(dir, "zsh");
        })() },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      expect(fns.trim().split(" ").slice(0, 2)).toEqual(["_grenade_history_precmd", "_grenade_precmd"]);
    });

    it("is cut back to its last part, from a whole line, once it grows past its limit", () => {
      const file = join(mkdtempSync(join(tmpdir(), "grenade-trim-")), "history.tsv");
      writeFileSync(file, Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n") + "\n");
      trimShellHistory(file, 10_000, 50);
      expect(readFileSync(file, "utf8")).toContain("line 0\n");
      trimShellHistory(file, 100, 50);
      const kept = readFileSync(file, "utf8");
      expect(kept.length).toBeLessThanOrEqual(50);
      expect(kept.endsWith("line 99\n")).toBe(true);
      expect(kept.split("\n")[0]).toMatch(/^line \d+$/);
    });
  });
});
