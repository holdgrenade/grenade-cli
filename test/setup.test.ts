import { describe, expect, it } from "vitest";
import { readYesNo } from "../src/setup/answer.js";
import { pushNotice } from "../src/setup/pushNotice.js";
import { nextSteps } from "../src/setup/nextSteps.js";
import { firewallNotice, ufwEnabledIn, ufwIsOn } from "../src/setup/firewall.js";
import { problems, tmuxFix, tmuxVersion, type Found } from "../src/setup/requirements.js";

const fine: Found = { platform: "darwin", node: "22.4.0", tmux: "tmux 3.5a\n", packages: "brew", claude: true, codex: false, iterm: true };

describe("problems", () => {
  it("finds none on a Mac that has everything", () => {
    expect(problems(fine)).toEqual([]);
  });

  it("offers Homebrew for a missing or old tmux", () => {
    expect(problems({ ...fine, tmux: null })).toMatchObject([{ what: "tmux", blocks: true, fix: "brew install tmux" }]);
    expect(problems({ ...fine, tmux: "tmux 3.1c" })).toMatchObject([{ what: "tmux", blocks: true, fix: "brew upgrade tmux" }]);
    expect(problems({ ...fine, tmux: "tmux 3.2" })).toEqual([]);
    expect(problems({ ...fine, tmux: "tmux next-3.6" })).toEqual([]);
  });

  it("has no fix to offer without Homebrew", () => {
    const [p] = problems({ ...fine, tmux: null, packages: null });
    expect(p?.fix).toBeUndefined();
    expect(p?.blocks).toBe(true);
  });

  it("stops on an old Node and on a system it does not run on", () => {
    expect(problems({ ...fine, node: "20.11.1" })).toMatchObject([{ what: "node", blocks: true }]);
    expect(problems({ ...fine, platform: "win32" })).toMatchObject([{ what: "platform", blocks: true }]);
  });

  it("runs on Linux, and installs tmux there with the distribution's own tool", () => {
    const linux: Found = { ...fine, platform: "linux", packages: "pacman", iterm: false };
    expect(problems(linux)).toEqual([]);
    expect(problems({ ...linux, tmux: null })).toMatchObject([{ what: "tmux", blocks: true, fix: "sudo pacman -S --needed tmux" }]);
    expect(tmuxFix("apt-get", false)).toBe("sudo apt-get install tmux");
    expect(tmuxFix("dnf", true)).toBe("sudo dnf install tmux");
    // No Homebrew on Linux to bring Node up to date with: the message stands alone.
    expect(problems({ ...linux, node: "20.11.1" })[0]?.fix).toBeUndefined();
  });

  it("never asks for iTerm2", () => {
    expect(problems({ ...fine, iterm: false })).toEqual([]);
  });

  it("only warns when no agent is installed yet", () => {
    expect(problems({ ...fine, claude: false })).toMatchObject([{ what: "agent", blocks: false }]);
    expect(problems({ ...fine, claude: false, codex: true })).toEqual([]);
  });
});

describe("nextSteps", () => {
  it("points at the apps and says how to open sessions in a terminal too", () => {
    expect(nextSteps(true)[0]).toContain("grenade new myproject");
    expect(nextSteps(true).join("\n")).toContain("Grenade Mac app");
    expect(nextSteps(true).join("\n")).toContain("grenade terminal iterm");
    expect(nextSteps(false).join("\n")).toContain("grenade terminal terminal");
  });

  it("names no Mac app and no Mac terminal on Linux", () => {
    const lines = nextSteps(false, "linux").join("\n");
    expect(lines).toContain("grenade new myproject");
    expect(lines).toContain("grenade open myproject");
    expect(lines).not.toContain("Mac");
    expect(lines).not.toContain("grenade terminal");
  });
});

describe("firewall", () => {
  it("reads whether ufw starts with the system", () => {
    expect(ufwEnabledIn("# /etc/ufw/ufw.conf\nENABLED=yes\nLOGLEVEL=low\n")).toBe(true);
    expect(ufwEnabledIn("ENABLED=no\n")).toBe(false);
    expect(ufwEnabledIn("#ENABLED=yes\n")).toBe(false);
  });

  it("is never on where there is no ufw: a Mac, or a Linux without its file", () => {
    expect(ufwIsOn("darwin")).toBe(false);
    expect(ufwIsOn("linux", "/nonexistent/ufw.conf")).toBe(false);
  });

  it("says what opens the port, and that a relay needs nothing", () => {
    const lines = firewallNotice(7788).join("\n");
    expect(lines).toContain("sudo ufw allow 7788/tcp");
    expect(lines).toContain("relay");
  });
});

describe("tmuxVersion", () => {
  it("reads what `tmux -V` prints", () => {
    expect(tmuxVersion("tmux 3.7c")).toEqual([3, 7]);
    expect(tmuxVersion("tmux master")).toBeNull();
  });
});

describe("readYesNo", () => {
  it("takes the default for an empty answer", () => {
    expect(readYesNo("", true)).toBe(true);
    expect(readYesNo("  \n", false)).toBe(false);
  });

  it("reads yes and no in any case, and nothing else", () => {
    expect(readYesNo("Y", false)).toBe(true);
    expect(readYesNo("yes", false)).toBe(true);
    expect(readYesNo(" No ", true)).toBe(false);
    expect(readYesNo("maybe", true)).toBeNull();
  });
});

describe("the push notice", () => {
  it("names the relay the Mac posts to, what that relay learns, and how to turn it off", () => {
    const text = pushNotice({ enabled: true, gateway: "https://relay.example.com" }).join("\n");
    expect(text).toContain("https://relay.example.com");
    expect(text).toContain("public IP address");
    expect(text).toContain("grenade push off");
  });

  it("says that push follows remote access when nobody chose", () => {
    const on = pushNotice({ enabled: true, mode: "auto", gateway: "https://relay.example.com" }).join("\n");
    expect(on).toContain("grenade relay off");
    const off = pushNotice({ enabled: false, mode: "auto" }).join("\n");
    expect(off).toContain("remote access is off");
    expect(off).toContain("talks to no relay");
    expect(off).toContain("grenade push on");
    expect(off).toContain("public IP address");
  });

  it("says how to turn them on when they are off", () => {
    expect(pushNotice({ enabled: false })).toEqual(["Push notifications are off. Turn them on with: grenade push on"]);
  });
});
