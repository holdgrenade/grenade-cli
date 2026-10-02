import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { silentLogger } from "../src/log.js";
import { formula } from "../packaging/homebrew/formula.mjs";
import { parseAuto } from "../src/update/autoSetting.js";
import { installedVersion } from "../src/update/installedVersion.js";
import { installError } from "../src/update/installer.js";
import { underLaunchd } from "../src/update/underLaunchd.js";
import { UpdateChecker } from "../src/update/updateChecker.js";
import {
  compareVersions,
  installMethodOf,
  isBusy,
  isNewer,
  latestFromFormula,
  restartDecision,
  installCommands,
  installerFor,
  latestFromNpm,
  updateLine,
  updateNotice,
} from "../src/update/versions.js";

describe("versions", () => {
  it("compares major, minor and patch as numbers", () => {
    expect(isNewer("0.1.10", "0.1.9")).toBe(true);
    expect(isNewer("0.2.0", "0.1.99")).toBe(true);
    expect(isNewer("0.1.9", "0.1.9")).toBe(false);
    expect(isNewer("0.1.8", "0.1.9")).toBe(false);
    expect(compareVersions("v1.0.0", "1.0.0")).toBe(0);
  });

  it("counts a prerelease as older than its release", () => {
    expect(isNewer("1.0.0", "1.0.0-beta.1")).toBe(true);
    expect(isNewer("1.0.0-beta.2", "1.0.0-beta.1")).toBe(true);
  });

  it("reads the version from the formula the release writes", () => {
    const text = formula({ version: "0.1.12", sha256: "ab".repeat(32), tarball: "holdgrenade-cli-0.1.12.tgz" });
    expect(latestFromFormula(text)).toBe("0.1.12");
    expect(latestFromFormula("class Grenade < Formula\nend\n")).toBeNull();
  });

  it("tells Homebrew, npm and source installs apart by the real path", () => {
    expect(installMethodOf("/opt/homebrew/Cellar/grenade/0.1.9/libexec/lib/node_modules/@holdgrenade/cli/dist/cli.js")).toBe("brew");
    expect(installMethodOf("/usr/local/lib/node_modules/@holdgrenade/cli/dist/cli.js")).toBe("npm");
    expect(installMethodOf("/Users/adam/workspace/grenade/grenade-cli/dist/cli.js")).toBe("source");
  });

  it("finds the installer with absolute paths, since launchd's PATH has neither brew nor npm", () => {
    const brew = installerFor("/opt/homebrew/Cellar/grenade/0.1.9/libexec/lib/node_modules/@holdgrenade/cli/dist/cli.js", "/opt/homebrew/bin/node");
    expect(brew).toEqual({ method: "brew", brew: "/opt/homebrew/bin/brew" });
    expect(installCommands(brew!, "")).toEqual([["/opt/homebrew/bin/brew", "update", "--quiet"], ["/opt/homebrew/bin/brew", "upgrade", "grenade"]]);
    expect(installerFor("/usr/local/Cellar/grenade/0.1.9/libexec/dist/cli.js", "/usr/local/bin/node")).toEqual({ method: "brew", brew: "/usr/local/bin/brew" });

    const nvm = installerFor("/Users/a/.nvm/versions/node/v22.1.0/lib/node_modules/@holdgrenade/cli/dist/cli.js", "/Users/a/.nvm/versions/node/v22.1.0/bin/node");
    expect(nvm).toEqual({
      method: "npm",
      npm: ["/Users/a/.nvm/versions/node/v22.1.0/bin/npm", "/Users/a/.nvm/versions/node/v22.1.0/bin/npm"],
      writes: ["/Users/a/.nvm/versions/node/v22.1.0/lib/node_modules", "/Users/a/.nvm/versions/node/v22.1.0/bin"],
    });
    expect(installCommands(nvm!, "/x/npm")).toEqual([["/x/npm", "install", "-g", "@holdgrenade/cli@latest"]]);
    expect(installerFor("/Users/adam/workspace/grenade/grenade-cli/dist/cli.js", "/opt/homebrew/bin/node")).toBeNull();
  });

  it("reads npm's latest", () => {
    expect(latestFromNpm(JSON.stringify({ name: "@holdgrenade/cli", version: "1.0.5" }))).toBe("1.0.5");
    expect(latestFromNpm("{}")).toBeNull();
    expect(latestFromNpm("<html>")).toBeNull();
  });

  it("installs by itself unless turned off", () => {
    expect(parseAuto(null)).toBe(true);
    expect(parseAuto('{"auto":true}')).toBe(true);
    expect(parseAuto('{"auto":false}')).toBe(false);
    expect(parseAuto("not json")).toBe(true);
  });

  it("says in a few words why an install failed", () => {
    const brew = ["/opt/homebrew/bin/brew", "upgrade", "grenade"];
    expect(installError(brew, "Error: Another active Homebrew update process is already in progress.")).toBe("Homebrew was busy");
    expect(installError(brew, "curl: (6) Could not resolve host: github.com")).toBe("Homebrew could not reach the internet");
    expect(installError(["/usr/local/bin/npm", "install"], "npm error code EACCES")).toBe("npm was not allowed to write its folder");
    expect(installError(brew, "timed out")).toBe("Homebrew took too long");
    expect(installError(brew, "Warning: x\nError: grenade 1.0.5 is already installed\n")).toBe("Homebrew: grenade 1.0.5 is already installed");
    expect(installError(brew, "")).toBe("Homebrew failed");
  });

  it("says a new version is out, or that one is installed and waits to run", () => {
    expect(updateNotice("0.1.9", { installed: "0.1.9", latest: "0.1.10" })).toBe("A new version of Grenade is out: 0.1.9 → 0.1.10. Update with: grenade update");
    expect(updateNotice("0.1.9", { installed: "0.1.10", latest: "0.1.10" })).toMatch(/^Grenade 0.1.10 is installed; grenaded 0.1.9 restarts into it/);
    expect(updateNotice("0.1.9", { installed: "0.1.10", restarts: false })).toBe("Grenade 0.1.10 is installed, but grenaded 0.1.9 was started by hand: stop it and start it again to run it");
    expect(updateNotice("0.1.10", { installed: "0.1.10", latest: "0.1.10" })).toBeNull();
    expect(updateNotice("0.1.10", { installed: "0.1.10", latest: "0.1.9" })).toBeNull();
    expect(updateNotice("0.1.9", {})).toBeNull();
  });

  it("writes the status line", () => {
    const now = Date.parse("2026-09-30T12:00:00Z");
    expect(updateLine("0.1.9", { latest: "0.1.10", checkedAt: "2026-09-30T11:00:00Z" }, now)).toBe("0.1.10 available (running 0.1.9). Install it with: grenade update");
    expect(updateLine("0.1.10", { installed: "0.1.10", latest: "0.1.10", checkedAt: "2026-09-30T10:00:00Z" }, now)).toBe("up to date (checked 2 h ago)");
    expect(updateLine("0.1.10", { error: "the tap answered HTTP 503", checkedAt: "2026-09-30T11:59:00Z" }, now)).toBe("could not check for a new version: the tap answered HTTP 503");
    expect(updateLine("0.1.10", {}, now)).toBe("not checked yet");
    expect(updateLine("0.1.9", { latest: "0.1.10", install: { state: "installing", version: "0.1.10" } }, now)).toBe("installing 0.1.10…");
    expect(updateLine("0.1.9", { latest: "0.1.10", install: { state: "failed", version: "0.1.10", error: "Homebrew was busy", retryAt: "2026-09-30T13:00:00Z" } }, now))
      .toBe("0.1.10 available; installing it failed (Homebrew was busy), tries again later. Or: grenade update");
    expect(updateLine("0.1.9", { latest: "0.1.10", install: { state: "pinned", version: "0.1.10" } }, now)).toBe("0.1.10 available; held back by brew pin grenade");
  });

  it("restarts only into a newer version, and only when no session is busy", () => {
    expect(restartDecision("0.1.9", "0.1.10", false)).toBe("restart");
    expect(restartDecision("0.1.9", "0.1.10", true)).toBe("wait");
    expect(restartDecision("0.1.10", "0.1.10", false)).toBe("none");
    expect(restartDecision("0.1.10", "0.1.9", false)).toBe("none");
    expect(restartDecision("0.1.10", null, false)).toBe("none");
  });

  it("counts working sessions and open questions as busy", () => {
    expect(isBusy({ status: "working" })).toBe(true);
    expect(isBusy({ status: "waiting", waitingFor: "answer" })).toBe(true);
    expect(isBusy({ status: "waiting", waitingFor: "done" })).toBe(false);
    expect(isBusy({ status: "idle" })).toBe(false);
    expect(isBusy({ status: "gone" })).toBe(false);
  });

  it("knows the launchd agent by its job name", () => {
    expect(underLaunchd({ XPC_SERVICE_NAME: "com.adamchew.grenade.daemon" })).toBe(true);
    expect(underLaunchd({ XPC_SERVICE_NAME: "com.adamchew.grenade.daemon.test" })).toBe(true);
    expect(underLaunchd({ XPC_SERVICE_NAME: "0" })).toBe(false);
    expect(underLaunchd({})).toBe(false);
  });
});

