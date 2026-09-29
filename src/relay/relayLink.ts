/**
 * The daemon's link to a relay (PROTOCOL.md "Daemon link"): registers, keeps presence fresh, and routes
 * each phone `conn` to its own `PhonePipe`. Pings every 15 s, drops a link that has not ponged in 30 s,
 * and reconnects with backoff. Knows nothing about sessions: `openPipe` builds whatever serves a phone.
 */
import {
  RELAY_DAEMON_PATH,
  RELAY_PROTOCOL_VERSION,
  parseRelayServerFrame,
  type RelayDaemonFrame,
  type RelayErrorCode,
  type RelayServerFrame,
} from "@grenade/protocol";
import WebSocket from "ws";
import type { Logger } from "../log.js";
import { relayWsUrl, type RelayConfig } from "./relayConfig.js";

export type RelayState = "off" | "connecting" | "online" | "error";

export interface RelayStatus {
  state: RelayState;
  url?: string;
  id?: string;
  /** ISO time the link last came online, while online. */
  since?: string;
  publicIp?: string;
  localIps?: string[];
  lastError?: string;
  /** Phones piped through the relay right now. */
  phones: number;
  /** The daemon runs with `--no-relay`. */
  disabled?: boolean;
}

/** What the link drives for one phone. `PhonePipe` in production. */
export interface RelayPipe {
  handleData(text: string): void;
  handleClose(): void;
}

export interface RelayLinkDeps {
  config: RelayConfig;
  name: string;
  version: string;
  accessHashes(): string[];
  localIps(): string[];
  openPipe(conn: string, send: (frame: RelayDaemonFrame) => void, onEnd: () => void): RelayPipe;
  log: Logger;
  now?: () => number;
  pingMs?: number;
  deadAfterMs?: number;
  ipCheckMs?: number;
  backoffMs?: number[];
  refusedRetryMs?: number;
}

const BACKOFF_MS = [1000, 2000, 5000, 10_000, 30_000];

export class RelayLink {
  private ws: WebSocket | null = null;
  private state: RelayState = "off";
  private since: string | undefined;
  private publicIp: string | undefined;
  private lastError: string | undefined;
  private refused: RelayErrorCode | null = null;
  private warnedRefused: RelayErrorCode | null = null;
  private attempt = 0;
  private stopped = true;
  private lastPong = 0;
  private sentIps: string[] = [];
  private readonly pipes = new Map<string, RelayPipe>();
  private timers: NodeJS.Timeout[] = [];
  private retry: NodeJS.Timeout | null = null;
  private readonly now: () => number;

  constructor(private readonly d: RelayLinkDeps) {
    this.now = d.now ?? Date.now;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
    const ws = this.ws;
    this.teardown();
    ws?.close(1001, "daemon stopping");
    this.state = "off";
  }

  status(): RelayStatus {
    const s: RelayStatus = { state: this.state, url: this.d.config.url, id: this.d.config.id, phones: this.pipes.size, localIps: this.d.localIps() };
    if (this.state === "online" && this.since) s.since = this.since;
    if (this.publicIp) s.publicIp = this.publicIp;
    if (this.lastError) s.lastError = this.lastError;
    return s;
  }

  get id(): string {
    return this.d.config.id;
  }

  /** Stops for good, as `stop`, but first empties this Mac's access list there so the relay admits none of its phones. */
  leave(): void {
    const ws = this.ws;
    if (this.state !== "online" || !ws) return this.stop();
    this.send({ type: "update", access: [] });
    // A clean close goes out after the update; `dropped` then finishes the job. Do not wait for it forever.
    this.stopped = true;
    ws.close(1001, "daemon leaving");
    setTimeout(() => {
      if (this.ws === ws) this.stop();
    }, 2000).unref();
  }

  /** A phone was paired or unpaired: the relay admits exactly the phones in the list. */
  tokensChanged(): void {
    if (this.state === "online") this.send({ type: "update", access: this.d.accessHashes() });
  }

  // ---- lifecycle ------------------------------------------------------------

  private connect(): void {
    this.state = this.refused ? "error" : "connecting";
    const headers: Record<string, string> = this.d.config.key ? { authorization: `Bearer ${this.d.config.key}` } : {};
    const ws = new WebSocket(relayWsUrl(this.d.config.url, RELAY_DAEMON_PATH), { headers, maxPayload: 16 * 1024 * 1024, handshakeTimeout: 10_000 });
    this.ws = ws;
    ws.on("open", () => this.register());
    ws.on("message", (data) => this.handle(data.toString()));
    ws.on("pong", () => (this.lastPong = this.now()));
    ws.on("error", (e) => {
      this.lastError = e.message;
      // An upgrade refused with 401/403 means the registration key is wrong or missing.
      if (/\b(401|403)\b/.test(e.message)) this.refuse("unauthorized", "the relay needs a registration key (or a different one)");
      this.d.log.debug("Relay link error", { url: this.d.config.url, error: e.message });
    });
    ws.on("close", () => {
      if (this.ws === ws) this.dropped();
    });
  }

