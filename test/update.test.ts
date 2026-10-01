import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { silentLogger } from "../src/log.js";
import { formula } from "../packaging/homebrew/formula.mjs";
import { installedVersion } from "../src/update/installedVersion.js";
import { underLaunchd } from "../src/update/underLaunchd.js";
import { UpdateChecker } from "../src/update/updateChecker.js";
import {
  compareVersions,
  installMethodOf,
  isBusy,
  isNewer,
  latestFromFormula,
  restartDecision,
  updateCommandsFor,
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
    expect(updateCommandsFor("brew")).toEqual([["brew", "update", "--quiet"], ["brew", "upgrade", "grenade"]]);
    expect(updateCommandsFor("npm")).toEqual([["npm", "install", "-g", "@holdgrenade/cli@latest"]]);
    expect(updateCommandsFor("source")).toBeNull();
  });

  it("says a new version is out, or that one is installed and waits to run", () => {
    expect(updateNotice("0.1.9", { installed: "0.1.9", latest: "0.1.10" })).toBe("A new version of Grenade is out: 0.1.9 → 0.1.10. Update with: grenade update");
    expect(updateNotice("0.1.9", { installed: "0.1.10", latest: "0.1.10" })).toMatch(/^Grenade 0.1.10 is installed; grenaded 0.1.9 restarts into it/);
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

  it("never restarts a daemon started by hand", () => {
    const { c, state } = checker({});
    state.installed = "0.1.10";
    expect(() => c.watchDisk()).not.toThrow();
    expect(c.current().installed).toBe("0.1.10");
  });
});
