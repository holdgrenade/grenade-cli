import { describe, expect, it } from "vitest";
import { readYesNo } from "../src/setup/answer.js";
import { pushNotice } from "../src/setup/pushNotice.js";
import { nextSteps } from "../src/setup/nextSteps.js";
import { problems, tmuxVersion, type Found } from "../src/setup/requirements.js";

const fine: Found = { platform: "darwin", node: "22.4.0", tmux: "tmux 3.5a\n", brew: true, claude: true, codex: false, iterm: true };

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
    const [p] = problems({ ...fine, tmux: null, brew: false });
    expect(p?.fix).toBeUndefined();
    expect(p?.blocks).toBe(true);
  });

  it("stops on an old Node and on another system", () => {
    expect(problems({ ...fine, node: "20.11.1" })).toMatchObject([{ what: "node", blocks: true }]);
    expect(problems({ ...fine, platform: "linux" })).toMatchObject([{ what: "platform", blocks: true }]);
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
