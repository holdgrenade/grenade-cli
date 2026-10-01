/**
 * One instance per WebSocket connection. Transport-agnostic: the server feeds it
 * raw messages and gives it an `out` callback, which keeps it unit-testable.
 */
import { ATTACHMENT_MAX_BYTES, type ActivityEntry, type ActivityFrame, CLOSE_UNAUTHORIZED, type ClientFrame, type ClientInfo, type DaemonFrame, type DaemonInfo, type ErrorCode, type GroupsFrame, type KeyName, PROTOCOL_VERSION, type PromptClosedFrame, type PromptDecision, type PromptFrame, type PushRegisterFrame, type PushStateFrame, type Session, parseClientFrame } from "@grenade/protocol";
import type { HistoryFrame, ScreenFrame } from "../frames.js";
import type { Logger } from "../log.js";
import type { AttachmentStore } from "../attachments/attachmentStore.js";
import type { Route } from "./devices.js";
import { BadCwdError, SessionExistsError, UnknownGroupError, UnknownSessionError } from "../sessions/registry.js";

export const HELLO_TIMEOUT_MS = 5000;
/** What a daemon that sends no pushes answers to `push.register`. */
const NO_PUSH: PushStateFrame = { type: "push.state", registered: false, delivery: "off", events: [] };
/** What a phone that predates the encrypted local network is told (PROTOCOL.md "Older clients and daemons"). */
export const PLAIN_REFUSED = "This Mac only accepts encrypted connections. Update Grenade on your phone.";
/** What a `pair` outside the encrypted channel is told (PROTOCOL.md "Pairing inside the encrypted channel"). */
export const PAIR_NEEDS_ENCRYPTION = "Pairing needs the encrypted connection. Update Grenade on your phone.";

/** What became of a `pair`: a token for the phone, or why not. */
export type PairVerdict = { ok: true; token: string } | { ok: false; code: "invalid_code" | "too_many_attempts" };

/** The slice of SessionRegistry a connection needs. Tests pass a fake. */
export interface RegistryPort {
  list(): Session[];
  get(id: string): Session | undefined;
  screenOf(id: string): ScreenFrame | undefined;
  subscribe(id: string): void;
  unsubscribe(id: string): void;
  sendText(id: string, text: string, submit: boolean): Promise<void>;
  sendKey(id: string, key: KeyName): Promise<void>;
  resize(id: string, cols: number, rows?: number): Promise<void>;
  history(id: string, before: number, count: number): Promise<HistoryFrame>;
  seen(id: string): void;
  create(input: { name: string; cwd: string; agent: Session["agent"]; group?: string | undefined }): Promise<Session>;
  setGroup(id: string, group: string | null, index?: number): Session;
  kill(id: string): Promise<void>;
  on(event: "updated", cb: (s: Session) => void): unknown;
  on(event: "removed", cb: (id: string) => void): unknown;
  on(event: "screen", cb: (f: ScreenFrame) => void): unknown;
  off(event: "updated", cb: (s: Session) => void): unknown;
  off(event: "removed", cb: (id: string) => void): unknown;
  off(event: "screen", cb: (f: ScreenFrame) => void): unknown;
}

/** The slice of PromptStore a connection needs. */
export interface PromptsPort {
  list(): PromptFrame[];
  answer(sessionId: string, promptId: string, decision: PromptDecision): "answered" | "elsewhere" | { error: string };
  on(event: "opened", cb: (f: PromptFrame) => void): unknown;
  on(event: "closed", cb: (f: PromptClosedFrame) => void): unknown;
  off(event: "opened", cb: (f: PromptFrame) => void): unknown;
  off(event: "closed", cb: (f: PromptClosedFrame) => void): unknown;
}

/** The slice of ActivityStore a connection needs (PROTOCOL.md "Activity"). */
export interface ActivityPort {
  entriesOf(id: string): ActivityEntry[];
  on(event: "activity", cb: (f: ActivityFrame) => void): unknown;
  off(event: "activity", cb: (f: ActivityFrame) => void): unknown;
}

/** The slice of GroupOrderStore a connection needs (PROTOCOL.md "Group order"). */
export interface GroupsPort {
  frame(): GroupsFrame;
  move(group: string, index: number): boolean;
  on(event: "changed", cb: (f: GroupsFrame) => void): unknown;
  off(event: "changed", cb: (f: GroupsFrame) => void): unknown;
}

