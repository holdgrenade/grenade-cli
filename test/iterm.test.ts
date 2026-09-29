import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import type { Session } from "@grenade/protocol";
import { silentLogger } from "../src/log.js";
import type { RegistryEvents, SessionRegistry } from "../src/sessions/registry.js";
import { ITermMirror, TAG_VARIABLE, closeTabScript, listTaggedScript, openTabScript, parseTaggedList, relayoutSteps, splitPaneScript } from "../src/terminal/iterm.js";

const session = (id: string, status: Session["status"] = "working", group?: string, createdAt = "2026-09-27T12:00:00.000Z", order?: number): Session => ({
  id, name: id.slice(3), agent: "shell", cwd: "/tmp", status, statusSince: "2026-09-27T12:00:00.000Z", lastLine: "", createdAt,
  ...(group ? { group } : {}), ...(order !== undefined ? { order } : {}),
});

/** Just enough registry: events plus list(). */
function fakeRegistry(initial: Session[] = []) {
  const em = new EventEmitter<RegistryEvents>() as EventEmitter<RegistryEvents> & { list(): Session[]; get(id: string): Session | undefined };
  em.list = () => initial;
  em.get = (id) => initial.find((s) => s.id === id);
  return em as unknown as SessionRegistry & EventEmitter<RegistryEvents>;
}

