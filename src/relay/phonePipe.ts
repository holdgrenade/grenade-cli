/**
 * One phone reaching this daemon through the relay (one relay `conn`): a `SealedPipe` whose text travels in the
 * relay's `data` frames. No sockets here: the relay link feeds `handleData` and gets frames back through `send`.
 */
import { CLOSE_BAD_CHANNEL, type DaemonFrame, type RelayDaemonFrame } from "@grenade/protocol";
import type { Logger } from "../log.js";
import type { X25519Pair } from "./e2e.js";
import { HANDSHAKE_TIMEOUT_MS, SealedPipe, type PipeConnection } from "./sealedPipe.js";

export { HANDSHAKE_TIMEOUT_MS, type PipeConnection };
export const CLOSE_BAD_PIPE = CLOSE_BAD_CHANNEL;

export interface PhonePipeDeps {
  conn: string;
  staticKey: X25519Pair;
  /** Frames to the relay (`data` / `close` for this conn). */
  send(frame: RelayDaemonFrame): void;
  /** Builds the protocol connection once the channel is up. */
  makeConnection(out: (frame: DaemonFrame) => void, close: (code: number, reason: string) => void): PipeConnection;
  log: Logger;
  /** Called once when the pipe ends, from either side. */
  onEnd?(): void;
  ephemeral?: () => X25519Pair;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
}

export class PhonePipe {
  private readonly pipe: SealedPipe;

  constructor(d: PhonePipeDeps) {
    this.pipe = new SealedPipe({
      staticKey: d.staticKey,
      sendText: (text) => d.send({ type: "data", conn: d.conn, text }),
      closeTransport: (code, reason) => d.send({ type: "close", conn: d.conn, code, reason }),
      makeConnection: d.makeConnection,
      log: d.log,
      label: d.conn,
      ...(d.onEnd ? { onEnd: d.onEnd } : {}),
      ...(d.ephemeral ? { ephemeral: d.ephemeral } : {}),
      ...(d.setTimer ? { setTimer: d.setTimer } : {}),
      ...(d.clearTimer ? { clearTimer: d.clearTimer } : {}),
    });
  }

  /** One text frame from the phone, as the relay forwarded it. */
  handleData(text: string): void {
    this.pipe.handleText(text);
  }

  /** The relay says the phone went away. */
  handleClose(): void {
    this.pipe.handleClose();
  }

  /** Ends the pipe from this side and tells the relay. */
  close(code: number, reason: string): void {
    this.pipe.close(code, reason);
  }
}