export interface ConnectionDeps {
  registry: RegistryPort;
  /** Where `attachment` uploads are written (PROTOCOL.md "Attachments"). */
  attachments: AttachmentStore;
  isValidToken(token: string): boolean;
  /** The frames of this connection travel in an encrypted channel (always through a relay; on the LAN after the handshake). */
  sealed: boolean;
  route: Route;
  /** Asked when `sealed` is false: may a `hello` with this token come in plain? Absent means no. */
  acceptsPlain?(token: string): boolean;
  /** The phone said `hello` with a valid token. */
  onHello?(connection: Connection, token: string, client: ClientInfo): void;
  /** A connection that had said `hello` ended. */
  onEnd?(connection: Connection, token: string): void;
  /** A phone sent `pair` with a code or a secret: check it and issue a token. Absent means nobody can pair here. */
  pair?(credential: string, client: ClientInfo, route: Route): PairVerdict;
  /** The phone sent `unpair`: delete its token and close its other connections. */
  unpair?(token: string): void;
  /** Push notifications for the phone behind a token (PROTOCOL.md "Push notifications"). Absent means this daemon sends none. */
  push?: {
    register(token: string, frame: PushRegisterFrame): PushStateFrame;
    unregister(token: string): PushStateFrame;
    /** Hands `send` a new `push.state` when the Mac starts or stops sending pushes. Returns how to stop. */
    watch?(token: string, send: (state: PushStateFrame) => void): () => void;
  };
  /** Prompts the agent is showing (PROTOCOL.md "Prompts"). Absent means this daemon has none to offer. */
  prompts?: PromptsPort;
  /** What the agent said and was asked (PROTOCOL.md "Activity"). Absent means this daemon sends none. */
  activity?: ActivityPort;
  /** The order groups are listed in. Absent means this daemon keeps none and answers `group.move` with `bad_frame`. */
  groups?: GroupsPort;
  daemon: DaemonInfo;
  log: Logger;
  out(frame: DaemonFrame): void;
  close(code: number, reason: string): void;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
}

export class Connection {
  private authed = false;
  /** The token of the `hello`, once it was accepted. */
  private token: string | null = null;
  /** Set when the pairing behind this connection ended; frames that still arrive are ignored. */
  private over = false;
  private readonly subscriptions = new Set<string>();
  private stopWatchingPush: (() => void) | undefined;
  private helloTimer: unknown;
  private readonly onUpdated = (s: Session) => this.send({ type: "session.updated", session: s });
  private readonly onRemoved = (id: string) => {
    this.subscriptions.delete(id);
    this.send({ type: "session.removed", sessionId: id });
  };
  private readonly onScreen = (f: ScreenFrame) => {
    if (this.subscriptions.has(f.sessionId)) this.send(f);
  };
  private readonly onGroups = (f: GroupsFrame) => this.send(f);
  private readonly onPrompt = (f: PromptFrame | PromptClosedFrame) => this.send(f);
  private readonly onActivity = (f: ActivityFrame) => {
    if (this.subscriptions.has(f.sessionId)) this.send(f);
  };

  constructor(private readonly d: ConnectionDeps) {
    this.helloTimer = this.startHelloTimer();
  }

  private startHelloTimer(): unknown {
    const setTimer = this.d.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    return setTimer(() => {
      if (!this.authed) this.fail("unauthorized", "no hello within 5s", undefined, true);
    }, HELLO_TIMEOUT_MS);
  }

  get route(): Route {
    return this.d.route;
  }

  /** The pairing was ended on the Mac: tell the phone, which then forgets this Mac, and close. */
  revoked(message: string): void {
    if (!this.authed || this.over) return;
    this.over = true;
    this.fail("unauthorized", message, undefined, true);
  }

  /** Feed one raw text frame from the socket. */
  async handleMessage(raw: string): Promise<void> {
    if (this.over) return;
    const parsed = parseClientFrame(raw);
    if (!parsed.ok) return this.fail("bad_frame", parsed.message);
    const frame = parsed.frame;
    if (frame.type === "pair") return this.handlePair(frame);
    if (!this.authed) return this.handleHello(frame);
    try {
      await this.dispatch(frame);
    } catch (e) {
      if (e instanceof UnknownSessionError) return this.fail("unknown_session", e.message, frame.type);
      if (e instanceof SessionExistsError) return this.fail("tmux_failed", e.message, frame.type);
      if (e instanceof BadCwdError || e instanceof UnknownGroupError) return this.fail("bad_frame", e.message, frame.type);
      const msg = e instanceof Error ? e.message : String(e);
      // The tmux session ended before the 1 s sweep marked it gone; the phone just needs to know.
      if (/can't find session/i.test(msg)) {
        this.d.log.debug(`Ignored ${frame.type}: session has ended`, { error: msg });
        return this.fail("unknown_session", msg, frame.type);
      }
      this.d.log.error(`Could not handle ${frame.type} from phone`, { error: msg });
      this.fail(/tmux/i.test(msg) ? "tmux_failed" : "internal", msg, frame.type);
    }
  }

