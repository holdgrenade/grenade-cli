/**
 * One instance per WebSocket connection. Transport-agnostic: the server feeds it
 * raw messages and gives it an `out` callback, which keeps it unit-testable.
 */
import { computerWord } from "../platform/computer.js";
import { listFolders } from "../folders/listFolders.js";
import { agentInfo } from "../agents/agentCatalog.js";
import { ATTACHMENT_MAX_BYTES, type ActivityEntry, type ActivityFrame, activityFor, CLOSE_UNAUTHORIZED, type ClientFrame, type ClientInfo, type Conversation, type DaemonFrame, type DaemonInfo, type ErrorCode, type GroupsFrame, type KeyName, PROTOCOL_VERSION, type PromptClosedFrame, type PromptDecision, type PromptFrame, type PushRegisterFrame, type PushStateFrame, type BoardRegisterFrame, type BoardStateFrame, type Session, parseClientFrame, sessionFor } from "@grenade/protocol";
import type { HistoryFrame, ScreenFrame } from "../frames.js";
import type { Logger } from "../log.js";
import type { AttachmentStore } from "../attachments/attachmentStore.js";
import type { Route } from "./devices.js";
import { SentInputs } from "./sentInputs.js";
import { isInterrupt } from "../tmux/termPaint.js";
import { BadCwdError, SessionExistsError, UnknownGroupError, UnknownSessionError } from "../sessions/registry.js";
import { modelChoiceProblem, switchTimingProblem } from "../models/modelChoice.js";
import { ModelSwitchError } from "../models/claudeModelSwitch.js";
import type { PlanLimit, VoiceFrame } from "@grenade/protocol";
import { VoiceError, type MintedToken } from "../voice/voiceProvider.js";
import { CANVAS_SUBSCRIPTIONS_MAX, type CanvasFrame, type CanvasInfo } from "@grenade/protocol";
import { CanvasError, type CanvasPick, type CanvasReply } from "../canvas/canvasService.js";
import { boardTooLarge } from "../canvas/boardListing.js";
import type { PublishedLink, PublishExpiry, PublishScope } from "@grenade/protocol";
import { PublishError } from "../publish/publisher.js";
import type { CommentsFrame } from "@grenade/protocol";
import { CommentError } from "../publish/comments.js";
import type { TalkEntry, TalkThreadFrame } from "@grenade/protocol";
import { PLAN_SUBSCRIPTIONS_MAX, type PlanFrame } from "@grenade/protocol";
import { PlanWriteError } from "../plans/planTracker.js";
import { PlanModeError } from "../plans/claudePlanMode.js";

export const HELLO_TIMEOUT_MS = 5000;
/** What a daemon that sends no pushes answers to `push.register`. */
const NO_PUSH: PushStateFrame = { type: "push.state", registered: false, delivery: "off", events: [] };
/** What a daemon that keeps no Mac board answers to `board.register`. */
const NO_BOARD: BoardStateFrame = { type: "board.state", registered: false, delivery: "off" };
/** What a phone that predates the encrypted local network is told (PROTOCOL.md "Older clients and daemons"). */
export const PLAIN_REFUSED = `This ${computerWord()} only accepts encrypted connections. Update Grenade on your phone.`;
/** What a `pair` outside the encrypted channel is told (PROTOCOL.md "Pairing inside the encrypted channel"). */
export const PAIR_NEEDS_ENCRYPTION = "Pairing needs the encrypted connection. Update Grenade on your phone.";

/** What became of a `pair`: a token for the phone, or why not. */
export type PairVerdict = { ok: true; token: string } | { ok: false; code: "invalid_code" | "too_many_attempts"; pausedUntil?: number; message?: string };

