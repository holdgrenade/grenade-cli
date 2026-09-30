/**
 * Terminal.app (Apple's, on every Mac) as a terminal for the mirror: one window per session. Terminal has no
 * independent panes and AppleScript cannot open a tab in it, so a group's sessions are separate windows.
 *
 * Terminal tabs carry no custom variables, so a window is known by the tty of its tab: `do script` returns the
 * tab and its tty, and after a daemon restart the ttys of Terminal's tabs are matched against tmux's clients
 * (`tmux list-clients`: which tty is attached to which session). Only a window whose single tab is the session's
 * is closed; a window someone merged other tabs into is left alone. The builders are pure and tested.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { asString, attachCommand, parseLines, runAppleScript, type ScriptRunner, type TabOf, type TerminalAdapter } from "./adapter.js";

export function isAppleTerminalInstalled(): boolean {
  return existsSync("/System/Applications/Utilities/Terminal.app") || existsSync("/Applications/Utilities/Terminal.app");
}

// ---- AppleScript builders (pure, tested) -----------------------------------

/** Opens a window running the attach, names it, and returns the tab's tty. */
export function openWindowScript(o: { tmuxBin: string; id: string; title: string }): string {
  return `tell application "Terminal"
  set t to do script ${attachCommand(o.tmuxBin, o.id)}
  set custom title of t to ${asString(o.title)}
  return tty of t
end tell`;
}

/** Lists the tty of every tab in every window, one per line. */
export function listTtysScript(): string {
  return `tell application "Terminal"
  set found to {}
  repeat with w in windows
    repeat with t in tabs of w
      set end of found to (tty of t)
    end repeat
  end repeat
  set AppleScript's text item delimiters to linefeed
  return found as text
end tell`;
}

/** Closes the window whose only tab has this tty. Returns the count closed (0 when it has other tabs too). */
export function closeWindowScript(tty: string): string {
  return `tell application "Terminal"
  set closed to 0
  repeat with w in windows
    if (count of tabs of w) is 1 and tty of (tab 1 of w) is ${asString(tty)} then
      close w saving no
      set closed to closed + 1
    end if
  end repeat
  return closed
end tell`;
}

export interface TmuxClient {
  tty: string;
  session: string;
}

/** Parses `tmux list-clients -F "#{client_tty}\t#{session_name}"`. */
export function parseClients(out: string): TmuxClient[] {
  return parseLines(out).flatMap((l) => {
    const [tty, session] = l.split("\t");
    return tty && session ? [{ tty, session }] : [];
  });
}

/** The sessions attached in one of Terminal's tabs: session id → tty. */
export function attachedIn(ttys: readonly string[], clients: readonly TmuxClient[]): Map<string, string> {
  const inTerminal = new Set(ttys);
  const found = new Map<string, string>();
  for (const c of clients) if (inTerminal.has(c.tty) && !found.has(c.session)) found.set(c.session, c.tty);
  return found;
}

export type ClientLister = () => Promise<TmuxClient[]>;

const listClients = (tmuxBin: string): ClientLister => () =>
  new Promise((resolve) => {
    execFile(tmuxBin, ["list-clients", "-F", "#{client_tty}\t#{session_name}"], { timeout: 5000 }, (err, stdout) => {
      resolve(err ? [] : parseClients(stdout)); // no server means no clients
    });
  });

// ---- the adapter ---------------------------------------------------------------

export class AppleTerminalAdapter implements TerminalAdapter {
  readonly name = "Terminal";
  readonly splits = false;
  /** The tty of each session's window, from `open` or from `list`. */
  private readonly ttyOf = new Map<string, string>();
  private readonly clients: ClientLister;

  constructor(
    private readonly tmuxBin: string,
    private readonly run: ScriptRunner = runAppleScript,
    clients?: ClientLister,
  ) {
    this.clients = clients ?? listClients(tmuxBin);
  }

  async list(): Promise<string[]> {
    const [ttys, clients] = await Promise.all([this.run(listTtysScript()).then(parseLines), this.clients()]);
    const found = attachedIn(ttys, clients);
    for (const [id, tty] of found) this.ttyOf.set(id, tty);
    return [...found.keys()];
  }

  async open(tab: TabOf): Promise<void> {
    const tty = (await this.run(openWindowScript({ tmuxBin: this.tmuxBin, ...tab }))).trim();
    if (tty) this.ttyOf.set(tab.id, tty);
  }

  /** Terminal cannot split: the session gets a window of its own. */
  async split(tab: TabOf & { nextTo: string }): Promise<"split" | "tab"> {
    await this.open(tab);
    return "tab";
  }

  async close(id: string): Promise<number> {
    const tty = this.ttyOf.get(id);
    this.ttyOf.delete(id);
    if (!tty) return 0;
    return Number(await this.run(closeWindowScript(tty))) || 0;
  }
}
