/**
 * Port forwarding (PROTOCOL.md "Port forwarding"): one connection's streams to TCP ports on this computer's loopback
 * address, as `ssh -L` does, so the Mac app on another computer opens a dev server here that listens on `localhost`
 * only. Each stream is a socket to `127.0.0.1:<port>` (then `[::1]:<port>` when nothing listens there); its bytes go
 * out as `forward.data`, and the client's come in the same way. Never any other address. The sockets are made by
 * `connect`, so the tests need no port.
 */
import { createConnection } from "node:net";
import { FORWARD_DATA_MAX_BYTES, FORWARD_STREAMS_MAX, type DaemonFrame } from "@grenade/protocol";

/** What a stream needs of a socket. */
export interface ForwardSocket {
  write(data: Buffer): void;
  end(): void;
  destroy(): void;
  on(event: "connect", cb: () => void): unknown;
  on(event: "data", cb: (data: Buffer) => void): unknown;
  on(event: "error", cb: (error: NodeJS.ErrnoException) => void): unknown;
  on(event: "close", cb: () => void): unknown;
}

/** Opens a socket to `host:port`; it connects later (`connect`) or fails (`error`). */
export type ForwardConnect = (host: string, port: number) => ForwardSocket;

/** Loopback only: IPv4 first, then IPv6 (a dev server bound to `::1` alone). */
const HOSTS = ["127.0.0.1", "::1"] as const;

export const connectLoopback: ForwardConnect = (host, port) => createConnection({ host, port });

interface Stream {
  socket: ForwardSocket;
  open: boolean;
  /** The client's bytes that came before the socket connected, written once it does. */
  pending: Buffer[];
}

export class PortForwards {
  private readonly streams = new Map<string, Stream>();

  constructor(
    private readonly send: (frame: DaemonFrame) => void,
    private readonly connect: ForwardConnect = connectLoopback,
  ) {}

  get count(): number {
    return this.streams.size;
  }

  /** `forward.open`: a stream to `port`, answered with `forward.opened` or `forward.closed`. */
  open(id: string, port: number): void {
    this.close(id);
    if (this.streams.size >= FORWARD_STREAMS_MAX) return this.send({ type: "forward.closed", id, reason: "failed" });
    this.dial(id, port, 0);
  }

  /** `forward.data`: the client's bytes for the stream. Unknown streams are ignored (it may have just closed). */
  data(id: string, base64: string): void {
    const stream = this.streams.get(id);
    if (!stream) return;
    const bytes = Buffer.from(base64, "base64");
    if (stream.open) stream.socket.write(bytes);
    else stream.pending.push(bytes);
  }

  /** `forward.close`: ends the stream from the client's side, with nothing more sent for it. */
  close(id: string): void {
    const stream = this.streams.get(id);
    if (!stream) return;
    this.streams.delete(id);
    stream.socket.destroy();
  }

  /** The connection ended: every stream goes. */
  closeAll(): void {
    for (const id of [...this.streams.keys()]) this.close(id);
  }

  private dial(id: string, port: number, hostIndex: number): void {
    const socket = this.connect(HOSTS[hostIndex] as string, port);
    const stream: Stream = { socket, open: false, pending: [] };
    this.streams.set(id, stream);
    const mine = () => this.streams.get(id) === stream;
    socket.on("connect", () => {
      if (!mine()) return socket.destroy();
      stream.open = true;
      this.send({ type: "forward.opened", id });
      for (const bytes of stream.pending) socket.write(bytes);
      stream.pending = [];
    });
    socket.on("data", (data) => {
      if (!mine()) return;
      for (let at = 0; at < data.length; at += FORWARD_DATA_MAX_BYTES) {
        this.send({ type: "forward.data", id, data: data.subarray(at, at + FORWARD_DATA_MAX_BYTES).toString("base64") });
      }
    });
    socket.on("error", (error) => {
      if (!mine()) return;
      // Nothing on 127.0.0.1: try ::1 before saying the port is refused.
      if (!stream.open && error.code === "ECONNREFUSED" && hostIndex + 1 < HOSTS.length) {
        this.streams.delete(id);
        socket.destroy();
        return this.dial(id, port, hostIndex + 1);
      }
      this.streams.delete(id);
      socket.destroy();
      const refused = !stream.open && (error.code === "ECONNREFUSED" || error.code === "EADDRNOTAVAIL");
      this.send({ type: "forward.closed", id, reason: refused ? "refused" : "failed" });
    });
    socket.on("close", () => {
      if (!mine()) return;
      this.streams.delete(id);
      this.send({ type: "forward.closed", id, reason: "ended" });
    });
  }
}