/** The slice of SessionRegistry a connection needs. Tests pass a fake. */
export interface RegistryPort {
  list(): Session[];
  get(id: string): Session | undefined;
  screenOf(id: string): ScreenFrame | undefined;
  subscribe(id: string): void;
  unsubscribe(id: string): void;
  sendText(id: string, text: string, submit: boolean): Promise<void>;
  sendKey(id: string, key: KeyName): Promise<void>;
  resize(id: string, cols: number, rows: number | undefined, by: object): Promise<void>;
  releaseSize(id: string, by: object): Promise<void>;
  history(id: string, before: number, count: number): Promise<HistoryFrame>;
  seen(id: string): void;
  create(input: { name: string; cwd: string; agent: Session["agent"]; group?: string | undefined }): Promise<Session>;
  setGroup(id: string, group: string | null, index?: number): Session;
  renameGroup(group: string, name: string | null): { session: Session; changed: boolean };
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

/** Past conversations of every agent that keeps them (PROTOCOL.md "Conversations"). */
export interface ConversationsPort {
  /** `anyAgent: false` lists only what apps from before `Conversation.agent` can resume. */
  list(anyAgent: boolean): Promise<Conversation[]>;
  /** Null when there is no conversation with that id. */
  preview(id: string): Promise<ActivityEntry[] | null>;
  /** Moves a conversation to the Trash. Resolves with why it was refused, or null when it is gone. */
  delete(id: string): Promise<string | null>;
  /** Starts a session that runs a copy of the conversation, its history already read. Resolves with why not, as text, when there is no such conversation of that agent. */
  resume(input: { name: string; agent: string; group?: string | undefined; conversationId: string }): Promise<Session | string>;
}

/** One client's live terminal on one session (PROTOCOL.md "Live terminal"); `TermStream` in the daemon. */
export interface TermHandle {
  input(bytes: Buffer): void;
  resize(cols: number, rows: number): void;
  close(): void;
}

/** What a live terminal needs from the connection that opened it. */
export interface TermOpen {
  sessionId: string;
  cols: number;
  rows: number;
  output(data: Buffer, reset: boolean): void;
  closed(reason: "ended" | "failed"): void;
}

/** The slice of GroupOrderStore a connection needs (PROTOCOL.md "Group order"). */
export interface GroupsPort {
  frame(): GroupsFrame;
  move(group: string, index: number): boolean;
  on(event: "changed", cb: (f: GroupsFrame) => void): unknown;
  off(event: "changed", cb: (f: GroupsFrame) => void): unknown;
}

/** Switches a session's agent to another model, for that session only (PROTOCOL.md "Models"). */
export interface ModelsPort {
  /** Resolves with the session once the agent has switched; rejects with `ModelSwitchError` when it did not. */
  switch(session: Session, model: string, effort: string | undefined): Promise<Session>;
}

/** The owner's voice provider keys and the tokens made with them (PROTOCOL.md "Voice providers"); `VoiceService` in the daemon. */
export interface VoicePort {
  frame(): VoiceFrame;
  /** Resolves with whether anything changed; rejects with `VoiceError`. */
  setKey(provider: string, key: string | null): Promise<boolean>;
  /** Rejects with `VoiceError`. */
  token(provider: string, use: string, model: string | undefined): Promise<MintedToken>;
  on(event: "changed", cb: (f: VoiceFrame) => void): unknown;
  off(event: "changed", cb: (f: VoiceFrame) => void): unknown;
}

/** A group's design canvas (PROTOCOL.md "Canvas"); `CanvasService` in the daemon. Each call rejects with `CanvasError` for a folder or a board it does not serve. */
export interface CanvasPort {
  canvases(cwd: string, group: string): Promise<{ folder: string; canvases: CanvasInfo[] }>;
  list(pick: CanvasPick): Promise<CanvasReply>;
  board(pick: CanvasPick, file: string): Promise<{ html: string; modified: string; bytes: number }>;
  watch(pick: CanvasPick, onChange: (reply: CanvasReply) => void): Promise<{ reply: CanvasReply; stop: () => void }>;
}

/** Canvases published to secret links (PROTOCOL.md "Publishing"); `Publisher` in the daemon. Changes reject with `PublishError`. */
export interface PublishPort {
  list(): PublishedLink[];
  publishCanvas(pick: CanvasPick, scope: PublishScope, expiry?: PublishExpiry, newLink?: boolean, token?: string): Promise<PublishedLink[]>;
  /** A session's plan (PROTOCOL.md "Plans"). */
  publishPlan(sessionId: string, expiry?: PublishExpiry, newLink?: boolean): Promise<PublishedLink[]>;
  remove(token: string): Promise<PublishedLink[]>;
  on(event: "changed", cb: (links: PublishedLink[]) => void): unknown;
  off(event: "changed", cb: (links: PublishedLink[]) => void): unknown;
}

/** Comments on published links (PROTOCOL.md "Comments"); `CommentService` in the daemon. Changes reject with `CommentError`. */
export interface CommentsPort {
  frame(token: string, id?: string): CommentsFrame;
  watch(token: string): () => void;
  reply(token: string, thread: string, text: string): Promise<CommentsFrame>;
  resolve(token: string, thread: string, resolved: boolean): Promise<CommentsFrame>;
  seen(token: string, thread: string): void;
  on(event: "changed", cb: (frame: CommentsFrame) => void): unknown;
  off(event: "changed", cb: (frame: CommentsFrame) => void): unknown;
}

/** The owner's name (PROTOCOL.md "Comments"); `OwnerName` in the daemon. */
export interface OwnerPort {
  readonly name: string;
  set(name: string): string;
  on(event: "changed", cb: (name: string) => void): unknown;
  off(event: "changed", cb: (name: string) => void): unknown;
}

/** Typed Talk, the day's thread answered by an agent on this computer (PROTOCOL.md "Talk by text"); `TalkService` in the daemon. */
export interface TalkPort {
  frame(): TalkThreadFrame;
  /** The owner's words. False when that id was said already. */
  say(id: string, text: string): boolean;
  /** False when that agent cannot answer Talk here. */
  setAgent(agent: string): boolean;
  on(event: "entry", cb: (entry: TalkEntry) => void): unknown;
  on(event: "busy", cb: (busy: boolean) => void): unknown;
  on(event: "thread", cb: (frame: TalkThreadFrame) => void): unknown;
  off(event: "entry", cb: (entry: TalkEntry) => void): unknown;
  off(event: "busy", cb: (busy: boolean) => void): unknown;
  off(event: "thread", cb: (frame: TalkThreadFrame) => void): unknown;
}

/** Sessions' plans (PROTOCOL.md "Plans"); `PlanTracker` in the daemon. */
export interface PlansPort {
  follow(sessionId: string, send: (frame: PlanFrame) => void): () => void;
  /** Rejects with `PlanWriteError` while the agent writes the plan, or when there is no file. */
  write(sessionId: string, text: string): Promise<PlanFrame>;
  /** The plan file's text now, for a plan approved with the user's edits. */
  textOf(sessionId: string): Promise<string | undefined>;
  /** The plan file's path when the user changed it since the agent last wrote it, once. */
  takeEditedPath(sessionId: string): string | undefined;
  /** Switches the session's agent into plan mode. Rejects with `PlanModeError` when it did not switch. */
  enterPlanMode?(sessionId: string): Promise<void>;
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
  /** The phone's Mac board, its Live Activity (PROTOCOL.md "Mac board"). Absent means this daemon keeps none. */
  board?: {
    register(token: string, frame: BoardRegisterFrame): BoardStateFrame;
    unregister(token: string): BoardStateFrame;
  };
  /** Prompts the agent is showing (PROTOCOL.md "Prompts"). Absent means this daemon has none to offer. */
  prompts?: PromptsPort;
  /** What the agent said and was asked (PROTOCOL.md "Activity"). Absent means this daemon sends none. */
  activity?: ActivityPort;
  /** A client pressed a key that interrupts (Esc or Ctrl-C): an interrupt fires no hook, so the transcript is read for it. */
  interrupted?(sessionId: string): void;
  /** Past conversations to list, preview, resume and delete. Absent means this daemon has none (no `conversations: 1`). */
  conversations?: ConversationsPort;
  /** The order groups are listed in. Absent means this daemon keeps none and answers `group.move` with `bad_frame`. */
  groups?: GroupsPort;
  /** Switches a session's model. Absent means this daemon switches none and answers `session.model` with `bad_frame`. */
  models?: ModelsPort;
  /** Voice providers' keys and tokens. Absent means this daemon keeps none (no `voice: 1`) and answers their frames with `bad_frame`. */
  voice?: VoicePort;
  /** Each agent's plan windows (PROTOCOL.md "Usage"). Absent means this daemon reads none and answers `limits` with an empty list. */
  limits?: { list(): PlanLimit[] };
  /** A group's design canvas. Absent means this daemon serves none (no `canvas: 1`) and answers its frames with `bad_frame`. */
  canvas?: CanvasPort;
  /** Canvases published to secret links. Absent means this daemon publishes none (no `publish: 1`) and answers their frames with `bad_frame`. */
  publish?: PublishPort;
  /** Comments on published links. Absent means this daemon pulls none (no `comments: 1`) and answers their frames with `bad_frame`. */
  comments?: CommentsPort;
  /** The owner's name. Absent with `comments`. */
  owner?: OwnerPort;
  /** Sessions' plans. Absent means this daemon shows none (no `plans: 1`) and answers their frames with `bad_frame`. */
  plans?: PlansPort;
  /** Typed Talk. Absent means this daemon answers none (no `talk: 1`) and answers its frames with `bad_frame`. */
  talk?: TalkPort;
  /** Starts a live terminal (PROTOCOL.md "Live terminal"). Absent means this daemon streams none (no `term: 1`). */
  openTerm?(open: TermOpen): TermHandle;
  /** The `input` ids already typed, shared by every connection. Absent: this connection keeps its own. */
  sentInputs?: SentInputs;
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
  /** Who said `hello`: which activity entries it can read (`activityFor`). */
  private client: ClientInfo | null = null;
  /** Set when the pairing behind this connection ended; frames that still arrive are ignored. */
  private over = false;
  private readonly subscriptions = new Set<string>();
  /** The last `conversations` frame asked for every agent's (PROTOCOL.md "Conversations" `anyAgent`). */
  private anyAgentConversations = false;
  /** Live terminals this client has open, by session. */
  private readonly terms = new Map<string, TermHandle>();
  private stopWatchingPush: (() => void) | undefined;
  /** Canvases this client watches, by `cwd`, `group` and `canvas` as it sent them (`watchKey`; PROTOCOL.md "Canvas", "Watching"). */
  private readonly canvasWatches = new Map<string, () => void>();
  /** The plans this connection follows, by session. */
  private readonly planFollows = new Map<string, () => void>();
  private helloTimer: unknown;
  private readonly onUpdated = (s: Session) => this.send({ type: "session.updated", session: s });
  private readonly onRemoved = (id: string) => {
    this.subscriptions.delete(id);
    this.closeTerm(id);
    this.send({ type: "session.removed", sessionId: id });
  };
  private readonly onScreen = (f: ScreenFrame) => {
    if (this.subscriptions.has(f.sessionId)) this.send(f);
  };
  private readonly onGroups = (f: GroupsFrame) => this.send(f);
  /** This client asked for `voice` once, so it hears of every change (PROTOCOL.md "Voice providers"). */
  private watchesVoice = false;
  private readonly onVoice = (f: VoiceFrame) => this.send(f);
  /** This client sent a publish frame once, so it hears of every change to a link (PROTOCOL.md "Publishing"). */
  private watchesPublish = false;
  private readonly onPublished = (links: PublishedLink[]) => this.send({ type: "published", links });
  /** The links whose comments this client follows (PROTOCOL.md "Comments"), each with how to stop. */
  private readonly commentWatches = new Map<string, () => void>();
  private readonly onComments = (f: CommentsFrame) => {
    if (this.commentWatches.has(f.token)) this.send(f);
  };
  /** This client asked for the owner's name once, so it hears of every change. */
  private watchesOwner = false;
  private readonly onOwner = (name: string) => this.send({ type: "owner", name });
  private readonly onPrompt = (f: PromptFrame | PromptClosedFrame) => this.send(f);
  /** This client sent `talk.thread`, so it hears of every new row, of the agent being busy and of a new day or agent. */
  private watchesTalk = false;
  private readonly onTalkEntry = (entry: TalkEntry) => this.send({ type: "talk.entry", entry });
  private readonly onTalkBusy = (busy: boolean) => this.send({ type: "talk.busy", busy });
  private readonly onTalkThread = (frame: TalkThreadFrame) => this.send(frame);
  private readonly onActivity = (f: ActivityFrame) => {
    if (!this.subscriptions.has(f.sessionId)) return;
    const entries = this.entriesFor(f.entries);
    if (entries.length > 0 || f.full) this.send({ ...f, entries });
  };

