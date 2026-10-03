/**
 * Mirrors Grenade sessions into a terminal on the Mac, so you can watch every agent at once.
 *
 *   session created  → a new tab attached to it (`tmux attach -t =<id>`); in a terminal that splits,
 *                      a pane to the right of the group's last pane instead
 *   session regrouped→ (terminals that split) moved out: its pane is closed and reopened as its own tab;
 *                      moved in last: reopened to the right of the group; moved in elsewhere, or reordered:
 *                      the group's panes are laid out again in order (`relayoutSteps`), keeping the first pane
 *                      (and so the tab) when it stays first. In Terminal.app nothing moves: windows stay.
 *   session killed   → tmux ends the agent first, then the tab is closed
 *   session gone     → (agent exited on its own) the tab is closed
 *   daemon start     → tabs for live sessions that have none yet
 *
 * Which terminal (`TerminalKind`): `none`, the default (the Mac app and the phone show every session), `iterm`
 * (iTerm2), `terminal` (Apple's Terminal.app), or `auto`: iTerm2 when it is installed, else Terminal.app. The kind
 * is asked again at every event (`grenade terminal` changes it while the daemon runs), and so is whether iTerm2 is
 * installed, so either change takes over for new sessions; tabs already open stay and close through their terminal.
 * Each terminal is caught up once, the first time it is used: the tabs it already has are listed and every live
 * session without one gets one. All scripts run one call at a time through a queue.
 *
 * Both terminals are driven with AppleScript, so on Linux there is none to mirror into, whatever kind is asked for:
 * sessions are watched on the phone, and any terminal attaches with `grenade open <name>`.
 */
import type { Session } from "@grenade/protocol";
import type { Logger } from "../log.js";
import { byGroupOrder, otherMembers } from "../sessions/groups.js";
import type { SessionRegistry } from "../sessions/registry.js";
import { canRunAppleScript, resolveTmuxBin, type ScriptRunner, type TerminalAdapter } from "./adapter.js";
import { AppleTerminalAdapter, isAppleTerminalInstalled, type ClientLister } from "./appleTerminal.js";
import { ITermAdapter, isITermInstalled } from "./iterm.js";

export type TerminalKind = "auto" | "iterm" | "terminal" | "none";

export const TERMINAL_KINDS: readonly TerminalKind[] = ["auto", "iterm", "terminal", "none"];

/** What `GET /terminal` answers: the kind asked for, the terminal that means now (null: none), and whether
 * `--terminal` or `GRENADE_TERMINAL` pins it, so `~/.grenade/terminal.json` is not read. */
export interface TerminalStatus {
  terminal: TerminalKind;
  using: string | null;
  pinned: boolean;
}

export function isTerminalKind(v: string): v is TerminalKind {
  return (TERMINAL_KINDS as readonly string[]).includes(v);
}

