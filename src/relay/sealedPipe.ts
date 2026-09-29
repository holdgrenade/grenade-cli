/**
 * One encrypted connection from a phone, whatever carries it: a relay pipe or a socket on the local network
 * (PROTOCOL.md "End-to-end encryption"). The first text is the handshake; after it every text is sealed and the
 * plaintext goes to an ordinary `Connection`. No sockets here: the owner feeds `handleText` and gets text back.
 */
import { CLOSE_BAD_CHANNEL, parseE2EHello, type DaemonFrame } from "@grenade/protocol";
import type { Logger } from "../log.js";
import { daemonAccept, type SealedChannel, type X25519Pair } from "./e2e.js";

export const HANDSHAKE_TIMEOUT_MS = 10_000;

/** The slice of `Connection` a pipe drives. */
export interface PipeConnection {
  handleMessage(raw: string): unknown;
  handleClose(): void;
}

export interface SealedPipeDeps {
  staticKey: X25519Pair;
  /** One text frame to the phone: the handshake reply, then sealed frames. */
  sendText(text: string): void;
  /** Closes whatever carries the pipe. Called at most once, and only when this side ends it. */
  closeTransport(code: number, reason: string): void;
  /** Builds the protocol connection once the channel is up. */
  makeConnection(out: (frame: DaemonFrame) => void, close: (code: number, reason: string) => void): PipeConnection;
  log: Logger;
  /** For log lines: the relay conn, or the phone's address. */
  label: string;
  /** Called once when the pipe ends, from either side. */
  onEnd?(): void;
  ephemeral?: () => X25519Pair;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
}

export class SealedPipe {
  private channel: SealedChannel | null = null;
  private connection: PipeConnection | null = null;
  private ended = false;
  private readonly timer: unknown;

  constructor(private readonly d: SealedPipeDeps) {
    const setTimer = d.setTimer ?? ((fn, ms) => setTimeout(fn, ms).unref());
    this.timer = setTimer(() => {
      if (!this.channel) this.close(CLOSE_BAD_CHANNEL, "no handshake");
    }, HANDSHAKE_TIMEOUT_MS);
  }

  /** One text frame from the phone. */
  handleText(text: string): void {
    if (this.ended) return;
    if (!this.channel) return this.handshake(text);
    let plain: string;
    try {
      plain = this.channel.open(text);
    } catch {
      this.d.log.debug("Dropped an encrypted connection: a frame did not decrypt", { from: this.d.label });
      return this.close(CLOSE_BAD_CHANNEL, "bad frame");
    }
    void this.connection?.handleMessage(plain);
  }

  /** The phone went away. */
  handleClose(): void {
    this.end();
  }

  /** Ends the pipe from this side. */
  close(code: number, reason: string): void {
    if (this.ended) return;
    this.end();
    this.d.closeTransport(code, reason.slice(0, 120));
  }

  private handshake(text: string): void {
    const hello = parseE2EHello(text);
    if (!hello.ok) return this.close(CLOSE_BAD_CHANNEL, "bad handshake");
    let accepted: ReturnType<typeof daemonAccept>;
    try {
      accepted = daemonAccept(hello.frame, this.d.staticKey, this.d.ephemeral?.());
    } catch {
      return this.close(CLOSE_BAD_CHANNEL, "bad handshake");
    }
    (this.d.clearTimer ?? ((t) => clearTimeout(t as NodeJS.Timeout)))(this.timer);
    this.channel = accepted.channel;
    this.d.sendText(JSON.stringify(accepted.reply));
    this.connection = this.d.makeConnection(
      (frame) => {
        if (!this.ended && this.channel) this.d.sendText(this.channel.seal(JSON.stringify(frame)));
      },
      (code, reason) => this.close(code, reason),
    );
  }

  private end(): void {
    if (this.ended) return;
    this.ended = true;
    (this.d.clearTimer ?? ((t) => clearTimeout(t as NodeJS.Timeout)))(this.timer);
    this.connection?.handleClose();
    this.d.onEnd?.();
  }
}