  private readonly sentInputs: SentInputs;

  constructor(private readonly d: ConnectionDeps) {
    this.sentInputs = d.sentInputs ?? new SentInputs();
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
      // An `input` (or a canvas request, or an `attachment`) with an id gets its id back, so the phone knows which one did not arrive.
      const id = frame.type === "input" || frame.type === "attachment" || frame.type === "canvases" || frame.type === "canvas" || frame.type === "canvas.subscribe" || frame.type === "canvas.board" || frame.type.startsWith("publish.") || frame.type.startsWith("comment") || frame.type === "owner.name" ? (frame as { id?: string }).id : undefined;
      if (e instanceof UnknownSessionError) return this.fail("unknown_session", e.message, frame.type, false, id);
      if (e instanceof SessionExistsError) return this.fail("tmux_failed", e.message, frame.type, false, id);
      if (e instanceof BadCwdError || e instanceof UnknownGroupError) return this.fail("bad_frame", e.message, frame.type, false, id);
      const msg = e instanceof Error ? e.message : String(e);
      // The tmux session ended before the 1 s sweep marked it gone; the phone just needs to know.
      if (/can't find session/i.test(msg)) {
        this.d.log.debug(`Ignored ${frame.type}: session has ended`, { error: msg });
        return this.fail("unknown_session", msg, frame.type, false, id);
      }
      this.d.log.error(`Could not handle ${frame.type} from phone`, { error: msg });
      this.fail(/tmux/i.test(msg) ? "tmux_failed" : "internal", msg, frame.type, false, id);
    }
  }

