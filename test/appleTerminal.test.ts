import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import type { Session } from "@grenade/protocol";
import { silentLogger } from "../src/log.js";
import type { RegistryEvents, SessionRegistry } from "../src/sessions/registry.js";
import { attachedIn, closeWindowScript, listTtysScript, openWindowScript, parseClients, type TmuxClient } from "../src/terminal/appleTerminal.js";
import { TerminalMirror } from "../src/terminal/mirror.js";

const session = (id: string, status: Session["status"] = "working", group?: string, createdAt = "2026-09-27T12:00:00.000Z"): Session => ({
  id, name: id.slice(3), agent: "shell", cwd: "/tmp", status, statusSince: "2026-09-27T12:00:00.000Z", lastLine: "", createdAt,
  ...(group ? { group } : {}),
});

function fakeRegistry(initial: Session[] = []) {
  const em = new EventEmitter<RegistryEvents>() as EventEmitter<RegistryEvents> & { list(): Session[]; get(id: string): Session | undefined };
  em.list = () => initial;
  em.get = (id) => initial.find((s) => s.id === id);
  return em as unknown as SessionRegistry & EventEmitter<RegistryEvents>;
}

/** Records scripts. Terminal's listing answers with `ttys`; each `do script` gets the next tty; a close answers 1. */
function fakeTerminal(ttys: string[] = []) {
  const scripts: string[] = [];
  let next = 100;
  const run = async (script: string) => {
    scripts.push(script);
    if (script.includes("tty of t)")) return ttys.join("\n");
    if (script.includes("do script")) return `/dev/ttys${next++}`;
    if (script.includes("set closed to 0")) return "1";
    return "";
  };
  return { run, scripts };
}

const flush = () => new Promise((r) => setTimeout(r, 0));
const noClients = async (): Promise<TmuxClient[]> => [];

describe("Terminal.app scripts", () => {
  it("opens a window with the absolute tmux path, names it, and returns its tty", () => {
    const s = openWindowScript({ tmuxBin: "/opt/homebrew/bin/tmux", id: "gr-api", title: "grenade · api" });
    expect(s).toContain('do script "/opt/homebrew/bin/tmux attach-session -t =gr-api"');
    expect(s).toContain('set custom title of t to "grenade · api"');
    expect(s).toContain("return tty of t");
  });

  it("closes only a window whose single tab has the tty", () => {
    const s = closeWindowScript("/dev/ttys004");
    expect(s).toContain('(count of tabs of w) is 1 and tty of (tab 1 of w) is "/dev/ttys004"');
    expect(s).toContain("close w saving no");
  });

  it("lists every tab's tty", () => {
    expect(listTtysScript()).toContain("set end of found to (tty of t)");
  });

  it("matches tmux's clients against Terminal's ttys", () => {
    const clients = parseClients("/dev/ttys001\tgr-api\n/dev/ttys009\tgr-web\n\nbroken line\n");
    expect(clients).toEqual([{ tty: "/dev/ttys001", session: "gr-api" }, { tty: "/dev/ttys009", session: "gr-web" }]);
    expect(attachedIn(["/dev/ttys001", "/dev/ttys002"], clients)).toEqual(new Map([["gr-api", "/dev/ttys001"]]));
  });
});

describe("TerminalMirror (Terminal.app)", () => {
  it("opens a window per session and closes it by tty when the session ends", async () => {
    const registry = fakeRegistry();
    const { run, scripts } = fakeTerminal();
    const mirror = new TerminalMirror({ registry, log: silentLogger, run, terminal: "terminal", clients: noClients, tmuxBin: "/bin/tmux" });
    await mirror.start();
    registry.emit("created", session("gr-one"));
    await flush();
    expect(scripts.filter((s) => s.includes("do script"))).toHaveLength(1);
    expect(mirror.openIds()).toEqual(["gr-one"]);
    registry.emit("removed", "gr-one");
    await flush();
    expect(scripts.at(-1)).toContain('is "/dev/ttys100"');
    expect(mirror.openIds()).toEqual([]);
  });

  it("gives group mates windows of their own and leaves them where they are on regroup", async () => {
    const list = [session("gr-api", "working", "g-1"), session("gr-web", "working", "g-1", "2026-09-27T12:01:00.000Z")];
    const registry = fakeRegistry(list);
    const { run, scripts } = fakeTerminal();
    const mirror = new TerminalMirror({ registry, log: silentLogger, run, terminal: "terminal", clients: noClients, tmuxBin: "/bin/tmux" });
    await mirror.start();
    await flush();
    expect(scripts.filter((s) => s.includes("do script"))).toHaveLength(2);
    expect(scripts.some((s) => s.includes("split"))).toBe(false);
    registry.emit("regrouped", list[1]!, "g-9");
    await flush();
    expect(scripts.filter((s) => s.includes("do script"))).toHaveLength(2);
    expect(scripts.some((s) => s.includes("set closed to 0"))).toBe(false);
  });

  it("after a restart, knows the windows tmux is attached in and opens the missing ones", async () => {
    const registry = fakeRegistry([session("gr-has"), session("gr-none")]);
    const { run, scripts } = fakeTerminal(["/dev/ttys001", "/dev/ttys002"]);
    const clients = async () => [{ tty: "/dev/ttys001", session: "gr-has" }, { tty: "/dev/ttys050", session: "gr-none" }];
    const mirror = new TerminalMirror({ registry, log: silentLogger, run, terminal: "terminal", clients, tmuxBin: "/bin/tmux" });
    await mirror.start();
    await flush();
    const opened = scripts.filter((s) => s.includes("do script"));
    expect(opened).toHaveLength(1);
    expect(opened[0]).toContain("=gr-none");
    expect(mirror.openIds().sort()).toEqual(["gr-has", "gr-none"]);
    registry.emit("removed", "gr-has");
    await flush();
    expect(scripts.at(-1)).toContain('is "/dev/ttys001"');
  });

  it("auto: uses Terminal.app until iTerm2 is installed, then iTerm2 for new sessions; old windows still close through Terminal", async () => {
    const registry = fakeRegistry();
    const { run, scripts } = fakeTerminal();
    let iterm = false;
    const mirror = new TerminalMirror({ registry, log: silentLogger, run, terminal: "auto", installed: () => iterm, appleTerminal: () => true, clients: noClients, tmuxBin: "/bin/tmux" });
    await mirror.start();
    registry.emit("created", session("gr-old"));
    await flush();
    expect(scripts.at(-1)).toContain('tell application "Terminal"');
    iterm = true;
    registry.emit("created", session("gr-new"));
    await flush();
    const inITerm = scripts.filter((s) => s.startsWith('tell application "iTerm2"'));
    expect(inITerm.some((s) => s.includes("=gr-new"))).toBe(true);
    expect(inITerm.some((s) => s.includes("=gr-old"))).toBe(false);
    registry.emit("removed", "gr-old");
    await flush();
    expect(scripts.at(-1)).toContain('tell application "Terminal"');
    expect(scripts.at(-1)).toContain('is "/dev/ttys100"');
  });
});
