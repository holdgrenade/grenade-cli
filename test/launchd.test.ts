import { describe, expect, it } from "vitest";
import { serviceLines } from "../src/cli/serviceCommand.js";
import { parseLaunchctlPrint } from "../src/service/launchctlOutput.js";
import { SERVICE_LABEL, domainTarget, plistPath, renderPlist, servicePath, serviceTarget, stableProgram } from "../src/service/launchdPlist.js";

const spec = {
  label: SERVICE_LABEL,
  program: "/opt/homebrew/bin/grenade",
  args: ["daemon"],
  path: "/opt/homebrew/bin:/usr/bin:/bin",
  env: { SHELL: "/bin/zsh" },
  logPath: "/Users/adam/.grenade/launchd.log",
};

describe("renderPlist", () => {
  const plist = renderPlist(spec);

  it("runs `grenade daemon` at login", () => {
    expect(plist).toContain("<key>Label</key>\n\t<string>com.adamchew.grenade.daemon</string>");
    expect(plist).toContain("<key>ProgramArguments</key>\n\t<array>\n\t\t<string>/opt/homebrew/bin/grenade</string>\n\t\t<string>daemon</string>\n\t</array>");
    expect(plist).toContain("<key>RunAtLoad</key>\n\t<true/>");
  });

  it("restarts after a crash, not after a clean stop", () => {
    expect(plist).toContain("<key>KeepAlive</key>\n\t<dict>\n\t\t<key>SuccessfulExit</key>\n\t\t<false/>\n\t</dict>");
    expect(plist).toContain("<key>ThrottleInterval</key>\n\t<integer>10</integer>");
  });

  it("leaves tmux alone when the daemon stops, and lives in the login session", () => {
    expect(plist).toContain("<key>AbandonProcessGroup</key>\n\t<true/>");
    expect(plist).toContain("<key>LimitLoadToSessionType</key>\n\t<string>Aqua</string>");
  });

  it("carries the PATH and the rest of the environment, sorted", () => {
    expect(plist).toContain("<key>EnvironmentVariables</key>\n\t<dict>\n\t\t<key>PATH</key>\n\t\t<string>/opt/homebrew/bin:/usr/bin:/bin</string>\n\t\t<key>SHELL</key>\n\t\t<string>/bin/zsh</string>\n\t</dict>");
  });

  it("escapes what XML would read as markup", () => {
    const odd = renderPlist({ ...spec, args: ["daemon", "--name", "Tom & Jerry's <Mac>"] });
    expect(odd).toContain("<string>Tom &amp; Jerry's &lt;Mac&gt;</string>");
  });

  it("is a plist that plutil accepts", async () => {
    if (process.platform !== "darwin") return;
    const { execFileSync } = await import("node:child_process");
    const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "grenade-plist-"));
    try {
      const file = join(dir, "agent.plist");
      writeFileSync(file, renderPlist({ ...spec, args: ["daemon", "--name", "Tom & Jerry's <Mac>"] }));
      expect(execFileSync("/usr/bin/plutil", ["-lint", file], { encoding: "utf8" })).toContain("OK");
      const json = JSON.parse(execFileSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", file], { encoding: "utf8" })) as Record<string, unknown>;
      expect(json["ProgramArguments"]).toEqual(["/opt/homebrew/bin/grenade", "daemon", "--name", "Tom & Jerry's <Mac>"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("where the agent lives", () => {
  it("is a file in the user's LaunchAgents, in the login session's domain", () => {
    expect(plistPath("/Users/adam")).toBe("/Users/adam/Library/LaunchAgents/com.adamchew.grenade.daemon.plist");
    expect(domainTarget(501)).toBe("gui/501");
    expect(serviceTarget(501)).toBe("gui/501/com.adamchew.grenade.daemon");
    expect(serviceTarget(501, "test.label")).toBe("gui/501/test.label");
  });
});

describe("servicePath", () => {
  it("keeps the login shell's order and adds the usual homes of node, tmux and claude once", () => {
    expect(servicePath("/Users/adam/n/bin:/opt/homebrew/bin:/usr/bin", "/Users/adam", "/Users/adam/n/bin")).toBe(
      "/Users/adam/n/bin:/opt/homebrew/bin:/usr/bin:/usr/local/bin:/Users/adam/.local/bin:/bin:/usr/sbin:/sbin",
    );
  });

  it("drops empty and relative entries, and works without a PATH", () => {
    expect(servicePath("::bin:/usr/bin", "/Users/adam", "/n/bin").split(":")).not.toContain("bin");
    expect(servicePath(undefined, "/Users/adam", "/n/bin").split(":")[0]).toBe("/n/bin");
  });
});

describe("stableProgram", () => {
  it("swaps a Homebrew Cellar path for the link that survives an upgrade", () => {
    expect(stableProgram("/opt/homebrew/Cellar/grenade/0.1.0/libexec/bin/grenade")).toBe("/opt/homebrew/bin/grenade");
    expect(stableProgram("/usr/local/Cellar/grenade/0.2.0/bin/grenade")).toBe("/usr/local/bin/grenade");
  });

  it("leaves every other path as it is", () => {
    expect(stableProgram("/opt/homebrew/bin/grenade")).toBe("/opt/homebrew/bin/grenade");
    expect(stableProgram("/Users/adam/n/bin/grenade")).toBe("/Users/adam/n/bin/grenade");
  });
});

describe("parseLaunchctlPrint", () => {
  const running = [
    "gui/501/com.adamchew.grenade.daemon = {",
    "\tactive count = 1",
    "\tpath = /Users/adam/Library/LaunchAgents/com.adamchew.grenade.daemon.plist",
    "\tstate = running",
    "\tprogram = /opt/homebrew/bin/grenade",
    "\tpid = 4321",
    "\tlast exit code = (never exited)",
    "\tendpoints = {",
    "\t\t\"x\" = {",
    "\t\t\tstate = active",
    "\t\t}",
    "\t}",
    "}",
  ].join("\n");

  it("reads a running job", () => {
    expect(parseLaunchctlPrint(running)).toEqual({ loaded: true, running: true, pid: 4321 });
  });

  it("reads a job that died and waits for its restart", () => {
    const dead = running.replace("state = running", "state = spawn scheduled").replace("\tpid = 4321\n", "").replace("(never exited)", "1");
    expect(parseLaunchctlPrint(dead)).toEqual({ loaded: true, running: false, lastExit: 1 });
  });

  it("reads a job launchd does not know", () => {
    expect(parseLaunchctlPrint(null)).toEqual({ loaded: false, running: false });
  });
});

describe("serviceLines", () => {
  const base = { plist: "/Users/adam/Library/LaunchAgents/x.plist", label: "x" };

  it("says how to install it, and whether a daemon runs anyway", () => {
    const lines = serviceLines({ ...base, installed: false, loaded: false, running: false }, true);
    expect(lines[0]).toContain("grenade service install");
    expect(lines[1]).toContain("started by hand");
  });

  it("shows a running agent", () => {
    expect(serviceLines({ ...base, installed: true, loaded: true, running: true, pid: 7 }, true).join("\n")).toContain("running, pid 7");
  });

  it("shows an agent that died with its exit code", () => {
    expect(serviceLines({ ...base, installed: true, loaded: true, running: false, lastExit: 1 }, false).join("\n")).toContain("last exit code 1");
  });
});