  /** Activity entries as this client can read them: without `stopped` for an app from before it. */
  private entriesFor(entries: ActivityEntry[]): ActivityEntry[] {
    return this.client ? activityFor(this.client, entries) : entries;
  }

  /** The socket closed; drop subscriptions and listeners. */
  handleClose(): void {
    (this.d.clearTimer ?? ((t) => clearTimeout(t as NodeJS.Timeout)))(this.helloTimer);
    for (const id of this.subscriptions) this.d.registry.unsubscribe(id);
    this.subscriptions.clear();
    for (const id of [...this.terms.keys()]) this.closeTerm(id);
    for (const stop of this.canvasWatches.values()) stop();
    this.canvasWatches.clear();
    for (const stop of this.planFollows.values()) stop();
    this.planFollows.clear();
    if (this.authed) {
      this.d.registry.off("updated", this.onUpdated);
      this.d.registry.off("removed", this.onRemoved);
      this.d.registry.off("screen", this.onScreen);
      this.d.prompts?.off("opened", this.onPrompt);
      this.d.prompts?.off("closed", this.onPrompt);
      this.d.activity?.off("activity", this.onActivity);
      this.d.groups?.off("changed", this.onGroups);
      this.d.voice?.off("changed", this.onVoice);
      this.d.publish?.off("changed", this.onPublished);
      for (const stop of this.commentWatches.values()) stop();
      if (this.commentWatches.size > 0) this.d.comments?.off("changed", this.onComments);
      this.commentWatches.clear();
      if (this.watchesOwner) this.d.owner?.off("changed", this.onOwner);
      this.watchesOwner = false;
      this.stopWatchingTalk();
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
      if (verdict.pausedUntil !== undefined) {
        const pausedUntil = new Date(verdict.pausedUntil).toISOString();
        this.send({ type: "error", code: "too_many_attempts", message: verdict.message ?? "pairing is paused after too many wrong codes", ref: "pair", pausedUntil });
        return this.d.close(CLOSE_UNAUTHORIZED, "too_many_attempts");
      }
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
    this.client = frame.client;
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
        // Agents with a transcript to read say `activity` (PROTOCOL.md "Agents"); the phone hides the plain view for the rest.
        if (this.d.activity && agentInfo(r.get(frame.sessionId)?.agent ?? "")?.activity) {
          this.send({ type: "activity", sessionId: frame.sessionId, entries: this.entriesFor(this.d.activity.entriesOf(frame.sessionId)), full: true });
        }
        return;
      }
      case "unsubscribe":
        if (this.subscriptions.delete(frame.sessionId)) r.unsubscribe(frame.sessionId);
        return;
      case "input": {
        if (frame.id === undefined) return r.sendText(frame.sessionId, frame.text, frame.submit);
        // With an id the phone may send it again after a dropped connection: type it once, answer every time.
        await this.sentInputs.once(`${this.token}\n${frame.id}`, () => r.sendText(frame.sessionId, frame.text, frame.submit));
        return this.send({ type: "input.sent", id: frame.id, sessionId: frame.sessionId });
      }
      case "key":
        await r.sendKey(frame.sessionId, frame.key);
        if (frame.key === "escape" || frame.key === "ctrl-c") this.d.interrupted?.(frame.sessionId);
        return;
      case "resize":
        if (frame.cols === null) return r.releaseSize(frame.sessionId, this);
        return r.resize(frame.sessionId, frame.cols, frame.rows, this);
      case "term.open":
        return this.openTerm(frame.sessionId, frame.cols, frame.rows);
      case "term.input": {
        const term = this.terms.get(frame.sessionId);
        if (!term) return this.fail("bad_frame", "term.open first", frame.type);
        const bytes = Buffer.from(frame.data, "base64");
        term.input(bytes);
        if (isInterrupt(bytes)) this.d.interrupted?.(frame.sessionId);
        return;
      }
      case "term.resize":
        return this.terms.get(frame.sessionId)?.resize(frame.cols, frame.rows);
      case "term.close":
        return this.closeTerm(frame.sessionId);
      case "history":
        return this.send(await r.history(frame.sessionId, frame.before, frame.count));
      case "seen":
        return r.seen(frame.sessionId);
      case "session.create": {
        const agent = agentInfo(frame.agent);
        if (!agent) return this.fail("bad_frame", `this daemon cannot start ${frame.agent}`, frame.type);
        if (frame.resume !== undefined) {
          if (!agent.conversations) return this.fail("bad_frame", `${agent.name} has no conversations to resume`, frame.type);
          if (!this.d.conversations) return this.fail("bad_frame", "this daemon cannot resume conversations", frame.type);
          const resumed = await this.d.conversations.resume({ name: frame.name, agent: frame.agent, group: frame.group, conversationId: frame.resume });
          if (typeof resumed === "string") return this.fail("bad_frame", resumed, frame.type);
        } else {
          await r.create({ name: frame.name, cwd: frame.cwd, agent: frame.agent, group: frame.group });
        }
        return this.send({ type: "sessions", sessions: r.list() });
      }
      case "conversations":
        if (!this.d.conversations) return this.fail("bad_frame", "this daemon lists no conversations", frame.type);
        // Every reply after this one (a delete, an archive) lists the same agents.
        this.anyAgentConversations = frame.anyAgent === true;
        return this.send({ type: "conversations", conversations: await this.d.conversations.list(this.anyAgentConversations) });
      case "conversation.preview": {
        if (!this.d.conversations) return this.fail("bad_frame", "this daemon lists no conversations", frame.type);
        const entries = await this.d.conversations.preview(frame.conversationId);
        if (!entries) return this.fail("bad_frame", `no conversation ${frame.conversationId} on this ${computerWord()}`, frame.type);
        return this.send({ type: "conversation.preview", conversationId: frame.conversationId, entries: this.entriesFor(entries) });
      }
      case "conversation.delete": {
        if (!this.d.conversations) return this.fail("bad_frame", "this daemon lists no conversations", frame.type);
        const refused = await this.d.conversations.delete(frame.conversationId);
        if (refused) return this.fail("bad_frame", `could not delete the conversation: ${refused}`, frame.type);
        return this.send({ type: "conversations", conversations: await this.d.conversations.list(this.anyAgentConversations) });
      }
      case "conversation.archive":
        // Retired (grenade-cli 1.0.14): answered, changes nothing.
        if (!this.d.conversations) return this.fail("bad_frame", "this daemon lists no conversations", frame.type);
        return this.send({ type: "conversations", conversations: await this.d.conversations.list(this.anyAgentConversations) });
      case "folders":
        return this.send(await listFolders(frame.path));
      case "limits":
        return this.send({ type: "limits", limits: this.d.limits?.list() ?? [] });
      case "voice":
        if (!this.d.voice) return this.fail("bad_frame", "this daemon keeps no voice keys", frame.type);
        if (!this.watchesVoice) this.d.voice.on("changed", this.onVoice);
        this.watchesVoice = true;
        return this.send(this.d.voice.frame());
      case "voice.key": {
        if (!this.d.voice) return this.fail("bad_frame", "this daemon keeps no voice keys", frame.type);
        try {
          const changed = await this.d.voice.setKey(frame.provider, frame.key);
          // A change reaches a client that watches through `changed`; the sender gets its answer either way.
          if (!changed || !this.watchesVoice) this.send(this.d.voice.frame());
        } catch (e) {
          if (e instanceof VoiceError) return this.fail(e.code, e.message, frame.type);
          throw e;
        }
        return;
      }
      case "voice.token": {
        if (!this.d.voice) return this.fail("bad_frame", "this daemon keeps no voice keys", frame.type, false, frame.id);
        try {
          const minted = await this.d.voice.token(frame.provider, frame.use, frame.model);
          return this.send({ type: "voice.token", id: frame.id, provider: frame.provider, use: frame.use, token: minted.token, expiresAt: minted.expiresAt.toISOString(), ...(minted.once ? { once: true as const } : {}) });
        } catch (e) {
          if (e instanceof VoiceError) return this.fail(e.code, e.message, frame.type, false, frame.id);
          throw e;
        }
      }
      case "canvases":
      case "canvas":
      case "canvas.subscribe":
      case "canvas.unsubscribe":
      case "canvas.board":
        return this.handleCanvas(frame);
      case "publish.list":
      case "publish.canvas":
      case "publish.plan":
      case "publish.remove":
        return this.handlePublish(frame);
      case "comments.list":
      case "comment.reply":
      case "comment.resolve":
      case "comment.seen":
        return this.handleComments(frame);
      case "owner.name":
        return this.handleOwner(frame);
      case "talk.thread":
      case "talk.say":
      case "talk.agent":
        return this.handleTalk(frame);
      case "plan.subscribe":
      case "plan.unsubscribe":
      case "plan.write":
        return this.handlePlan(frame);
      case "session.mode": {
        const session = r.get(frame.sessionId);
        if (!session) return this.fail("unknown_session", `no session ${frame.sessionId}`, frame.type);
        const enter = this.d.plans?.enterPlanMode;
        if (!enter || !agentInfo(session.agent)?.plans) return this.fail("bad_frame", "this session's agent has no plan mode", frame.type);
        if (this.d.prompts?.list().some((p) => p.sessionId === session.id)) return this.fail("bad_frame", "Answer what Claude is asking first.", frame.type);
        try {
          await enter(session.id);
        } catch (e) {
          if (e instanceof PlanModeError) return this.fail("bad_frame", e.message, frame.type);
          throw e;
        }
        // Every client hears of it through `updated`; this one gets its answer even when nothing changed.
        const after = r.get(session.id);
        if (after) this.send({ type: "session.updated", session: after });
        return;
      }
      case "session.group": {
        // The registry emits session.updated when the group or order changes; a no-op move still gets an answer.
        const before = r.get(frame.sessionId);
        const after = r.setGroup(frame.sessionId, frame.group, frame.index);
        if (after.group === before?.group && after.order === before?.order) this.send({ type: "session.updated", session: after });
        return;
      }
      case "session.model": {
        const session = r.get(frame.sessionId);
        if (!session) return this.fail("unknown_session", `no session ${frame.sessionId}`, frame.type);
        const problem = (this.d.models ? null : "this daemon switches no models") ?? modelChoiceProblem(agentInfo(session.agent), frame.model, frame.effort) ?? switchTimingProblem(session);
        if (problem) return this.fail("bad_frame", problem, frame.type);
        // Nothing to switch: the sender still gets its answer. Every other client hears of a real switch through `updated`.
        if (session.model === frame.model && (frame.effort === undefined || session.effort === frame.effort)) return this.send({ type: "session.updated", session });
        try {
          await this.d.models!.switch(session, frame.model, frame.effort);
        } catch (e) {
          if (e instanceof ModelSwitchError) return this.fail("tmux_failed", e.message, frame.type);
          throw e;
        }
        return;
      }
      case "group.rename": {
        // The registry emits session.updated for every member it renamed; a rename that changes nothing still gets an answer.
        const renamed = r.renameGroup(frame.group, frame.name);
        if (!renamed.changed) this.send({ type: "session.updated", session: renamed.session });
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
      case "board.register":
        return this.send((this.token && this.d.board?.register(this.token, frame)) || NO_BOARD);
      case "board.unregister":
        return this.send((this.token && this.d.board?.unregister(this.token)) || NO_BOARD);
      case "prompt.answer": {
        const outcome = this.d.prompts?.answer(frame.sessionId, frame.promptId, await this.decisionFor(frame)) ?? "elsewhere";
        if (typeof outcome === "object") return this.fail("bad_frame", outcome.error, frame.type);
        // A used answer reaches every client through the store. This one came too late.
        if (outcome === "elsewhere") this.send({ type: "prompt.closed", sessionId: frame.sessionId, promptId: frame.promptId, reason: "elsewhere" });
        return;
      }
      case "attachment": {
        this.requireSession(frame.sessionId);
        const data = Buffer.from(frame.data, "base64");
        if (data.length > ATTACHMENT_MAX_BYTES) return this.fail("bad_frame", `attachment is larger than ${ATTACHMENT_MAX_BYTES} bytes`, frame.type, false, frame.id);
        const saved = await this.d.attachments.save(frame.sessionId, frame.name, frame.mime, data);
        this.d.log.info("Saved an attachment from the phone", { session: frame.sessionId, path: saved.path, bytes: saved.bytes });
        return this.send({ type: "attachment.saved", id: frame.id, sessionId: frame.sessionId, path: saved.path, bytes: saved.bytes });
      }
    }
  }

