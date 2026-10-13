import { describe, expect, it } from "vitest";
import { silentLogger } from "../src/log.js";
import { followShellFolders } from "../src/sessions/poller.js";
import { SessionRegistry } from "../src/sessions/registry.js";
import { parsePaneFolders } from "../src/tmux/parse.js";
import type { Tmux } from "../src/tmux/tmux.js";

describe("parsePaneFolders", () => {
  it("reads each session's first pane's folder, keeping spaces", () => {
    const out = "gr-a\t/Users/me/app\ngr-a\t/tmp\ngr-b\t/Users/me/My Folder\n\nbad line\n";
    expect([...parsePaneFolders(out)]).toEqual([["gr-a", "/Users/me/app"], ["gr-b", "/Users/me/My Folder"]]);
  });
});

describe("followShellFolders", () => {
  const folders = new Set(["/Users/me/app", "/Users/me/web"]);
  const make = (panes: Record<string, string>) => {
    const tmux: Tmux = {
      async listSessions() { return []; },
      async paneFolders() { return new Map(Object.entries(panes)); },
      async hasSession() { return false; },
      async newSession() {},
      async capture() { throw new Error("unused"); },
      async captureHistory() { throw new Error("unused"); },
      async applySessionOptions() {},
      async sendText() {},
      async sendKey() {},
      async resize() {},
      async releaseSize() {},
      async windowWidths() { return new Map(); },
      async killSession() {},
    };
    return new SessionRegistry({ tmux, log: silentLogger, home: "/Users/me", isDirectory: (p) => folders.has(p) });
  };

  it("moves a shell's folder to where its shell is now, and tells clients", async () => {
    const registry = make({ "gr-sh": "/Users/me/web" });
    await registry.create({ name: "sh", cwd: "~/app", agent: "shell" });
    const updated: string[] = [];
    registry.on("updated", (s: { cwd: string }) => updated.push(s.cwd));
    await followShellFolders({ paneFolders: async () => new Map([["gr-sh", "/Users/me/web"]]) } as Tmux, registry);
    expect(registry.get("gr-sh")?.cwd).toBe("/Users/me/web");
    expect(updated).toEqual(["/Users/me/web"]);
  });

  it("leaves an agent's folder to the agent", async () => {
    const registry = make({});
    await registry.create({ name: "cc", cwd: "~/app", agent: "claude" });
    await followShellFolders({ paneFolders: async () => new Map([["gr-cc", "/tmp"]]) } as Tmux, registry);
    expect(registry.get("gr-cc")?.cwd).toBe("/Users/me/app");
  });
});