  /** The socket closed; drop subscriptions and listeners. */
  handleClose(): void {
    (this.d.clearTimer ?? ((t) => clearTimeout(t as NodeJS.Timeout)))(this.helloTimer);
    for (const id of this.subscriptions) this.d.registry.unsubscribe(id);
    this.subscriptions.clear();
    if (this.authed) {
      this.d.registry.off("updated", this.onUpdated);
      this.d.registry.off("removed", this.onRemoved);
      this.d.registry.off("screen", this.onScreen);
      this.d.prompts?.off("opened", this.onPrompt);
      this.d.prompts?.off("closed", this.onPrompt);
      this.d.activity?.off("activity", this.onActivity);
      this.d.groups?.off("changed", this.onGroups);
      this.authed = false;
      this.stopWatchingPush?.();
      if (this.token) this.d.onEnd?.(this, this.token);
    }
  }

  /** A phone that is not paired yet (or pairs again): a good code or secret gets it a token, and `hello` comes next. */
  private handlePair(frame: Extract<ClientFrame, { type: "pair" }>): void {
    if (frame.protocol !== PROTOCOL_VERSION) return this.fail("unsupported_protocol", `daemon speaks protocol ${PROTOCOL_VERSION}`, "pair", true);
    // The secret and the token it buys must not cross a network in the clear. Not counted as a failed try.
    if (!this.d.sealed) return this.fail("unsupported_protocol", PAIR_NEEDS_ENCRYPTION, "pair");
    const verdict = this.d.pair?.(frame.secret ?? frame.code ?? "", frame.client, this.d.route) ?? { ok: false, code: "invalid_code" };
    if (!verdict.ok) {
      const message = verdict.code === "invalid_code" ? "that code is wrong or has expired; run `grenade pair` again" : "too many tries; run `grenade pair` for a new code";
      return this.fail(verdict.code, message, "pair", verdict.code === "too_many_attempts");
    }
    if (!this.authed) {
      (this.d.clearTimer ?? ((t) => clearTimeout(t as NodeJS.Timeout)))(this.helloTimer);
      this.helloTimer = this.startHelloTimer();
    }
    this.send({ type: "paired", token: verdict.token, daemon: this.d.daemon });
  }

  private handleHello(frame: ClientFrame): void {
    if (frame.type !== "hello") return this.fail("unauthorized", "hello first", frame.type, true);
    if (frame.protocol !== PROTOCOL_VERSION) return this.fail("unsupported_protocol", `daemon speaks protocol ${PROTOCOL_VERSION}`, "hello", true);
    if (!this.d.isValidToken(frame.token)) return this.fail("unauthorized", "unknown token", "hello", true);
    // Not `unauthorized`: that would make the phone forget this Mac, and all it needs is an update.
    if (!this.d.sealed && this.d.acceptsPlain?.(frame.token) !== true) return this.fail("unsupported_protocol", PLAIN_REFUSED, "hello", true);
    this.authed = true;
    this.token = frame.token;
    this.d.onHello?.(this, frame.token, frame.client);
    this.stopWatchingPush = this.d.push?.watch?.(frame.token, (state) => this.send(state));
    (this.d.clearTimer ?? ((t) => clearTimeout(t as NodeJS.Timeout)))(this.helloTimer);
    this.d.registry.on("updated", this.onUpdated);
    this.d.registry.on("removed", this.onRemoved);
    this.d.registry.on("screen", this.onScreen);
    this.d.log.info(`Phone connected: ${frame.client.name}`, { platform: frame.client.platform });
    this.send({ type: "welcome", protocol: PROTOCOL_VERSION, daemon: this.d.daemon });
    this.send({ type: "sessions", sessions: this.d.registry.list() });
    if (this.d.groups) {
      this.send(this.d.groups.frame());
      this.d.groups.on("changed", this.onGroups);
    }
    this.d.prompts?.on("opened", this.onPrompt);
    this.d.prompts?.on("closed", this.onPrompt);
    for (const open of this.d.prompts?.list() ?? []) this.send(open);
    this.d.activity?.on("activity", this.onActivity);
  }