  /**
   * A plan is approved as its file holds it now, the user's edits included, and one sent back says the user edited it
   * (PROTOCOL.md "Plans"). Any other answer is the frame as it came.
   */
  private async decisionFor(frame: Extract<ClientFrame, { type: "prompt.answer" }>): Promise<PromptDecision> {
    const plans = this.d.plans;
    const open = this.d.prompts?.list().find((p) => p.promptId === frame.promptId && p.sessionId === frame.sessionId);
    if (!plans || open?.kind !== "plan") return frame;
    if (frame.allow) return { ...frame, planText: await plans.textOf(frame.sessionId) };
    return { ...frame, planEdited: plans.takeEditedPath(frame.sessionId) };
  }

  /** The plan frames (PROTOCOL.md "Plans"). */
  private async handlePlan(frame: Extract<ClientFrame, { type: "plan.subscribe" | "plan.unsubscribe" | "plan.write" }>): Promise<void> {
    const plans = this.d.plans;
    const id = frame.type === "plan.write" ? frame.id : undefined;
    if (!plans) return this.fail("bad_frame", "this daemon shows no plans", frame.type, false, id);
    const session = this.d.registry.get(frame.sessionId);
    if (!session) return this.fail("unknown_session", `no session ${frame.sessionId}`, frame.type, false, id);
    if (!agentInfo(session.agent)?.plans) return this.fail("bad_frame", "this session's agent has no plans", frame.type, false, id);
    switch (frame.type) {
      case "plan.unsubscribe":
        this.planFollows.get(frame.sessionId)?.();
        this.planFollows.delete(frame.sessionId);
        return;
      case "plan.subscribe": {
        if (this.planFollows.has(frame.sessionId)) return;
        if (this.planFollows.size >= PLAN_SUBSCRIPTIONS_MAX) return this.fail("bad_frame", `A connection follows at most ${PLAN_SUBSCRIPTIONS_MAX} plans; unsubscribe from one first.`, frame.type);
        this.planFollows.set(frame.sessionId, plans.follow(frame.sessionId, (plan) => this.send(plan)));
        return;
      }
      case "plan.write":
        try {
          const written = await plans.write(frame.sessionId, frame.text);
          // The others hear of it through their follow; this one gets its id back.
          if (frame.id !== undefined || !this.planFollows.has(frame.sessionId)) this.send({ ...written, ...(frame.id !== undefined ? { id: frame.id } : {}) });
        } catch (e) {
          if (e instanceof PlanWriteError) return this.fail("bad_frame", e.message, frame.type, false, frame.id);
          throw e;
        }
        return;
    }
  }

