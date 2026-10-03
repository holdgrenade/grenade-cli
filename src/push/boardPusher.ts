/**
 * Keeps each phone's Mac board (its Live Activity) current through the push route (PROTOCOL.md "Mac board").
 * Listens to the registry, builds every registered phone's board (`boardStateFor`, keys under that phone's pairing
 * token), and lets `boardPolicy.ts` decide when to push an update or the end. Knows no sockets: `register` /
 * `unregister` are called by a Connection.
 */
import {
  boardStateFor,
  type BoardPushRequest,
  type BoardRegisterFrame,
  type BoardState,
  type BoardStateFrame,
  type Session,
} from "@grenade/protocol";
import type { Logger } from "../log.js";
import { afterTry, boardAlert, boardKey, boardStep, mayAlert, newTrack, observe, type BoardTrack } from "./boardPolicy.js";
import type { BoardDevice, BoardDevices } from "./boardDevices.js";
import type { PushGateway } from "./pushConfig.js";
import { postPush, type PushResult } from "./pushGateway.js";
import type { PairedPhone } from "./pusher.js";

/** The slice of SessionRegistry the board needs. Tests pass a fake. */
export interface BoardRegistryPort {
  /** Every session, in the order of the `sessions` frame. */
  list(): Session[];
  on(event: "updated", cb: (s: Session) => void): unknown;
  on(event: "removed", cb: (id: string) => void): unknown;
  off(event: "updated", cb: (s: Session) => void): unknown;
  off(event: "removed", cb: (id: string) => void): unknown;
}

export interface BoardPusherDeps {
  registry: BoardRegistryPort;
  boards: BoardDevices;
  /** The phones paired right now. */
  paired(): PairedPhone[];
  /** Where pushes go; null while push is turned off (then no board push is sent). Read on every push. */
  gateway(): PushGateway | null;
  /** Someone is at the Mac (the same test that holds a notification). Asked only when a push could alert. */
  atMac(): Promise<boolean>;
  log: Logger;
  post?: (gateway: PushGateway, request: BoardPushRequest) => Promise<PushResult>;
  now?: () => number;
}

export class BoardPusher {
  private readonly tracks = new Map<string, BoardTrack>();
  private timer: NodeJS.Timeout | null = null;
  private looking = false;
  private lookAgain = false;
  private readonly now: () => number;
  private readonly onChange = () => void this.look();

  constructor(private readonly d: BoardPusherDeps) {
    this.now = d.now ?? Date.now;
  }

  start(): void {
    this.d.registry.on("updated", this.onChange);
    this.d.registry.on("removed", this.onChange);
    this.pairingsChanged();
    // A board saved before a restart: the phone shows what was last sent; a change made meanwhile is pushed.
    for (const b of this.d.boards.list()) this.tracks.set(b.id, { sent: b.sent, tried: b.sent, triedAt: null, changedAt: null, quietSince: null, retry: false });
    void this.look();
  }