  private async dispatch(frame: ClientFrame): Promise<void> {
    const r = this.d.registry;
    switch (frame.type) {
      case "hello":
        return; // already authed; ignore repeats
      case "ping":
        return this.send({ type: "pong", t: frame.t });
      case "unpair":
        this.over = true;
        if (this.token) this.d.unpair?.(this.token);
        this.d.log.info("A phone unpaired itself");
        this.send({ type: "unpaired" });
        return this.d.close(CLOSE_UNAUTHORIZED, "unpaired");
      case "subscribe": {
        this.requireSession(frame.sessionId);
        if (!this.subscriptions.has(frame.sessionId)) {
          this.subscriptions.add(frame.sessionId);
          r.subscribe(frame.sessionId);
        }
        const cached = r.screenOf(frame.sessionId);
        if (cached) this.send(cached);
        // Only Claude Code has a transcript to read; the phone hides the plain view for the others.
        if (this.d.activity && r.get(frame.sessionId)?.agent === "claude") {
          this.send({ type: "activity", sessionId: frame.sessionId, entries: this.d.activity.entriesOf(frame.sessionId), full: true });
        }
        return;
      }
      case "unsubscribe":
        if (this.subscriptions.delete(frame.sessionId)) r.unsubscribe(frame.sessionId);
        return;
      case "input":
        return r.sendText(frame.sessionId, frame.text, frame.submit);
      case "key":
        return r.sendKey(frame.sessionId, frame.key);
      case "resize":
        return r.resize(frame.sessionId, frame.cols, frame.rows);
      case "history":
        return this.send(await r.history(frame.sessionId, frame.before, frame.count));
      case "seen":
        return r.seen(frame.sessionId);
      case "session.create":
        await r.create({ name: frame.name, cwd: frame.cwd, agent: frame.agent, group: frame.group });
        return this.send({ type: "sessions", sessions: r.list() });
      case "session.group": {
        // The registry emits session.updated when the group or order changes; a no-op move still gets an answer.
        const before = r.get(frame.sessionId);
        const after = r.setGroup(frame.sessionId, frame.group, frame.index);
        if (after.group === before?.group && after.order === before?.order) this.send({ type: "session.updated", session: after });
        return;
      }
      case "group.move":
        if (!this.d.groups) return this.fail("bad_frame", "this daemon keeps no group order", frame.type);
        // A change reaches every client through `changed`; a move to where it already is still gets an answer.
        if (!this.d.groups.move(frame.group, frame.index)) this.send(this.d.groups.frame());
        return;
      case "session.kill":
        return r.kill(frame.sessionId);
      case "push.register":
        return this.send((this.token && this.d.push?.register(this.token, frame)) || NO_PUSH);
      case "push.unregister":
        return this.send((this.token && this.d.push?.unregister(this.token)) || NO_PUSH);
      case "prompt.answer": {
        const outcome = this.d.prompts?.answer(frame.sessionId, frame.promptId, frame) ?? "elsewhere";
        if (typeof outcome === "object") return this.fail("bad_frame", outcome.error, frame.type);
        // A used answer reaches every client through the store. This one came too late.
        if (outcome === "elsewhere") this.send({ type: "prompt.closed", sessionId: frame.sessionId, promptId: frame.promptId, reason: "elsewhere" });
        return;
      }
      case "attachment": {
        this.requireSession(frame.sessionId);
        const data = Buffer.from(frame.data, "base64");
        if (data.length > ATTACHMENT_MAX_BYTES) return this.fail("bad_frame", `attachment is larger than ${ATTACHMENT_MAX_BYTES} bytes`, frame.type);
        const saved = await this.d.attachments.save(frame.sessionId, frame.name, frame.mime, data);
        this.d.log.info("Saved an attachment from the phone", { session: frame.sessionId, path: saved.path, bytes: saved.bytes });
        return this.send({ type: "attachment.saved", id: frame.id, sessionId: frame.sessionId, path: saved.path, bytes: saved.bytes });
      }
    }
  }

  private requireSession(id: string): void {
    if (!this.d.registry.get(id)) throw new UnknownSessionError(`no session ${id}`);
  }

  private send(frame: DaemonFrame): void {
    this.d.out(frame);
  }

  private fail(code: ErrorCode, message: string, ref?: string, closeAfter = false): void {
    this.send(ref === undefined ? { type: "error", code, message } : { type: "error", code, message, ref });
    if (closeAfter) this.d.close(CLOSE_UNAUTHORIZED, code);
  }
}