  /** The typed Talk frames (PROTOCOL.md "Talk by text"). `talk.thread` makes this connection watch the thread. */
  private handleTalk(frame: Extract<ClientFrame, { type: "talk.thread" | "talk.say" | "talk.agent" }>): void {
    const talk = this.d.talk;
    if (!talk) return this.fail("bad_frame", "this daemon answers no typed Talk", frame.type);
    if (frame.type === "talk.thread") {
      if (!this.watchesTalk) {
        talk.on("entry", this.onTalkEntry);
        talk.on("busy", this.onTalkBusy);
        talk.on("thread", this.onTalkThread);
        this.watchesTalk = true;
      }
      return this.send(talk.frame());
    }
    if (frame.type === "talk.say") {
      talk.say(frame.id, frame.text);
      return;
    }
    if (!talk.setAgent(frame.agent)) return this.fail("bad_frame", `${frame.agent} cannot answer Talk on this ${computerWord()}`, frame.type);
    // Every connection that watches hears of it through `thread`; the sender gets its answer either way.
    if (!this.watchesTalk) this.send(talk.frame());
  }

  private stopWatchingTalk(): void {
    if (!this.watchesTalk) return;
    this.d.talk?.off("entry", this.onTalkEntry);
    this.d.talk?.off("busy", this.onTalkBusy);
    this.d.talk?.off("thread", this.onTalkThread);
    this.watchesTalk = false;
  }