  private register(): void {
    this.lastPong = this.now();
    this.sentIps = this.d.localIps();
    this.send({
      type: "register",
      protocol: RELAY_PROTOCOL_VERSION,
      id: this.d.config.id,
      secret: this.d.config.secret,
      name: this.d.name.slice(0, 100),
      version: this.d.version,
      localIps: this.sentIps,
      access: this.d.accessHashes(),
    });
    this.timers.push(setInterval(() => this.heartbeat(), this.d.pingMs ?? 15_000));
    this.timers.push(setInterval(() => this.checkIps(), this.d.ipCheckMs ?? 10_000));
  }

  private heartbeat(): void {
    if (!this.ws) return;
    if (this.now() - this.lastPong > (this.d.deadAfterMs ?? 30_000)) {
      this.d.log.debug("Relay link went quiet; dropping it", { url: this.d.config.url });
      this.ws.terminate();
      return;
    }
    this.ws.ping();
  }

  private checkIps(): void {
    if (this.state !== "online") return;
    const ips = this.d.localIps();
    if (ips.join(",") === this.sentIps.join(",")) return;
    this.sentIps = ips;
    this.send({ type: "update", localIps: ips });
  }

  private dropped(): void {
    const wasOnline = this.state === "online";
    this.teardown();
    if (wasOnline) this.d.log.info("Relay is offline; reconnecting", { url: this.d.config.url });
    if (this.stopped) {
      this.state = "off";
      return;
    }
    this.state = this.refused ? "error" : "connecting";
    const backoff = this.d.backoffMs ?? BACKOFF_MS;
    const delay = this.refused ? (this.d.refusedRetryMs ?? 60_000) : (backoff[Math.min(this.attempt, backoff.length - 1)] ?? 30_000);
    this.attempt++;
    this.retry = setTimeout(() => {
      this.retry = null;
      if (!this.stopped) this.connect();
    }, delay);
  }

  private teardown(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    for (const p of this.pipes.values()) p.handleClose();
    this.pipes.clear();
    this.since = undefined;
    const ws = this.ws;
    this.ws = null;
    ws?.removeAllListeners("message");
    ws?.on("error", () => {});
    if (ws && ws.readyState !== WebSocket.CLOSED && ws.readyState !== WebSocket.CLOSING) ws.terminate();
  }

  // ---- frames ---------------------------------------------------------------

  private handle(raw: string): void {
    const parsed = parseRelayServerFrame(raw);
    if (!parsed.ok) return this.d.log.debug("Ignored a bad frame from the relay", { error: parsed.message });
    const f: RelayServerFrame = parsed.frame;
    switch (f.type) {
      case "registered":
        this.state = "online";
        this.since = new Date(this.now()).toISOString();
        this.attempt = 0;
        this.refused = null;
        this.warnedRefused = null;
        this.lastError = undefined;
        this.publicIp = f.publicIp;
        this.d.log.info("Relay is online: phones can reach this Mac from anywhere", { url: this.d.config.url, publicIp: f.publicIp });
        return;
      case "error":
        this.lastError = f.message;
        if (f.code === "unauthorized" || f.code === "id_taken") this.refuse(f.code, f.message);
        else this.d.log.warn("The relay rejected a frame", { code: f.code, message: f.message });
        return;
      case "open": {
        const pipe = this.d.openPipe(f.conn, (frame) => this.send(frame), () => {
          if (this.pipes.get(f.conn) === pipe) this.pipes.delete(f.conn);
          this.d.log.info("A phone left the relay pipe", { conn: f.conn });
        });
        this.pipes.set(f.conn, pipe);
        this.d.log.info("A phone opened a pipe through the relay", { conn: f.conn, ip: f.ip });
        return;
      }
      case "data":
        this.pipes.get(f.conn)?.handleData(f.text);
        return;
      case "close":
        this.pipes.get(f.conn)?.handleClose();
        this.pipes.delete(f.conn);
        return;
    }
  }

  private refuse(code: RelayErrorCode, message: string): void {
    this.refused = code;
    this.state = "error";
    this.lastError = message;
    if (this.warnedRefused === code) return;
    this.warnedRefused = code;
    const fix =
      code === "unauthorized"
        ? "Set the relay's registration key: grenade relay on <url> --key <key>"
        : "Another Mac holds this relay id. Get a new one: grenade relay off && grenade relay on <url>";
    this.d.log.warn(`The relay refused this Mac (${message}). ${fix}`, { url: this.d.config.url, code });
  }

  private send(frame: RelayDaemonFrame): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    if (frame.type !== "data") this.d.log.debug("Relay frame out", { type: frame.type });
    this.ws.send(JSON.stringify(frame));
  }
}
