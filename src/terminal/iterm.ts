/**
 * Mirrors Grenade sessions into iTerm2 tabs so you can watch every agent on the Mac.
 *
 *   session created  → a new tab in the current iTerm window running `tmux attach -t =<id>`,
 *                      or a split pane to the right of the group's last pane
 *   session regrouped→ moved out: its pane is closed and reopened as its own tab
 *                      moved in last: its pane is closed and reopened to the right of the group
 *                      moved in elsewhere, or reordered: the group's panes are laid out again in order
 *                      (`relayoutSteps`), keeping the first pane (and so the tab) when it stays first
 *   session killed   → tmux ends the agent first, then the tab is closed
 *   session gone     → (agent exited on its own) the tab is closed
 *   daemon start     → tabs for live sessions that have none yet
 *
 * Tabs are tagged with the iTerm session variable `user.grenadeSession = <id>`, so they are found
 * again whatever their title says. All AppleScript runs one call at a time through a queue.
 */
import { execFile, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Session } from "@grenade/protocol";
import type { Logger } from "../log.js";
import { byGroupOrder, otherMembers } from "../sessions/groups.js";
import type { SessionRegistry } from "../sessions/registry.js";

export const TAG_VARIABLE = "user.grenadeSession";

/** `auto` is the default: iTerm2 tabs whenever iTerm2 is installed, looked up again at every event, so installing it later needs no restart. */
export type TerminalKind = "iterm" | "none" | "auto";

export function isITermInstalled(): boolean {
  return existsSync("/Applications/iTerm.app") || existsSync(join(homedir(), "Applications", "iTerm.app"));
}

/** `GRENADE_TERMINAL` when it is set, else `auto`. */
export function defaultTerminal(): TerminalKind {
  const env = process.env["GRENADE_TERMINAL"];
  if (env === "iterm" || env === "none" || env === "auto") return env;
  return "auto";
}

/** Absolute tmux path: an iTerm command session has no shell profile, so PATH may lack Homebrew. */
export function resolveTmuxBin(): string {
  const fromEnv = process.env["TMUX_BIN"];
  if (fromEnv) return fromEnv;
  try {
    const found = execFileSync("/usr/bin/which", ["tmux"], { encoding: "utf8" }).trim();
    if (found) return found;
  } catch {
    // fall through
  }
  for (const candidate of ["/opt/homebrew/bin/tmux", "/usr/local/bin/tmux"]) if (existsSync(candidate)) return candidate;
  return "tmux";
}

// ---- AppleScript builders (pure, tested) -----------------------------------