  /** The publish frames (PROTOCOL.md "Publishing"): answered with every link and the request's `id`; a refusal is `bad_frame` with it. */
  private async handlePublish(frame: Extract<ClientFrame, { type: "publish.list" | "publish.canvas" | "publish.plan" | "publish.remove" }>): Promise<void> {
    const publish = this.d.publish;
    if (!publish) return this.fail("bad_frame", "this daemon publishes nothing", frame.type, false, frame.id);
    if (!this.watchesPublish) publish.on("changed", this.onPublished);
    this.watchesPublish = true;
    try {
      const links =
        frame.type === "publish.list" ? publish.list()
        : frame.type === "publish.canvas" ? await publish.publishCanvas(pickOf(frame), frame.scope, frame.expiry, frame.newLink === true, frame.token)
        : frame.type === "publish.plan" ? await publish.publishPlan(frame.sessionId, frame.expiry, frame.newLink === true)
        : await publish.remove(frame.token);
      this.send({ type: "published", id: frame.id, links });
    } catch (e) {
      if (e instanceof PublishError) return this.fail("bad_frame", e.message, frame.type, false, frame.id);
      throw e;
    }
  }

  /** The comment frames (PROTOCOL.md "Comments"): answered with the link's threads and the request's `id`; a refusal is `bad_frame` with it. */
  private async handleComments(frame: Extract<ClientFrame, { type: "comments.list" | "comment.reply" | "comment.resolve" | "comment.seen" }>): Promise<void> {
    const comments = this.d.comments;
    const id = frame.type === "comment.seen" ? undefined : frame.id;
    if (!comments) return this.fail("bad_frame", "this daemon pulls no comments", frame.type, false, id);
    const known = this.d.publish?.list().some((l) => l.token === frame.token) ?? false;
    if (!known && frame.type !== "comment.seen") return this.fail("bad_frame", "That link is not one of this computer's.", frame.type, false, id);
    if (frame.type === "comment.seen") return comments.seen(frame.token, frame.thread);
    if (!this.commentWatches.has(frame.token)) {
      if (this.commentWatches.size === 0) comments.on("changed", this.onComments);
      this.commentWatches.set(frame.token, comments.watch(frame.token));
    }
    try {
      const reply =
        frame.type === "comments.list" ? comments.frame(frame.token, frame.id)
        : frame.type === "comment.reply" ? { ...(await comments.reply(frame.token, frame.thread, frame.text)), id: frame.id }
        : { ...(await comments.resolve(frame.token, frame.thread, frame.resolved)), id: frame.id };
      this.send(reply);
    } catch (e) {
      if (e instanceof CommentError) return this.fail("bad_frame", e.message, frame.type, false, frame.id);
      throw e;
    }
  }

  /** `owner.name`: asks for the owner's name, or sets it; answered with `owner` and the request's `id`. */
  private handleOwner(frame: Extract<ClientFrame, { type: "owner.name" }>): void {
    const owner = this.d.owner;
    if (!owner) return this.fail("bad_frame", "this daemon keeps no owner's name", frame.type, false, frame.id);
    if (!this.watchesOwner) owner.on("changed", this.onOwner);
    this.watchesOwner = true;
    // The answer goes before the change everyone hears of, so the asker hears its own name once, with its id.
    owner.off("changed", this.onOwner);
    const name = frame.name === undefined ? owner.name : owner.set(frame.name);
    owner.on("changed", this.onOwner);
    this.send({ type: "owner", id: frame.id, name });
  }

