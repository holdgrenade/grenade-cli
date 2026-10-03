import { describe, expect, it } from "vitest";
import { serviceLines } from "../src/cli/serviceCommand.js";
import { defaultLabel, serviceManager } from "../src/service/service.js";
import { parseSystemctlShow } from "../src/service/systemctlOutput.js";
import { renderUnit, unitName, unitPath } from "../src/service/systemdUnit.js";
import { scopeUnavailable, scopeUnit, scopedCommand } from "../src/tmux/serverScope.js";

const spec = {
  label: "grenade",
  program: "/usr/bin/grenade",
  args: ["daemon"],
  path: "/home/adam/.local/bin:/usr/bin:/bin",
  env: { SHELL: "/bin/bash" },
  logPath: "/home/adam/.grenade/systemd.log",
};

describe("renderUnit", () => {
  const unit = renderUnit(spec);

  it("runs `grenade daemon` at login", () => {
    expect(unit).toContain("ExecStart=/usr/bin/grenade daemon\n");
    expect(unit).toContain("[Install]\nWantedBy=default.target\n");
  });

  it("restarts after a failure, not after a clean stop", () => {
    expect(unit).toContain("Restart=on-failure\nRestartSec=10\n");
  });

  it("leaves tmux alone when the daemon stops", () => {
    expect(unit).toContain("KillMode=process\n");
  });

  it("carries the PATH, the rest of the environment and its own marker, sorted", () => {
    expect(unit).toContain('Environment="GRENADE_SERVICE=grenade"\nEnvironment="PATH=/home/adam/.local/bin:/usr/bin:/bin"\nEnvironment="SHELL=/bin/bash"\n');
  });

  it("sends what the daemon prints before its logger is up to a file", () => {
    expect(unit).toContain("StandardOutput=append:/home/adam/.grenade/systemd.log\nStandardError=append:/home/adam/.grenade/systemd.log\n");
  });

  it("quotes what systemd would split, expand or read as a specifier", () => {
    const odd = renderUnit({ ...spec, args: ["daemon", "--name", `Tom's "100%" $HOME box`], env: { GRENADE_HOME: "/home/adam/my grenade" } });
    expect(odd).toContain(`ExecStart=/usr/bin/grenade daemon --name "Tom's \\"100%%\\" $$HOME box"\n`);
    expect(odd).toContain('Environment="GRENADE_HOME=/home/adam/my grenade"\n');
  });
});

describe("where the unit lives", () => {
  it("is a file in the user's systemd folder, under XDG_CONFIG_HOME when that is set", () => {
    expect(unitName()).toBe("grenade.service");
    expect(unitPath("/home/adam")).toBe("/home/adam/.config/systemd/user/grenade.service");
    expect(unitPath("/home/adam", "grenade-test", "/home/adam/cfg")).toBe("/home/adam/cfg/systemd/user/grenade-test.service");
    expect(unitPath("/home/adam", "grenade", "relative")).toBe("/home/adam/.config/systemd/user/grenade.service");
  });
});

describe("parseSystemctlShow", () => {
  it("reads a running service", () => {
    expect(parseSystemctlShow("LoadState=loaded\nActiveState=active\nMainPID=4321\nExecMainCode=0\nExecMainStatus=0\n")).toEqual({ loaded: true, running: true, pid: 4321 });
  });

  it("reads a service that died and waits for its restart", () => {
    expect(parseSystemctlShow("LoadState=loaded\nActiveState=activating\nMainPID=0\nExecMainCode=1\nExecMainStatus=75\n")).toEqual({ loaded: true, running: false, lastExit: 75 });
  });

  it("reads a service that was stopped and never ran", () => {
    expect(parseSystemctlShow("LoadState=loaded\nActiveState=inactive\nMainPID=0\nExecMainCode=0\nExecMainStatus=0\n")).toEqual({ loaded: true, running: false });
  });

  it("reads a unit systemd does not know, and a systemctl that did not answer", () => {
    expect(parseSystemctlShow("LoadState=not-found\nActiveState=inactive\nMainPID=0\nExecMainCode=0\nExecMainStatus=0\n")).toEqual({ loaded: false, running: false });
    expect(parseSystemctlShow(null)).toEqual({ loaded: false, running: false });
  });
});

describe("which manager", () => {
  it("is launchd on a Mac and systemd on Linux, each with its own name for the service", () => {
    expect(serviceManager("darwin")).toBe("launchd");
    expect(serviceManager("linux")).toBe("systemd");
    expect(defaultLabel("darwin")).toBe("com.adamchew.grenade.daemon");
    expect(defaultLabel("linux")).toBe("grenade");
  });

  it("is named in what `grenade service status` prints", () => {
    const base = { file: "/home/adam/.config/systemd/user/grenade.service", label: "grenade", manager: "systemd" as const };
    expect(serviceLines({ ...base, installed: true, loaded: true, running: false, lastExit: 1 }, false).join("\n")).toContain("systemd starts it again within 10 s");
    expect(serviceLines({ ...base, installed: false, loaded: true, running: false }, false)[0]).toContain("systemd still has the service");
  });
});

describe("the tmux server's own scope", () => {
  it("runs the same tmux command through systemd-run, in a unit of its own", () => {
    expect(scopedCommand("/usr/bin/tmux", ["new-session", "-d", "-s", "gr-x"], "grenade-tmux-abc-1f")).toEqual({
      file: "systemd-run",
      args: ["--user", "--scope", "--quiet", "--collect", "--unit=grenade-tmux-abc-1f", "--description=tmux server for Grenade sessions", "--", "/usr/bin/tmux", "new-session", "-d", "-s", "gr-x"],
    });
    expect(scopeUnit(1_000_000, 0.5)).toBe("grenade-tmux-lfls-7fffff");
  });

  it("tells systemd-run failing apart from tmux failing", () => {
    expect(scopeUnavailable({ code: "ENOENT" }, "")).toBe(true);
    expect(scopeUnavailable({ code: 1 }, "Failed to connect to user scope bus via local transport: No medium found")).toBe(true);
    expect(scopeUnavailable({ code: 1 }, "Failed to start transient scope unit: Unit grenade-tmux-x.scope was already loaded")).toBe(true);
    expect(scopeUnavailable({ code: 1 }, "duplicate session: gr-x")).toBe(false);
  });
});