function asString(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function attachCommand(tmuxBin: string, id: string): string {
  const bin = tmuxBin.includes(" ") ? `"${tmuxBin}"` : tmuxBin; // asString escapes these quotes once
  return asString(`${bin} attach-session -t =${id}`);
}

/** AppleScript lines that open a tab (or a window when iTerm has none) and leave it in `s`. */
function newTabLines(command: string): string {
  return `  if (count of windows) = 0 then
    set w to (create window with default profile command ${command})
    set s to current session of w
  else
    tell current window
      set t to (create tab with default profile command ${command})
      set s to current session of t
    end tell
  end if`;
}

function tagLines(id: string, title: string): string {
  return `  tell s
    set variable named ${asString(TAG_VARIABLE)} to ${asString(id)}
    set name to ${asString(title)}
  end tell`;
}

/** Opens a tab attached to the session and tags it. A window is created when iTerm has none. */
export function openTabScript(o: { tmuxBin: string; id: string; title: string }): string {
  return `tell application "iTerm2"
${newTabLines(attachCommand(o.tmuxBin, o.id))}
${tagLines(o.id, o.title)}
end tell`;
}

/**
 * Splits the pane tagged `nextTo` and attaches the new pane to the session. When no pane has that
 * tag (closed by hand), it opens a tab instead. Returns "split" or "tab".
 */
export function splitPaneScript(o: { tmuxBin: string; id: string; title: string; nextTo: string }): string {
  const command = attachCommand(o.tmuxBin, o.id);
  return `tell application "iTerm2"
  set target to missing value
  repeat with w in windows
    repeat with t in tabs of w
      repeat with x in sessions of t
        try
          if (variable named ${asString(TAG_VARIABLE)}) of x is ${asString(o.nextTo)} then set target to x
        end try
      end repeat
    end repeat
  end repeat
  if target is missing value then
${newTabLines(command)}
    set how to "tab"
  else
    tell target
      set s to (split vertically with default profile command ${command})
    end tell
    set how to "split"
  end if
${tagLines(o.id, o.title)}
  return how
end tell`;
}

/** Closes every tab tagged with the session id. Returns the count closed. */
export function closeTabScript(id: string): string {
  return `tell application "iTerm2"
  set closed to 0
  repeat with w in windows
    repeat with t in tabs of w
      repeat with s in sessions of t
        try
          if (variable named ${asString(TAG_VARIABLE)}) of s is ${asString(id)} then
            close s
            set closed to closed + 1
          end if
        end try
      end repeat
    end repeat
  end repeat
  return closed
end tell`;
}

/** Lists the session ids of all tagged tabs, one per line. */
export function listTaggedScript(): string {
  return `tell application "iTerm2"
  set found to {}
  repeat with w in windows
    repeat with t in tabs of w
      repeat with s in sessions of t
        try
          set v to (variable named ${asString(TAG_VARIABLE)}) of s
          if v is not missing value then set end of found to v
        end try
      end repeat
    end repeat
  end repeat
  set AppleScript's text item delimiters to linefeed
  return found as text
end tell`;
}

export function parseTaggedList(out: string): string[] {
  return out
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

// ---- layout (pure, tested) ---------------------------------------------------

export type PaneStep =
  | { kind: "close"; id: string }
  | { kind: "tab"; id: string }
  | { kind: "split"; id: string; nextTo: string };

/**
 * Steps that lay out a group's panes left to right in `ordered` (live member ids, group order).
 * `split vertically` puts the new pane to the right, so each member splits the one before it.
 * When the first member already has a pane it is kept, and with it the tab's place in the window.
 */
export function relayoutSteps(ordered: readonly string[], open: ReadonlySet<string>): PaneStep[] {
  const [head, ...rest] = ordered;
  if (head === undefined) return [];
  const keepHead = open.has(head);
  const steps: PaneStep[] = [];
  for (const id of keepHead ? rest : ordered) if (open.has(id)) steps.push({ kind: "close", id });
  if (!keepHead) steps.push({ kind: "tab", id: head });
  rest.forEach((id, i) => steps.push({ kind: "split", id, nextTo: ordered[i] as string }));
  return steps;
}

// ---- running ----------------------------------------------------------------

export type ScriptRunner = (script: string) => Promise<string>;

export const runAppleScript: ScriptRunner = (script) =>
  new Promise((resolve, reject) => {
    const child = execFile("/usr/bin/osascript", ["-"], { timeout: 15_000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr.trim() || err.message));
      else resolve(stdout.trimEnd());
    });
    child.stdin?.end(script);
  });

export interface MirrorOptions {
  registry: SessionRegistry;
  log: Logger;
  tmuxBin?: string;
  run?: ScriptRunner;
  /** Only iTerm is supported today; `none` makes start() a no-op. Default `auto`. */
  terminal?: TerminalKind;
  /** Is iTerm2 installed? Asked at every event in `auto`. Tests fake it. */
  installed?: () => boolean;
}

export class ITermMirror {
  private readonly registry: SessionRegistry;
  private readonly log: Logger;
  private readonly tmuxBin: string;
  private readonly run: ScriptRunner;
  private readonly kind: TerminalKind;
  private readonly installed: () => boolean;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly open = new Set<string>();
  /** The catch-up in flight or done; null until iTerm is first wanted, and again after a catch-up that failed. */
  private ready: Promise<void> | null = null;
  private readonly onCreated = (s: Session) => this.whenEnabled(() => this.openTab(s));
  private readonly onRegrouped = (s: Session, from: string | undefined) => this.whenEnabled(() => this.regroup(s, from));
  private readonly onRemoved = (id: string) => this.whenEnabled(() => this.closeTab(id));
  private readonly onUpdated = (s: Session) => {
    if (s.status === "gone") this.whenEnabled(() => this.closeTab(s.id));
  };

  constructor(o: MirrorOptions) {
    this.registry = o.registry;
    this.log = o.log;
    this.tmuxBin = o.tmuxBin ?? resolveTmuxBin();
    this.run = o.run ?? runAppleScript;
    this.kind = o.terminal ?? "auto";
    this.installed = o.installed ?? isITermInstalled;
  }

  /** Tabs are wanted now: `iterm`, or `auto` with iTerm2 installed. Asked every time, so iTerm2 installed after the daemon started counts. */
  private enabled(): boolean {
    return this.kind === "iterm" || (this.kind === "auto" && this.installed());
  }

  /** Subscribes to the registry and, when iTerm2 is there, opens tabs for live sessions that have none. */
  async start(): Promise<void> {
    if (this.kind === "none") return;
    this.registry.on("created", this.onCreated);
    this.registry.on("removed", this.onRemoved);
    this.registry.on("updated", this.onUpdated);
    this.registry.on("regrouped", this.onRegrouped);
    if (this.enabled()) await this.whenReady();
    else this.log.debug("iTerm2 is not installed; sessions get a tab once it is");
  }