  /** The canvas frames (PROTOCOL.md "Canvas"): a refused folder, a missing or too large board is `bad_frame` with the request's `id`. */
  private async handleCanvas(frame: Extract<ClientFrame, { type: "canvases" | "canvas" | "canvas.subscribe" | "canvas.unsubscribe" | "canvas.board" }>): Promise<void> {
    if (frame.type === "canvas.unsubscribe") {
      const key = watchKey(pickOf(frame));
      this.canvasWatches.get(key)?.();
      this.canvasWatches.delete(key);
      return;
    }
    const canvas = this.d.canvas;
    if (!canvas) return this.fail("bad_frame", "this daemon serves no canvas", frame.type, false, frame.id);
    const { cwd, id } = frame;
    try {
      if (frame.type === "canvases") {
        const { folder, canvases } = await canvas.canvases(cwd, frame.group);
        return this.send({ type: "canvases", id, cwd, group: frame.group, folder, canvases });
      }
      const pick = pickOf(frame);
      const sent = { ...(pick.group !== undefined ? { group: pick.group } : {}), ...(pick.canvas !== undefined ? { canvas: pick.canvas } : {}) };
      const framed = (reply: CanvasReply, withId: boolean): CanvasFrame => ({ type: "canvas", ...(withId ? { id } : {}), cwd, ...sent, ...reply });
      if (frame.type === "canvas") return this.send(framed(await canvas.list(pick), true));
      if (frame.type === "canvas.subscribe") {
        const key = watchKey(pick);
        const again = this.canvasWatches.get(key);
        if (!again && this.canvasWatches.size >= CANVAS_SUBSCRIPTIONS_MAX) {
          return this.fail("bad_frame", `A connection watches at most ${CANVAS_SUBSCRIPTIONS_MAX} canvases; unsubscribe from one first.`, frame.type, false, id);
        }
        const { reply, stop } = await canvas.watch(pick, (changed) => this.send(framed(changed, false)));
        // The connection ended while the folder was read.
        if (!this.authed) return stop();
        again?.();
        this.canvasWatches.set(key, stop);
        return this.send(framed(reply, true));
      }
      const board = await canvas.board(pick, frame.file);
      const reply = { type: "canvas.board" as const, id, cwd, ...sent, file: frame.file, ...board };
      const tooLarge = boardTooLarge(frame.file, board.bytes, Buffer.byteLength(JSON.stringify(reply)), computerWord());
      if (tooLarge) return this.fail("bad_frame", tooLarge, frame.type, false, id);
      return this.send(reply);
    } catch (e) {
      if (e instanceof CanvasError) return this.fail("bad_frame", e.message, frame.type, false, id);
      throw e;
    }
  }

  private openTerm(sessionId: string, cols: number, rows: number): void {
    if (!this.d.openTerm) return this.fail("bad_frame", "this daemon streams no terminal", "term.open");
    this.requireSession(sessionId);
    this.closeTerm(sessionId);
    const term = this.d.openTerm({
      sessionId,
      cols,
      rows,
      output: (data, reset) => {
        if (this.terms.get(sessionId) === term) this.send({ type: "term.output", sessionId, data: data.toString("base64"), ...(reset ? { reset: true as const } : {}) });
      },
      closed: (reason) => {
        if (this.terms.get(sessionId) !== term) return;
        this.terms.delete(sessionId);
        this.send({ type: "term.closed", sessionId, reason });
      },
    });
    this.terms.set(sessionId, term);
  }

  private closeTerm(sessionId: string): void {
    const term = this.terms.get(sessionId);
    if (!term) return;
    this.terms.delete(sessionId);
    term.close();
  }

  private requireSession(id: string): void {
    if (!this.d.registry.get(id)) throw new UnknownSessionError(`no session ${id}`);
  }

  private send(frame: DaemonFrame): void {
    this.d.out(this.client ? framedFor(this.client, frame) : frame);
  }

  private fail(code: ErrorCode, message: string, ref?: string, closeAfter = false, id?: string): void {
    this.send({ type: "error", code, message, ...(ref === undefined ? {} : { ref }), ...(id === undefined ? {} : { id }) });
    if (closeAfter) this.d.close(CLOSE_UNAUTHORIZED, code);
  }
}

/** A frame as this client can read it: a stopped turn reads as `done` for an app from before `stopped` (`sessionFor`). */
function framedFor(client: ClientInfo, frame: DaemonFrame): DaemonFrame {
  if (frame.type === "session.updated") return { ...frame, session: sessionFor(client, frame.session) };
  if (frame.type === "sessions") return { ...frame, sessions: frame.sessions.map((s) => sessionFor(client, s)) };
  return frame;
}

/** Which canvas a frame means: its `cwd`, and its `group` and `canvas` when it has them. */
function pickOf(frame: { cwd: string; group?: string | undefined; canvas?: string | undefined }): CanvasPick {
  return { cwd: frame.cwd, ...(frame.group !== undefined ? { group: frame.group } : {}), ...(frame.canvas !== undefined ? { canvas: frame.canvas } : {}) };
}

/** What a connection keeps a watch by: `cwd`, `group` and `canvas` together. */
function watchKey(pick: CanvasPick): string {
  return `${pick.cwd}\n${pick.group ?? ""}\n${pick.canvas ?? ""}`;
}