describe("installedVersion", () => {
  it("follows the bin symlink to the package, as Homebrew lays it out", () => {
    const dir = mkdtempSync(join(tmpdir(), "grenade-update-"));
    const pkg = join(dir, "Cellar", "grenade", "0.1.10", "libexec", "lib", "node_modules", "@holdgrenade", "cli");
    mkdirSync(join(pkg, "dist"), { recursive: true });
    mkdirSync(join(dir, "bin"));
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@holdgrenade/cli", version: "0.1.10" }));
    writeFileSync(join(pkg, "dist", "cli.js"), "");
    symlinkSync(join(pkg, "dist", "cli.js"), join(dir, "bin", "grenade"));
    expect(installedVersion(join(dir, "bin", "grenade"))).toBe("0.1.10");
    expect(installedVersion(join(dir, "bin", "missing"))).toBeNull();
  });
});

describe("UpdateChecker", () => {
  afterEach(() => vi.useRealTimers());

  const checker = (o: { installed?: string | null; busy?: boolean; formula?: string; restart?: (v: string) => void }) => {
    const state = { installed: o.installed ?? "0.1.9", busy: o.busy ?? false };
    const c = new UpdateChecker({
      running: "0.1.9",
      log: silentLogger,
      installed: () => state.installed,
      busy: () => state.busy,
      fetchFormula: async () => o.formula ?? formula({ version: "0.1.10", sha256: "0".repeat(64), tarball: "holdgrenade-cli-0.1.10.tgz" }),
      checkTap: false,
      ...(o.restart ? { restart: o.restart } : {}),
    });
    return { c, state };
  };

  it("learns the latest release from the tap", async () => {
    const { c } = checker({});
    const s = await c.checkTap();
    expect(s).toMatchObject({ installed: "0.1.9", latest: "0.1.10" });
    expect(s.error).toBeUndefined();
  });

  it("says a release is out only when it is newer than what this Mac has", async () => {
    const lines: string[] = [];
    const log = { ...silentLogger, info: (m: string) => void lines.push(m) };
    const older = formula({ version: "0.1.8", sha256: "0".repeat(64), tarball: "holdgrenade-cli-0.1.8.tgz" });
    const newer = formula({ version: "0.1.10", sha256: "0".repeat(64), tarball: "holdgrenade-cli-0.1.10.tgz" });
    let text = older;
    const c = new UpdateChecker({ running: "0.1.9", log, installed: () => "0.1.9", busy: () => false, fetchFormula: async () => text, checkTap: false });
    await c.checkTap();
    expect(lines).toEqual([]);
    text = newer;
    await c.checkTap();
    await c.checkTap();
    expect(lines).toEqual(["Grenade 0.1.10 is out (running 0.1.9). Update with: grenade update"]);
  });

  it("keeps the last good answer when the tap cannot be read", async () => {
    const { c } = checker({});
    await c.checkTap();
    const broken = new UpdateChecker({ running: "0.1.9", log: silentLogger, installed: () => "0.1.9", busy: () => false, fetchFormula: async () => "nothing", checkTap: false });
    expect((await broken.checkTap()).error).toBe("the tap's formula names no version");
    expect(c.current().latest).toBe("0.1.10");
  });

  it("restarts once a newer version is on disk and nothing is busy, and only once", () => {
    const restart = vi.fn();
    const { c, state } = checker({ restart, busy: true });
    c.watchDisk();
    expect(restart).not.toHaveBeenCalled();
    state.installed = "0.1.10";
    c.watchDisk();
    expect(restart).not.toHaveBeenCalled();
    state.busy = false;
    c.watchDisk();
    c.watchDisk();
    expect(restart).toHaveBeenCalledTimes(1);
    expect(restart).toHaveBeenCalledWith("0.1.10");
  });

  describe("installing", () => {
    const brew = { method: "brew" as const, brew: "/opt/homebrew/bin/brew" };
    const tap = formula({ version: "0.1.10", sha256: "0".repeat(64), tarball: "holdgrenade-cli-0.1.10.tgz" });
    const make = (o: { auto: boolean; outcome?: () => Promise<{ kind: "done" } | { kind: "failed"; error: string } | { kind: "needsAdmin" } | { kind: "pinned" }> }) => {
      const disk = { installed: "0.1.9" };
      const install = vi.fn(async () => {
        const r = o.outcome ? await o.outcome() : ({ kind: "done" } as const);
        if (r.kind === "done") disk.installed = "0.1.10";
        return r;
      });
      const c = new UpdateChecker({
        running: "0.1.9", log: silentLogger, installed: () => disk.installed, busy: () => false,
        fetchFormula: async () => tap, checkTap: false, installer: brew, install, auto: () => o.auto,
      });
      return { c, install, disk };
    };
    const settle = () => new Promise((r) => setTimeout(r, 0));

    it("installs a newer release by itself when auto is on", async () => {
      const { c, install } = make({ auto: true });
      await c.checkTap();
      await settle();
      expect(install).toHaveBeenCalledTimes(1);
      expect(c.current()).toMatchObject({ installed: "0.1.10", latest: "0.1.10", method: "brew", auto: true });
      expect(c.current().install).toBeUndefined();
    });

    it("only says it is out when auto is off, and installs when asked", async () => {
      const { c, install } = make({ auto: false });
      await c.checkTap();
      await settle();
      expect(install).not.toHaveBeenCalled();
      const answer = await c.installNow();
      expect(answer.install).toEqual({ state: "installing", version: "0.1.10" });
      await settle();
      expect(install).toHaveBeenCalledTimes(1);
      expect(c.current().installed).toBe("0.1.10");
    });

    it("says why it failed and tries again an hour later", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      let fail = true;
      const { c, install } = make({ auto: true, outcome: async () => (fail ? { kind: "failed", error: "Homebrew was busy" } : { kind: "done" }) });
      await c.checkTap();
      await vi.advanceTimersByTimeAsync(0);
      expect(c.current().install).toMatchObject({ state: "failed", version: "0.1.10", error: "Homebrew was busy" });
      expect(c.current().install).toHaveProperty("retryAt");
      await c.checkTap(); // a check before the hour does not try again
      await vi.advanceTimersByTimeAsync(0);
      expect(install).toHaveBeenCalledTimes(1);
      fail = false;
      await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
      expect(install).toHaveBeenCalledTimes(2);
      expect(c.current().install).toBeUndefined();
      expect(c.current().installed).toBe("0.1.10");
    });

    it("leaves a pinned formula and an npm folder it cannot write alone until asked", async () => {
      const pinned = make({ auto: true, outcome: async () => ({ kind: "pinned" }) });
      await pinned.c.checkTap();
      await settle();
      await pinned.c.checkTap();
      await settle();
      expect(pinned.install).toHaveBeenCalledTimes(1);
      expect(pinned.c.current().install).toEqual({ state: "pinned", version: "0.1.10" });

      const admin = make({ auto: true, outcome: async () => ({ kind: "needsAdmin" }) });
      await admin.c.checkTap();
      await settle();
      expect(admin.c.current().install).toEqual({ state: "needsAdmin", version: "0.1.10", command: "sudo npm install -g @holdgrenade/cli@latest" });
    });

    it("never installs a copy built from source", async () => {
      const install = vi.fn();
      const c = new UpdateChecker({
        running: "0.1.9", log: silentLogger, installed: () => "0.1.9", busy: () => false,
        fetchFormula: async () => tap, checkTap: false, installer: null, install, auto: () => true,
      });
      await c.checkTap();
      await c.installNow();
      await settle();
      expect(install).not.toHaveBeenCalled();
      expect(c.current().method).toBe("source");
    });

    it("asks npm, not the tap, for an npm copy", async () => {
      const c = new UpdateChecker({
        running: "0.1.9", log: silentLogger, installed: () => "0.1.9", busy: () => false, checkTap: false,
        fetchFormula: async () => tap, fetchNpm: async () => JSON.stringify({ version: "0.1.0" }),
        installer: { method: "npm", npm: ["/x/npm"], writes: [] }, install: vi.fn(), auto: () => true,
      });
      expect((await c.checkTap()).latest).toBe("0.1.0");
    });
  });

  it("restarts when asked, but not while a session is busy unless forced, and never when started by hand", () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const restart = vi.fn();
    const { c, state } = checker({ restart, busy: true });
    expect(c.restartNow(false)).toBe("busy");
    expect(c.restartNow(true)).toBe("restarting");
    state.busy = false;
    expect(c.restartNow(false)).toBe("restarting"); // once is enough
    vi.advanceTimersByTime(100);
    expect(restart).toHaveBeenCalledTimes(1);
    expect(checker({}).c.restartNow(true)).toBe("cannotRestart");
  });

  it("never restarts a daemon started by hand, and says it cannot", () => {
    const { c, state } = checker({});
    state.installed = "0.1.10";
    expect(() => c.watchDisk()).not.toThrow();
    expect(c.current().installed).toBe("0.1.10");
    expect(c.current().restarts).toBe(false);
    expect(checker({ restart: vi.fn() }).c.current().restarts).toBe(true);
  });
});