  stop(): void {
    this.d.registry.off("updated", this.onChange);
    this.d.registry.off("removed", this.onChange);
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  // ---- phones -----------------------------------------------------------------

  /** `board.register` from the phone that said `hello` with `token`. The phone drew the board itself just now. */
  register(token: string, frame: BoardRegisterFrame): BoardStateFrame {
    const id = this.deviceId(token);
    if (!id) return this.stateOf(false);
    const known = this.d.boards.get(id);
    const at = this.now();
    const board = this.boardFor(token);
    const same = known && known.pushToken === frame.pushToken && known.environment === frame.environment && known.topic === frame.topic && known.provider === frame.provider;
    const device: BoardDevice = {
      id,
      provider: frame.provider,
      pushToken: frame.pushToken,
      environment: frame.environment,
      topic: frame.topic,
      registeredAt: same ? known.registeredAt : new Date(at).toISOString(),
      sent: board,
    };
    this.d.boards.set(device);
    const before = this.tracks.get(id);
    const fresh = newTrack(board, at);
    // Keep the spacing of pushes and the quiet clock across a phone that registers again after each `welcome`.
    this.tracks.set(id, before ? { ...fresh, triedAt: before.triedAt, quietSince: fresh.quietSince === null ? null : (before.quietSince ?? fresh.quietSince) } : fresh);
    if (!same) this.d.log.info(known ? "A phone registered a new Mac board" : "A phone registered its Mac board", { device: id });
    void this.look();
    return this.stateOf(true);
  }

  /** `board.unregister`: the user dismissed the activity or turned the board off. */
  unregister(token: string): BoardStateFrame {
    const id = this.deviceId(token);
    if (id && this.forget(id)) this.d.log.info("A phone ended its Mac board", { device: id });
    return this.stateOf(false);
  }

  /** A phone was paired or unpaired: boards of phones that are gone go with them. */
  pairingsChanged(): void {
    const gone = this.d.boards.prune(new Set(this.d.paired().map((p) => p.id)));
    for (const id of gone) this.tracks.delete(id);
    if (gone.length > 0) this.d.log.info("Removed the Mac board of unpaired phones", { devices: gone.join(",") });
  }

  // ---- pushing ----------------------------------------------------------------

  /** Looks at every board once: notes changes, pushes what is due, and sets the timer for the next thing due. */
  async look(): Promise<void> {
    if (this.looking) {
      this.lookAgain = true;
      return;
    }
    this.looking = true;
    try {
      do {
        this.lookAgain = false;
        await this.lookOnce();
      } while (this.lookAgain);
    } catch (e) {
      this.d.log.warn("Could not update the Mac boards", { error: e instanceof Error ? e.message : String(e) });
    } finally {
      this.looking = false;
    }
  }

  private async lookOnce(): Promise<void> {
    let wakeAt: number | null = null;
    for (const device of this.d.boards.list()) {
      const token = this.d.paired().find((p) => p.id === device.id)?.token;
      if (!token) {
        this.forget(device.id);
        continue;
      }
      const at = this.now();
      const board = this.boardFor(token);
      const track = observe(this.tracks.get(device.id) ?? newTrack(board, at), board, at);
      this.tracks.set(device.id, track);
      const step = boardStep(track, at);
      if (step.action === "update") await this.update(device, track, board, at);
      else if (step.action === "end") await this.end(device, board, at);
      const after = this.tracks.get(device.id);
      const next = after ? boardStep(after, this.now()) : null;
      if (next?.action === "none" && next.wakeAt !== undefined) wakeAt = Math.min(wakeAt ?? Infinity, next.wakeAt);
      else if (next && next.action !== "none") wakeAt = this.now();
    }
    this.schedule(wakeAt);
  }

  private async update(device: BoardDevice, track: BoardTrack, board: BoardState, at: number): Promise<void> {
    const gateway = this.d.gateway();
    if (!gateway) {
      // Push is off: the app's own updates are all the board gets.
      this.tracks.set(device.id, afterTry(track, board, at, "failed"));
      return;
    }
    const alert = mayAlert(track.sent, board) && boardAlert(track.sent, board, await this.d.atMac());
    const result = await this.post(gateway, this.requestFor(device, "update", alert, board, at));
    if (result.outcome === "unregistered") return this.gone(device);
    this.tracks.set(device.id, afterTry(track, board, this.now(), result.outcome === "sent" ? "sent" : result.outcome === "retry" ? "retry" : "failed"));
    if (result.outcome === "sent") {
      this.d.boards.set({ ...device, sent: board });
      this.d.log.debug(alert ? "Sent a Mac board push that alerts" : "Sent a Mac board push", { device: device.id, sessions: board.sessions.length });
    } else {
      this.d.log.warn("A Mac board push was not delivered", { device: device.id, gateway: gateway.url, status: result.status, error: result.error });
    }
  }

  private async end(device: BoardDevice, board: BoardState, at: number): Promise<void> {
    const gateway = this.d.gateway();
    if (gateway) {
      const result = await this.post(gateway, this.requestFor(device, "end", false, board, at));
      if (result.outcome !== "sent" && result.outcome !== "unregistered") {
        this.d.log.warn("The end of a Mac board was not delivered", { device: device.id, gateway: gateway.url, status: result.status, error: result.error });
      }
    }
    this.forget(device.id);
    this.d.log.info("Ended the Mac board of a phone: nothing to show for 15 minutes", { device: device.id });
  }

  private gone(device: BoardDevice): void {
    this.forget(device.id);
    this.d.log.info("A phone's Mac board no longer takes pushes; forgot it", { device: device.id });
  }

  private post(gateway: PushGateway, request: BoardPushRequest): Promise<PushResult> {
    return (this.d.post ?? postPush)(gateway, request);
  }

  private requestFor(device: BoardDevice, event: "update" | "end", alert: boolean, state: BoardState, at: number): BoardPushRequest {
    return {
      kind: "board",
      provider: device.provider,
      pushToken: device.pushToken,
      environment: device.environment,
      topic: device.topic,
      event,
      alert,
      at: Math.floor(at / 1000),
      state,
    };
  }

  private schedule(wakeAt: number | null): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (wakeAt === null) return;
    this.timer = setTimeout(() => void this.look(), Math.max(0, wakeAt - this.now()));
    this.timer.unref?.();
  }

  // ---- state ------------------------------------------------------------------

  private boardFor(token: string): BoardState {
    // BoardSession's optional `waitingFor` takes no explicit undefined (exactOptionalPropertyTypes), so it is copied only when set.
    const sessions = this.d.registry.list().map((s) => ({ id: s.id, status: s.status, statusSince: s.statusSince, ...(s.waitingFor ? { waitingFor: s.waitingFor } : {}) }));
    return boardStateFor(sessions, (sessionId) => boardKey(token, sessionId));
  }

  private forget(id: string): boolean {
    this.tracks.delete(id);
    return this.d.boards.remove(id);
  }

  private stateOf(registered: boolean): BoardStateFrame {
    return { type: "board.state", registered, delivery: this.d.gateway() ? "gateway" : "off" };
  }

  private deviceId(token: string): string | undefined {
    return this.d.paired().find((p) => p.token === token)?.id;
  }
}
