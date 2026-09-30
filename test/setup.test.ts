import { describe, expect, it } from "vitest";
import { mergeHooks } from "../src/hooks/installHooks.js";
import { readYesNo } from "../src/setup/answer.js";
import { addedHooks, hooksNotice } from "../src/setup/hooksNotice.js";
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

  it("offers iTerm2 without stopping", () => {
    expect(problems({ ...fine, iterm: false })).toMatchObject([{ what: "iterm", blocks: false, fix: "brew install --cask iterm2" }]);
    expect(problems({ ...fine, iterm: false, brew: false })[0]?.fix).toBeUndefined();
  });

  it("only warns when no agent is installed yet", () => {
    expect(problems({ ...fine, claude: false })).toMatchObject([{ what: "agent", blocks: false }]);
    expect(problems({ ...fine, claude: false, codex: true })).toEqual([]);
  });
});

describe("nextSteps", () => {
  it("says where the agent shows up, with and without iTerm2", () => {
    expect(nextSteps(true).join("\n")).toContain("tab of its own in iTerm2");
    expect(nextSteps(false).join("\n")).toContain("brew install --cask iterm2");
    expect(nextSteps(false)[0]).toContain("grenade new myproject");
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

describe("the hooks notice", () => {
  const mine = { hooks: { Stop: [{ matcher: "", hooks: [{ type: "command", command: "say done" }] }] }, model: "opus" };

  it("lists every hook the merge would add, and none that are there already", () => {
    const { settings } = mergeHooks(mine, 7788);
    const added = addedHooks(mine, settings);
    expect(added.length).toBeGreaterThanOrEqual(6);
    expect(added.map((h) => h.event)).toContain("Stop");
    expect(added.map((h) => h.runs)).not.toContain("say done");
    for (const h of added) expect(h.runs).toContain("127.0.0.1:7788");
    expect(addedHooks(settings, mergeHooks(settings, 7788).settings)).toEqual([]);
  });

  it("names the file, the events and what runs, and how to undo it", () => {
    const { settings } = mergeHooks({}, 7788);
    const added = addedHooks({}, settings);
    const text = hooksNotice("/Users/adam/.claude/settings.json", added).join("\n");
    expect(text).toContain(`${added.length} hooks to /Users/adam/.claude/settings.json`);
    for (const h of added) {
      expect(text).toContain(h.event);
      expect(text).toContain(h.runs);
    }
    expect(text).toContain("grenade install-hooks --remove");
  });

  it("lists an http hook by its URL", () => {
    const after = { hooks: { PermissionRequest: [{ hooks: [{ type: "http", url: "http://127.0.0.1:7788/hooks/claude/prompt" }] }] } };
    expect(addedHooks({}, after)).toEqual([{ event: "PermissionRequest", runs: "http://127.0.0.1:7788/hooks/claude/prompt" }]);
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
