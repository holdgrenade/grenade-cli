/**
 * One WebSocket from the local network. Its first text frame decides what it is (PROTOCOL.md "On the local
 * network"): the encryption handshake starts a `SealedPipe`, exactly as a relay pipe; anything else is a phone that
 * predates encryption and goes to a plain `Connection`, which refuses it unless the daemon allows plain.
 * No `ws` import here: the server hands over the socket as `TextSocket`, so tests drive it with a fake.
 */
import { CLOSE_UNAUTHORIZED, parseE2EHello, type DaemonFrame } from "@grenade/protocol";
import type { Logger } from "../log.js";
import type { X25519Pair } from "../relay/e2e.js";
import { SealedPipe, type PipeConnection } from "../relay/sealedPipe.js";

export const FIRST_FRAME_TIMEOUT_MS = 5000;

export interface TextSocket {
  send(text: string): void;
  close(code: number, reason: string): void;
}

export interface LanSocketDeps {
  socket: TextSocket;
  staticKey: X25519Pair;
  makeConnection(out: (frame: DaemonFrame) => void, close: (code: number, reason: string) => void, sealed: boolean): PipeConnection;
  log: Logger;
  /** The phone's address, for log lines. */
  label: string;
  ephemeral?: () => X25519Pair;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
}

export class LanSocket {
  private pipe: SealedPipe | null = null;
  private plain: PipeConnection | null = null;
  private closed = false;
  private readonly timer: unknown;

  constructor(private readonly d: LanSocketDeps) {
    const setTimer = d.setTimer ?? ((fn, ms) => setTimeout(fn, ms).unref());
    this.timer = setTimer(() => {
      if (!this.pipe && !this.plain) this.close(CLOSE_UNAUTHORIZED, "no first frame");
    }, FIRST_FRAME_TIMEOUT_MS);
  }

  /** One text frame from the socket. */
  handleMessage(text: string): void {
    if (this.closed) return;
    if (this.pipe) return this.pipe.handleText(text);
    if (this.plain) return void this.plain.handleMessage(text);
    this.clearTimer();
    if (parseE2EHello(text).ok) {
      this.pipe = new SealedPipe({
        staticKey: this.d.staticKey,
        sendText: (t) => this.d.socket.send(t),
        closeTransport: (code, reason) => this.close(code, reason),
        makeConnection: (out, close) => this.d.makeConnection(out, close, true),
        log: this.d.log,
        label: this.d.label,
        ...(this.d.ephemeral ? { ephemeral: this.d.ephemeral } : {}),
        ...(this.d.setTimer ? { setTimer: this.d.setTimer } : {}),
        ...(this.d.clearTimer ? { clearTimer: this.d.clearTimer } : {}),
      });
      return this.pipe.handleText(text);
    }
    this.plain = this.d.makeConnection(
      (frame) => {
        if (!this.closed) this.d.socket.send(JSON.stringify(frame));
      },
      (code, reason) => this.close(code, reason),
      false,
    );
    void this.plain.handleMessage(text);
  }

  /** The socket closed. */
  handleClose(): void {
    this.closed = true;
    this.clearTimer();
    this.pipe?.handleClose();
    this.plain?.handleClose();
  }

  private close(code: number, reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.clearTimer();
    this.d.socket.close(code, reason);
  }

  private clearTimer(): void {
    (this.d.clearTimer ?? ((t) => clearTimeout(t as NodeJS.Timeout)))(this.timer);
  }
}