/** Records scripts; answers the list script with `tagged`, close scripts with "1". */
function fakeRunner(tagged: string[] = []) {
  const scripts: string[] = [];
  const run = async (script: string) => {
    scripts.push(script);
    if (script.includes("set found to {}")) return tagged.join("\n");
    if (script.includes("set closed to 0")) return "1";
    return "";
  };
  return { run, scripts };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("AppleScript builders", () => {
  it("open script attaches with the absolute tmux path and tags the session", () => {
    const s = openTabScript({ tmuxBin: "/opt/homebrew/bin/tmux", id: "gr-app", title: "grenade · app" });
    expect(s).toContain('"/opt/homebrew/bin/tmux attach-session -t =gr-app"');
    expect(s).toContain(`set variable named "${TAG_VARIABLE}" to "gr-app"`);
    expect(s).toContain('set name to "grenade · app"');
    expect(s).toContain("create window with default profile command");
    expect(s).toContain("create tab with default profile command");
  });

  it("quotes a tmux path with spaces and escapes quotes in titles", () => {
    const s = openTabScript({ tmuxBin: "/Users/me/my tools/tmux", id: "gr-x", title: 'say "hi"' });
    expect(s).toContain('\\"/Users/me/my tools/tmux\\" attach-session');
    expect(s).toContain('set name to "say \\"hi\\""');
  });

  it("close script matches on the tag, never the title", () => {
    const s = closeTabScript("gr-app");
    expect(s).toContain(`(variable named "${TAG_VARIABLE}") of s is "gr-app"`);
    expect(s).not.toContain("name of s");
  });

  it("split script splits the pane tagged with the group mate and falls back to a tab", () => {
    const s = splitPaneScript({ tmuxBin: "/bin/tmux", id: "gr-zsh", title: "grenade · zsh", nextTo: "gr-app" });
    expect(s).toContain(`(variable named "${TAG_VARIABLE}") of x is "gr-app" then set target to x`);
    // `contents` of an iTerm session is its screen text, not the session itself.
    expect(s).not.toContain("contents of x");
    expect(s).toContain('split vertically with default profile command "/bin/tmux attach-session -t =gr-zsh"');
    expect(s).toContain("create tab with default profile command");
    expect(s).toContain(`set variable named "${TAG_VARIABLE}" to "gr-zsh"`);
  });

  it("list output parses one id per line", () => {
    expect(parseTaggedList("gr-a\ngr-b\n")).toEqual(["gr-a", "gr-b"]);
    expect(parseTaggedList("")).toEqual([]);
    expect(listTaggedScript()).toContain("linefeed");
  });
});

describe("ITermMirror", () => {
  it("opens a tab when a session is created and closes it when removed", async () => {
    const registry = fakeRegistry();
    const { run, scripts } = fakeRunner();
    const mirror = new ITermMirror({ registry, log: silentLogger, run, tmuxBin: "/bin/tmux" });
    await mirror.start();
    registry.emit("created", session("gr-one"));
    await flush();
    expect(scripts.some((s) => s.includes('attach-session -t =gr-one"'))).toBe(true);
    expect(mirror.openIds()).toEqual(["gr-one"]);
    registry.emit("removed", "gr-one");
    await flush();
    expect(scripts.at(-1)).toContain('is "gr-one"');
    expect(mirror.openIds()).toEqual([]);
  });

  it("closes the tab when the agent exits on its own (status gone)", async () => {
    const registry = fakeRegistry();
    const { run, scripts } = fakeRunner();
    const mirror = new ITermMirror({ registry, log: silentLogger, run, tmuxBin: "/bin/tmux" });
    await mirror.start();
    registry.emit("created", session("gr-one"));
    registry.emit("updated", session("gr-one", "gone"));
    await flush();
    expect(scripts.at(-1)).toContain("set closed to 0");
    expect(mirror.openIds()).toEqual([]);
  });

  it("on start opens tabs only for live sessions that have no tab yet", async () => {
    const registry = fakeRegistry([session("gr-has-tab"), session("gr-no-tab"), session("gr-dead", "gone")]);
    const { run, scripts } = fakeRunner(["gr-has-tab"]);
    const mirror = new ITermMirror({ registry, log: silentLogger, run, tmuxBin: "/bin/tmux" });
    await mirror.start();
    await flush();
    const opened = scripts.filter((s) => s.includes("attach-session"));
    expect(opened).toHaveLength(1);
    expect(opened[0]).toContain("=gr-no-tab");
    expect(mirror.openIds().sort()).toEqual(["gr-has-tab", "gr-no-tab"]);
  });

  it("does nothing when terminal is none", async () => {
    const registry = fakeRegistry([session("gr-one")]);
    const { run, scripts } = fakeRunner();
    const mirror = new ITermMirror({ registry, log: silentLogger, run, terminal: "none", tmuxBin: "/bin/tmux" });
    await mirror.start();
    registry.emit("created", session("gr-two"));
    await flush();
    expect(scripts).toEqual([]);
  });

  it("a failed script does not block later ones", async () => {
    const registry = fakeRegistry();
    let calls = 0;
    const run = async (script: string) => {
      calls++;
      if (script.includes("=gr-bad")) throw new Error("iTerm said no");
      return script.includes("set found") ? "" : "1";
    };
    const mirror = new ITermMirror({ registry, log: silentLogger, run, tmuxBin: "/bin/tmux" });
    await mirror.start();
    registry.emit("created", session("gr-bad"));
    registry.emit("created", session("gr-good"));
    await flush();
    await flush();
    expect(calls).toBe(3);
    expect(mirror.openIds()).toEqual(["gr-good"]);
  });

  it("opens a group mate as a split pane next to the oldest open member", async () => {
    const list = [session("gr-app", "working", "g-1", "2026-09-27T12:00:00.000Z")];
    const registry = fakeRegistry(list);
    const { run, scripts } = fakeRunner();
    const mirror = new ITermMirror({ registry, log: silentLogger, run, tmuxBin: "/bin/tmux" });
    await mirror.start();
    const zsh = session("gr-zsh", "working", "g-1", "2026-09-27T12:05:00.000Z");
    list.push(zsh);
    registry.emit("created", zsh);
    const web = session("gr-web", "working", "g-2");
    list.push(web);
    registry.emit("created", web);
    await flush();
    const opens = scripts.filter((x) => x.includes("attach-session"));
    expect(opens[0]).toContain("=gr-app");
    expect(opens[0]).not.toContain("split vertically");
    expect(opens[1]).toContain('of x is "gr-app"');
    expect(opens[1]).toContain("=gr-zsh");
    expect(opens[2]).not.toContain("split vertically");
  });

  it("moving a session closes its pane and reopens it where its group now lives", async () => {
    const list = [session("gr-app", "working", "g-1"), session("gr-zsh", "working", "g-1", "2026-09-27T12:05:00.000Z")];
    const registry = fakeRegistry(list);
    const { run, scripts } = fakeRunner(["gr-app", "gr-zsh"]);
    const mirror = new ITermMirror({ registry, log: silentLogger, run, tmuxBin: "/bin/tmux" });
    await mirror.start();
    scripts.length = 0;
    list[1] = session("gr-zsh", "working", "g-9", "2026-09-27T12:05:00.000Z");
    registry.emit("regrouped", list[1], "g-1");
    await flush();
    expect(scripts[0]).toContain('is "gr-zsh"');
    expect(scripts[0]).toContain("set closed to 0");
    expect(scripts[1]).toContain("=gr-zsh");
    expect(scripts[1]).not.toContain("split vertically");
    expect(mirror.openIds().sort()).toEqual(["gr-app", "gr-zsh"]);
  });

  it("reordering a group keeps the first pane when it stays first and splits the rest in order", async () => {
    const g = (id: string, order: number) => session(id, "working", "g-1", "2026-09-27T12:00:00.000Z", order);
    const list = [g("gr-a", 0), g("gr-b", 1), g("gr-c", 2)];
    const registry = fakeRegistry(list);
    const { run, scripts } = fakeRunner(["gr-a", "gr-b", "gr-c"]);
    const mirror = new ITermMirror({ registry, log: silentLogger, run, tmuxBin: "/bin/tmux" });
    await mirror.start();
    scripts.length = 0;
    list.splice(0, 3, g("gr-a", 0), g("gr-c", 1), g("gr-b", 2));
    registry.emit("regrouped", list[1]!, "g-1");
    await flush();
    const summary = scripts.map((x) => (x.includes("set closed to 0") ? `close ${x.match(/is "(gr-\w+)"/)?.[1]}` : `${x.includes("split vertically") ? "split" : "tab"} ${x.match(/=(gr-\w+)/)?.[1]}`));
    expect(summary).toEqual(["close gr-c", "close gr-b", "split gr-c", "split gr-b"]);
    expect(scripts[2]).toContain('of x is "gr-a"');
    expect(scripts[3]).toContain('of x is "gr-c"');
  });

  it("joining a group at the end only splits the last pane", async () => {
    const list = [session("gr-a", "working", "g-1", undefined, 0), session("gr-b", "working", "g-1", undefined, 1), session("gr-x", "working", "g-9")];
    const registry = fakeRegistry(list);
    const { run, scripts } = fakeRunner(["gr-a", "gr-b", "gr-x"]);
    const mirror = new ITermMirror({ registry, log: silentLogger, run, tmuxBin: "/bin/tmux" });
    await mirror.start();
    scripts.length = 0;
    list[2] = session("gr-x", "working", "g-1", undefined, 2);
    registry.emit("regrouped", list[2], "g-9");
    await flush();
    expect(scripts).toHaveLength(2);
    expect(scripts[0]).toContain('is "gr-x"');
    expect(scripts[1]).toContain("split vertically");
    expect(scripts[1]).toContain('of x is "gr-b"');
  });
});

describe("relayoutSteps", () => {
  it("keeps an open first pane, closes the others and splits each after the one before", () => {
    expect(relayoutSteps(["a", "c", "b"], new Set(["a", "b", "c"]))).toEqual([
      { kind: "close", id: "c" },
      { kind: "close", id: "b" },
      { kind: "split", id: "c", nextTo: "a" },
      { kind: "split", id: "b", nextTo: "c" },
    ]);
  });

  it("a first member with no pane gets a new tab after every pane of the group is closed", () => {
    expect(relayoutSteps(["x", "a", "b"], new Set(["a", "b"]))).toEqual([
      { kind: "close", id: "a" },
      { kind: "close", id: "b" },
      { kind: "tab", id: "x" },
      { kind: "split", id: "a", nextTo: "x" },
      { kind: "split", id: "b", nextTo: "a" },
    ]);
  });

  it("nothing to lay out for an empty group", () => {
    expect(relayoutSteps([], new Set())).toEqual([]);
  });
});
