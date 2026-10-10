/**
 * The agent's browser (PROTOCOL.md "Agent browser"): passes an agent's command (`POST /browser`, `grenade browser`)
 * to the app on this computer that said `browser.host`, and its `browser.result` back. Keeps no browser state of its
 * own: which tab is the agent's, and whether the person took it, is the app's.
 */
import type { BrowserCommandFrame, BrowserResultFrame } from "@grenade/protocol";
import { randomUUID } from "node:crypto";

/** How long a command waits for the app's answer: `open` waits for a page to load. */
export const BROWSER_COMMAND_TIMEOUT_MS = 60_000;

/** A connection that said `browser.host`. */
export interface BrowserHost {
  send(frame: BrowserCommandFrame): void;
}

export type BrowserRequest = Omit<BrowserCommandFrame, "type" | "id">;
export type BrowserAnswer = Omit<BrowserResultFrame, "type" | "id">;

interface Pending {
  host: BrowserHost;
  resolve(answer: BrowserAnswer): void;
  timer: unknown;
}

export interface BrowserBridgeDeps {
  /** The word for this machine, for what the agent reads ("Mac"). */
  computer?: string;
  timeoutMs?: number;
  newId?: () => string;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
}

export class BrowserBridge {
  /** Newest last: commands go to the newest host still connected. */
  private hosts: BrowserHost[] = [];
  private readonly pending = new Map<string, Pending>();

  constructor(private readonly d: BrowserBridgeDeps = {}) {}

  /** A connection said `browser.host`. */
  host(host: BrowserHost): void {
    this.hosts = [...this.hosts.filter((h) => h !== host), host];
  }

  /** A connection ended: it is no host, and what it was asked fails. */
  drop(host: BrowserHost): void {
    this.hosts = this.hosts.filter((h) => h !== host);
    for (const [id, p] of this.pending) {
      if (p.host === host) this.finish(id, { ok: false, message: "The Grenade app closed before it answered." });
    }
  }

  get hasHost(): boolean {
    return this.hosts.length > 0;
  }

  /** Sends one command to the newest host and waits for its answer, or fails at once without one. */
  run(request: BrowserRequest): Promise<BrowserAnswer> {
    const host = this.hosts.at(-1);
    if (!host) {
      const computer = this.d.computer ?? "Mac";
      return Promise.resolve({ ok: false, message: `The Grenade app is not open on this ${computer}. Ask the person to open it, then try again.` });
    }
    const id = this.d.newId?.() ?? randomUUID();
    const setTimer = this.d.setTimer ?? ((fn, ms) => setTimeout(fn, ms).unref());
    return new Promise((resolve) => {
      const timer = setTimer(() => this.finish(id, { ok: false, message: "The Grenade app did not answer in time." }), this.d.timeoutMs ?? BROWSER_COMMAND_TIMEOUT_MS);
      this.pending.set(id, { host, resolve, timer });
      host.send({ type: "browser.command", id, ...request });
    });
  }

  /** A host's `browser.result`. One for a command it was not sent is ignored. */
  result(host: BrowserHost, frame: BrowserResultFrame): void {
    if (this.pending.get(frame.id)?.host !== host) return;
    const { type: _type, id, ...answer } = frame;
    this.finish(id, answer);
  }

  private finish(id: string, answer: BrowserAnswer): void {
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    (this.d.clearTimer ?? ((t) => clearTimeout(t as NodeJS.Timeout)))(p.timer);
    p.resolve(answer);
  }
}