  /** Runs `job` once iTerm is wanted and the tabs it already has are known; does nothing while it is not wanted. */
  private whenEnabled(job: () => void): void {
    if (!this.enabled()) return;
    void this.whenReady().then(job, (e) => this.log.warn("Could not list the iTerm tabs", { error: e }));
  }

  private whenReady(): Promise<void> {
    if (!this.ready) {
      this.ready = this.catchUp().catch((e: unknown) => {
        this.ready = null; // try again at the next event
        throw e;
      });
    }
    return this.ready;
  }

  /** Learns which tabs iTerm already has, then opens one for every live session without. Once, the first time tabs are wanted. */
  private async catchUp(): Promise<void> {
    const tagged = new Set(await this.enqueue(async () => parseTaggedList(await this.run(listTaggedScript()))));
    for (const id of tagged) this.open.add(id);
    // Group order, so the first session of a group gets the tab and the rest split to its right in order.
    const inOrder = [...this.registry.list()].sort(byGroupOrder);
    for (const s of inOrder) {
      if (s.status !== "gone" && !tagged.has(s.id)) this.openTab(s);
    }
    this.log.debug("Mirroring sessions into iTerm", { existingTabs: tagged.size });
  }

  stop(): void {
    this.registry.off("created", this.onCreated);
    this.registry.off("removed", this.onRemoved);
    this.registry.off("updated", this.onUpdated);
    this.registry.off("regrouped", this.onRegrouped);
  }

  /** Ids this mirror believes have a tab. */
  openIds(): string[] {
    return [...this.open];
  }

  /** Opens a pane to the right of the group member just before it in order, else a tab of its own. */
  private openTab(s: Session): void {
    if (this.open.has(s.id)) return;
    this.openPane(s, this.openMemberOf(s));
  }

  private regroup(s: Session, from: string | undefined): void {
    const group = s.group;
    const members = group === undefined ? [] : [...otherMembers(group, this.registry.list(), s.id), s].sort(byGroupOrder);
    const movedIn = from !== group;
    if (movedIn) this.closeTab(s.id);
    // Alone, or joining at the end: the other panes are already in order.
    if (members.length <= 1 || (movedIn && members.at(-1)?.id === s.id)) return this.openTab(s);
    for (const step of relayoutSteps(members.map((m) => m.id), this.open)) {
      if (step.kind === "close") this.closeTab(step.id);
      else {
        const m = this.registry.get(step.id);
        if (m) this.openPane(m, step.kind === "split" ? step.nextTo : undefined);
      }
    }
  }

  private openPane(s: Session, nextTo: string | undefined): void {
    this.open.add(s.id);
    const title = `grenade · ${s.name}`;
    void this.enqueue(async () => {
      if (nextTo) {
        const how = await this.run(splitPaneScript({ tmuxBin: this.tmuxBin, id: s.id, title, nextTo }));
        this.log.debug(`Opened iTerm ${how === "split" ? `pane next to ${nextTo}` : "tab"} for ${s.id}`);
      } else {
        await this.run(openTabScript({ tmuxBin: this.tmuxBin, id: s.id, title }));
        this.log.debug(`Opened iTerm tab for ${s.id}`);
      }
    }).catch((e) => {
      this.open.delete(s.id);
      this.log.warn(`Could not open an iTerm tab for ${s.id}`, { error: e });
    });
  }

  /** The nearest live member before `s` in group order that has a pane, else the last one that has. */
  private openMemberOf(s: Session): string | undefined {
    if (s.group === undefined) return undefined;
    const open = otherMembers(s.group, this.registry.list(), s.id).filter((m) => this.open.has(m.id));
    const before = open.filter((m) => byGroupOrder(m, s) < 0);
    return (before.at(-1) ?? open.at(-1))?.id;
  }

  private closeTab(id: string): void {
    if (!this.open.has(id)) return;
    this.open.delete(id);
    void this.enqueue(async () => {
      const closed = await this.run(closeTabScript(id));
      this.log.debug(`Closed iTerm tab for ${id}`, { closed: Number(closed) || 0 });
    }).catch((e) => this.log.warn(`Could not close the iTerm tab for ${id}`, { error: e }));
  }

  /** One AppleScript at a time; a failure never blocks the next call. */
  private enqueue<T>(job: () => Promise<T>): Promise<T> {
    const next = this.queue.then(job, job);
    this.queue = next.catch(() => undefined);
    return next;
  }
}