/** `GRENADE_TERMINAL` when it is set: it pins the kind, over `~/.grenade/terminal.json`. */
export function terminalFromEnv(): TerminalKind | undefined {
  const env = process.env["GRENADE_TERMINAL"];
  return env !== undefined && isTerminalKind(env) ? env : undefined;
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

// ---- the mirror ----------------------------------------------------------------

export interface MirrorOptions {
  registry: SessionRegistry;
  log: Logger;
  tmuxBin?: string;
  /** Runs AppleScript; tests fake it. */
  run?: ScriptRunner;
  /** Which terminal, or how to ask for it at every event (`readTerminalSetting`). Default `none`. */
  terminal?: TerminalKind | (() => TerminalKind);
  /** Is iTerm2 installed? Asked at every event in `auto`. Tests fake it. */
  installed?: () => boolean;
  /** Is Terminal.app there (every Mac)? Tests fake it. */
  appleTerminal?: () => boolean;
  /** tmux's clients, for Terminal.app to find its windows again. Tests fake it. */
  clients?: ClientLister;
}

export class TerminalMirror {
  private readonly registry: SessionRegistry;
  private readonly log: Logger;
  private readonly kind: () => TerminalKind;
  private readonly installed: () => boolean;
  private readonly hasAppleTerminal: () => boolean;
  /** Scripts can run: a runner was handed in (tests), or this system has AppleScript. */
  private readonly scriptable: boolean;
  private readonly iterm: TerminalAdapter;
  private readonly apple: TerminalAdapter;
  private queue: Promise<unknown> = Promise.resolve();
  /** Which terminal each session's tab is in. */
  private readonly openIn = new Map<string, TerminalAdapter>();
  /** The catch-up of each terminal, in flight or done; gone again after one that failed. */
  private readonly ready = new Map<TerminalAdapter, Promise<void>>();
  private readonly onCreated = (s: Session) => this.whenEnabled(() => this.openTab(s));
  private readonly onRegrouped = (s: Session, from: string | undefined) => this.whenEnabled(() => this.regroup(s, from));
  private readonly onRemoved = (id: string) => this.whenEnabled(() => this.closeTab(id));
  private readonly onUpdated = (s: Session) => {
    if (s.status === "gone") this.whenEnabled(() => this.closeTab(s.id));
  };

  constructor(o: MirrorOptions) {
    this.registry = o.registry;
    this.log = o.log;
    const t = o.terminal ?? "none";
    this.kind = typeof t === "function" ? t : () => t;
    this.installed = o.installed ?? isITermInstalled;
    this.hasAppleTerminal = o.appleTerminal ?? isAppleTerminalInstalled;
    this.scriptable = o.run !== undefined || canRunAppleScript();
    const tmuxBin = o.tmuxBin ?? resolveTmuxBin();
    this.iterm = new ITermAdapter(tmuxBin, o.run);
    this.apple = new AppleTerminalAdapter(tmuxBin, o.run, o.clients);
  }

  /** The terminal tabs go to right now, or null when none is wanted. Asked every time, so iTerm2 installed later counts. */
  private current(): TerminalAdapter | null {
    if (!this.scriptable) return null;
    switch (this.kind()) {
      case "none":
        return null;
      case "iterm":
        return this.iterm;
      case "terminal":
        return this.apple;
      case "auto":
        return this.installed() ? this.iterm : this.hasAppleTerminal() ? this.apple : null;
    }
  }

  /** Subscribes to the registry and, when a terminal is wanted, opens tabs for live sessions that have none. */
  async start(): Promise<void> {
    this.registry.on("created", this.onCreated);
    this.registry.on("removed", this.onRemoved);
    this.registry.on("updated", this.onUpdated);
    this.registry.on("regrouped", this.onRegrouped);
    const a = this.current();
    if (a) await this.whenReady(a);
    else this.log.debug("No terminal to mirror sessions into; the Mac app and the phone show them");
  }

  /** The kind asked for and the terminal it means right now. */
  status(): { terminal: TerminalKind; using: string | null } {
    return { terminal: this.kind(), using: this.current()?.name ?? null };
  }

  /** Catches up the terminal wanted now, so a change of kind opens tabs at once rather than at the next event. */
  refresh(): void {
    const a = this.current();
    if (a) void this.whenReady(a).catch((e) => this.log.warn(`Could not list the ${a.name} tabs`, { error: e }));
  }

  stop(): void {
    this.registry.off("created", this.onCreated);
    this.registry.off("removed", this.onRemoved);
    this.registry.off("updated", this.onUpdated);
    this.registry.off("regrouped", this.onRegrouped);
  }

  /** Ids this mirror believes have a tab. */
  openIds(): string[] {
    return [...this.openIn.keys()];
  }

  /** Runs `job` once a terminal is wanted and its existing tabs are known; does nothing while none is. */
  private whenEnabled(job: () => void): void {
    const a = this.current();
    if (!a) return;
    void this.whenReady(a).then(job, (e) => this.log.warn(`Could not list the ${a.name} tabs`, { error: e }));
  }

  private whenReady(a: TerminalAdapter): Promise<void> {
    let p = this.ready.get(a);
    if (!p) {
      p = this.catchUp(a).catch((e: unknown) => {
        this.ready.delete(a); // try again at the next event
        throw e;
      });
      this.ready.set(a, p);
    }
    return p;
  }

  /** Learns which tabs the terminal already has, then opens one for every live session without. Once per terminal. */
  private async catchUp(a: TerminalAdapter): Promise<void> {
    const existing = await this.enqueue(() => a.list());
    for (const id of existing) if (!this.openIn.has(id)) this.openIn.set(id, a);
    // Group order, so the first session of a group gets the tab and the rest split to its right in order.
    const inOrder = [...this.registry.list()].sort(byGroupOrder);
    for (const s of inOrder) {
      if (s.status !== "gone" && !this.openIn.has(s.id)) this.openTab(s, a);
    }
    this.log.debug(`Mirroring sessions into ${a.name}`, { existingTabs: existing.length });
  }

  /** Opens a pane to the right of the group member just before it in order, else a tab of its own. */
  private openTab(s: Session, into?: TerminalAdapter): void {
    if (this.openIn.has(s.id)) return;
    const a = into ?? this.current();
    if (!a) return;
    this.openPane(s, a.splits ? this.openMemberOf(s, a) : undefined, a);
  }

  private regroup(s: Session, from: string | undefined): void {
    const a = this.current();
    if (!a) return;
    // Terminal.app has no panes to move: the session keeps its window, or gets one.
    if (!a.splits) return this.openTab(s, a);
    const group = s.group;
    const members = group === undefined ? [] : [...otherMembers(group, this.registry.list(), s.id), s].sort(byGroupOrder);
    const movedIn = from !== group;
    if (movedIn) this.closeTab(s.id);
    // Alone, or joining at the end: the other panes are already in order.
    if (members.length <= 1 || (movedIn && members.at(-1)?.id === s.id)) return this.openTab(s, a);
    for (const step of relayoutSteps(members.map((m) => m.id), this.openIdsIn(a))) {
      if (step.kind === "close") this.closeTab(step.id);
      else {
        const m = this.registry.get(step.id);
        if (m) this.openPane(m, step.kind === "split" ? step.nextTo : undefined, a);
      }
    }
  }

  private openPane(s: Session, nextTo: string | undefined, a: TerminalAdapter): void {
    this.openIn.set(s.id, a);
    const title = `grenade · ${s.name}`;
    void this.enqueue(async () => {
      if (nextTo) {
        const how = await a.split({ id: s.id, title, nextTo });
        this.log.debug(`Opened ${a.name} ${how === "split" ? `pane next to ${nextTo}` : "tab"} for ${s.id}`);
      } else {
        await a.open({ id: s.id, title });
        this.log.debug(`Opened ${a.name} tab for ${s.id}`);
      }
    }).catch((e) => {
      this.openIn.delete(s.id);
      this.log.warn(`Could not open a ${a.name} tab for ${s.id}`, { error: e });
    });
  }

  private openIdsIn(a: TerminalAdapter): Set<string> {
    return new Set([...this.openIn].filter(([, x]) => x === a).map(([id]) => id));
  }

  /** The nearest live member before `s` in group order that has a pane in `a`, else the last one that has. */
  private openMemberOf(s: Session, a: TerminalAdapter): string | undefined {
    if (s.group === undefined) return undefined;
    const open = otherMembers(s.group, this.registry.list(), s.id).filter((m) => this.openIn.get(m.id) === a);
    const before = open.filter((m) => byGroupOrder(m, s) < 0);
    return (before.at(-1) ?? open.at(-1))?.id;
  }

  private closeTab(id: string): void {
    const a = this.openIn.get(id);
    if (!a) return;
    this.openIn.delete(id);
    void this.enqueue(async () => {
      const closed = await a.close(id);
      this.log.debug(`Closed ${a.name} tab for ${id}`, { closed });
    }).catch((e) => this.log.warn(`Could not close the ${a.name} tab for ${id}`, { error: e }));
  }

  /** One script at a time; a failure never blocks the next call. */
  private enqueue<T>(job: () => Promise<T>): Promise<T> {
    const next = this.queue.then(job, job);
    this.queue = next.catch(() => undefined);
    return next;
  }
}
