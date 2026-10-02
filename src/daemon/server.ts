/**
 * grenaded: wires everything together.
 *   :7788  HTTP  POST /pair, POST /hooks/claude and /hooks/claude/prompt (loopback only), GET /health   +   WebSocket at /ws (encrypted, src/daemon/lanSocket.ts)
 *   127.0.0.1:7789  control API for the CLI
 *   relay link (optional)  phones away from the LAN, end-to-end encrypted (src/relay/)
 */
import { dirname, join } from "node:path";
import { createServer, type Server } from "node:http";
import { networkInterfaces } from "node:os";
import { WebSocketServer, type WebSocket } from "ws";
import { CONTROL_PORT, DEFAULT_PORT, PROMPT_HOOK_PATH, PairRequest, WS_PATH, activityEntriesIn, endsStopped, workingDirectoryIn, type ClientInfo, type DaemonFrame, type DaemonInfo } from "@grenade/protocol";
import { VERSION, defaultName, ensureDir, loadDaemonId, paths } from "../config.js";
import { createLogger, type Logger } from "../log.js";
import { startPoller, type Poller } from "../sessions/poller.js";
import { SessionRegistry } from "../sessions/registry.js";
import { GroupOrderStore } from "../sessions/groupOrderStore.js";
import { resolveClaudeBin, runClaudeSummary } from "../summary/claudeCli.js";
import { Summarizer } from "../summary/summarizer.js";
import { TerminalMirror, defaultTerminal, type TerminalKind } from "../terminal/mirror.js";
import { createTmux, type Tmux } from "../tmux/tmux.js";
import { readTranscriptModel } from "../transcript/readModel.js";
import { ActivityStore } from "../activity/activityStore.js";
import { TranscriptReader } from "../activity/transcriptReader.js";
import { CatchUp } from "../activity/catchUp.js";
import { ConversationIndex } from "../conversations/conversationIndex.js";
import { ConversationMarks } from "../conversations/conversationMarks.js";
import { conversationIdOf, heldConversations } from "../conversations/heldConversations.js";
import { claudeIsWorking } from "../activity/claudeScreen.js";
import { LiveConnections } from "./connections.js";
import { createControlServer } from "./control.js";
import { deviceOf, type Device, type Route } from "./devices.js";
import { startDiscovery } from "./discovery.js";
import { handleClaudeHook } from "./hooks.js";
import { readBody, sendJson } from "./http.js";
import { LanSocket } from "./lanSocket.js";
import { isLoopback } from "./loopback.js";
import { typedCode } from "./pairCheck.js";
import { CODE_TTL_MS, DEVICE_IDLE_MS, PairingCodes, TokenStore, type TokenRecord } from "./pairing.js";
import { closePromptsByHook, handlePromptHook } from "./promptHook.js";
import { Connection, type ConversationsPort, type PairVerdict } from "./wsHandler.js";
import { offerUrlFor } from "../pairing/offer.js";
import { PairingWatch } from "../pairing/pairingWatch.js";
import { createAttachmentStore } from "../attachments/attachmentStore.js";
import { accessHash } from "../relay/access.js";
import { loadOrCreateE2EKey } from "../relay/e2eKey.js";
import { localIpv4 } from "../relay/localIps.js";
import { PhonePipe } from "../relay/phonePipe.js";
import { applyRelayInfo, loadRelayConfig } from "../relay/relayConfig.js";
import { RelayLink, type RelayStatus } from "../relay/relayLink.js";
import { readAuto } from "../update/autoSetting.js";
import { installedVersion, resolveProgram } from "../update/installedVersion.js";
import { UpdateChecker } from "../update/updateChecker.js";
import { installerFor, isBusy } from "../update/versions.js";
import { startPush } from "../push/startPush.js";
import { PromptStore } from "../prompts/promptStore.js";
import { PromptTests } from "../prompts/promptTests.js";
import { promptText } from "../prompts/promptText.js";
import { SentInputs } from "./sentInputs.js";

export interface DaemonOptions {
  port?: number;
  controlPort?: number;
  name?: string;
  advertise?: boolean;
  log?: Logger;
  tmux?: Tmux;
  tokensPath?: string | null;
  sessionsPath?: string | null;
  /** Claude Code's folder, where past conversations are read from (PROTOCOL.md "Conversations"). Default: paths.claudeDir. */
  claudeDir?: string;
  /** Mirror sessions into terminal tabs. Default `auto`: iTerm2 when it is installed (checked at every event), else Terminal.app. */
  terminal?: TerminalKind;
  /** One-sentence session summaries via `claude -p` (Haiku). Defaults to on unless `GRENADE_SUMMARIES=off`. */
  summaries?: boolean;
  /** Connect to the relay in relay.json. Defaults to on; `--no-relay` turns it off. */
  relay?: boolean;
  relayPath?: string;
  e2eKeyPath?: string;
  /** Folder for files phones upload (`attachment` frames). Defaults to ~/.grenade/attachments. */
  attachmentsDir?: string;
  /**
   * Accept phones that predate the encrypted local network: a plain `hello` and a plain `POST /pair`
   * (PROTOCOL.md "Older clients and daemons"). Off by default; `--allow-plain-lan` turns it on.
   */
  allowPlainLan?: boolean;
  /** Unpair phones unseen for this long. Defaults to 90 days; 0 never unpairs by age. */
  deviceIdleMs?: number;
  /** push.json: whether and through which relay this Mac sends push notifications. Defaults to ~/.grenade/push.json. */
  pushPath?: string;
  /** Where the phones' push registrations are kept. Defaults to ~/.grenade/push-devices.json; in memory when tokens are. */
  pushDevicesPath?: string;
  /**
   * Updates (src/update/): ask the tap for the latest release (default on unless GRENADE_UPDATE_CHECK=off), watch the
   * version on disk behind `program` (the `grenade` command; none: nothing to watch), and call `restart` once a newer
   * one is there and no session is busy. Without `restart` the daemon only logs it. With `program` it also installs a
   * newer release itself, with the installer of that copy, unless `grenade update --auto off` (or `auto` here) says not.
   */
  updates?: { checkTap?: boolean; program?: string; restart?(installed: string): void; auto?: boolean };
}

export interface RunningDaemon {
  info: DaemonInfo;
  port: number;
  controlPort: number;
  stop(): Promise<void>;
}

export async function startDaemon(opts: DaemonOptions = {}): Promise<RunningDaemon> {
  ensureDir();
  const port = opts.port ?? DEFAULT_PORT;
  const controlPort = opts.controlPort ?? CONTROL_PORT;
  const log = opts.log ?? createLogger({ file: paths.log, level: (process.env["GRENADE_LOG"] as "debug" | undefined) ?? "info" });
  const e2eKey = loadOrCreateE2EKey(opts.e2eKeyPath ?? paths.e2eKey);
  // Mutated in place when the relay is turned on or off, so later pair replies and welcomes carry it.
  const info: DaemonInfo = { id: loadDaemonId(), name: opts.name ?? defaultName(), version: VERSION, key: e2eKey.publicKey.toString("base64"), e2e: 1, inputSent: 1, conversations: 1 };
  const allowPlainLan = opts.allowPlainLan === true;
  const tmux = opts.tmux ?? createTmux();
  const tokens = new TokenStore(opts.tokensPath === null ? undefined : (opts.tokensPath ?? paths.tokens));
  const codes = new PairingCodes();
  const pairing = new PairingWatch();
  const registry = new SessionRegistry({
    tmux,
    log,
    ...(opts.sessionsPath === null ? {} : { persistPath: opts.sessionsPath ?? paths.sessions }),
  });
  const summarizer = startSummarizer(registry, log, opts.summaries ?? process.env["GRENADE_SUMMARIES"] !== "off");
  await registry.adopt();
  // Saved beside sessions.json, so a test daemon with its own sessions file keeps its own order too.
  const groupsPath = opts.sessionsPath === null ? undefined : opts.sessionsPath ? join(dirname(opts.sessionsPath), "groups.json") : paths.groups;
  const groupOrder = new GroupOrderStore(registry, log, groupsPath);
  const poller: Poller = startPoller({ tmux, registry, log });
  const mirror = new TerminalMirror({ registry, log, terminal: opts.terminal ?? defaultTerminal() });
  mirror.start().catch((e) => log.warn("Could not mirror sessions into a terminal", { error: e }));

  const http = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      if (req.method === "GET" && url.pathname === "/health") return sendJson(res, 200, { ok: true, ...info });
      if (req.method === "POST" && url.pathname === "/pair") return handlePair(await readBody(req), res);
      if (req.method === "POST" && url.pathname === "/hooks/claude") {
        // Hooks come from Claude Code on this Mac. The port listens on every interface, so say so.
        if (!isLoopback(req.socket.remoteAddress)) return sendJson(res, 403, { error: "forbidden" });
        const session = url.searchParams.get("session");
        const body = await readBody(req);
        const r = applyClaudeHook(session, body);
        // The agent moved on: a prompt that was open was answered in the terminal.
        closePromptsByHook(prompts, session, body);
        return sendJson(res, r.status, r.body);
      }
      if (req.method === "POST" && url.pathname === PROMPT_HOOK_PATH) {
        if (!isLoopback(req.socket.remoteAddress)) return sendJson(res, 403, { error: "forbidden" });
        return await handlePromptHook(req, res, { prompts, applyHook: (id, body) => applyClaudeHook(id, body).status === 200, log });
      }
      sendJson(res, 404, { error: "not_found" });
    } catch (e) {
      log.error("HTTP request failed", { url: req.url, error: e });
      sendJson(res, 500, { error: "internal" });
    }
  });

  // What the agent said and was asked, read from the transcript on every hook (PROTOCOL.md "Activity").
  const activity = new ActivityStore();
  const transcripts = new TranscriptReader();
  /** Reads a session's transcript: new activity into the store, a moved working directory into the session. */
  const readActivity = (id: string, path: string) =>
    transcripts.readChunk(path).then(({ jsonl, fromStart }) => {
      const entries = activityEntriesIn(jsonl);
      // A resumed session's copy repeats the whole history: it takes the place of what the store holds.
      if (fromStart && registry.get(id)?.resumedFrom !== undefined) activity.replace(id, entries);
      else activity.append(id, entries);
      const cwd = workingDirectoryIn(jsonl);
      if (cwd) registry.setCwd(id, cwd);
      // The user interrupted the turn: no hook says so, and Claude Code is back at its prompt.
      if (endsStopped(entries) && registry.get(id)?.status === "working") registry.applyHook(id, "idle");
      return entries;
    });
  // A Stop can come before the reply is in the transcript; keep reading until it is.
  const catchUp = new CatchUp((id, path) => readActivity(id, path).then((entries) => entries.some((e) => e.kind === "said")));
  // An interrupt fires no hook: after a client's Esc or Ctrl-C, read until the transcript records it. A prompt
  // stopped before the agent wrote anything leaves no line, so once the screen shows Claude Code at its prompt the
  // session is idle and gets its `stopped` entry anyway.
  const interruptCatchUp = new CatchUp(async (id, path) => {
    const entries = await readActivity(id, path);
    if (entries.some((e) => e.kind === "stopped")) return true;
    const screen = registry.screenOf(id);
    if (registry.get(id)?.status !== "working" || !screen || claudeIsWorking(screen.lines)) return false;
    activity.noteStopped(id, new Date().toISOString());
    registry.applyHook(id, "idle");
    return true;
  });
  const interrupted = (id: string) => {
    const session = registry.get(id);
    const path = registry.transcriptOf(id);
    if (session?.agent === "claude" && session.status === "working" && path) interruptCatchUp.start(id, path);
  };
  // The store lives in memory: after a restart, read every saved transcript from its start rather than wait for
  // each session's next hook, so a phone sees what was said the moment it subscribes.
  for (const { id, path } of registry.transcripts()) {
    readActivity(id, path).catch((e) => log.debug("Could not read the activity from a saved transcript", { session: id, path, error: e }));
  }

  // Past Claude Code conversations (PROTOCOL.md "Conversations"). Read only; Grenade's marks live beside sessions.json.
  const marksPath = opts.sessionsPath === null ? undefined : opts.sessionsPath ? join(dirname(opts.sessionsPath), "conversations.json") : paths.conversations;
  const marks = new ConversationMarks(log, marksPath);
  const conversationIndex = new ConversationIndex({
    claudeDir: opts.claudeDir ?? paths.claudeDir,
    marks,
    held: () => heldConversations(registry.transcripts(), (id) => (registry.get(id)?.status ?? "gone") !== "gone"),
  });
  const conversations: ConversationsPort = {
    list: () => conversationIndex.list(),
    preview: (id) => conversationIndex.preview(id),
    archive: (id, archived) => marks.setArchived(id, archived),
    async resume({ name, group, conversationId }) {
      const found = await conversationIndex.find(conversationId);
      if (!found) return null;
      const session = await registry.create({ name, cwd: found.cwd, agent: "claude", group, resume: conversationId });
      // Claude Code writes the copy only with its first prompt; until then the session shows the original's history.
      // Read whole here, not through the reader, whose place in that file may belong to another session.
      registry.setTranscript(session.id, found.path);
      const history = await conversationIndex.preview(conversationId);
      if (history) activity.replace(session.id, history);
      log.info(`Resumed a copy of conversation ${conversationId}`, { session: session.id, cwd: found.cwd });
      return session;
    },
  };

  /** One hook event of a session: status, summary input, model, activity and the text of a push. */
  const applyClaudeHook = (session: string | null, body: string) =>
    handleClaudeHook(
      registry,
      session,
      body,
      log,
      (id, prompt) => {
        summarizer?.notePrompt(id, prompt);
        activity.noteAsked(id, prompt, new Date().toISOString());
      },
      (id, path, event) => {
        // A resumed session names its copy from the first prompt on: remember it as Grenade's copy.
        const resumedFrom = registry.get(id)?.resumedFrom;
        if (resumedFrom && conversationIdOf(path) !== resumedFrom) marks.noteCopy(conversationIdOf(path), resumedFrom);
        registry.setTranscript(id, path);
        readTranscriptModel(path)
          .then((model) => model && registry.setModel(id, model))
          .catch((e) => log.debug("Could not read the model from a transcript", { session: id, path, error: e }));
        catchUp.cancel(id);
        interruptCatchUp.cancel(id);
        readActivity(id, path)
          .then((entries) => {
            if (event === "Stop" && !entries.some((e) => e.kind === "said")) catchUp.start(id, path);
          })
          .catch((e) => log.debug("Could not read the activity from a transcript", { session: id, path, error: e }));
      },
      (id, message) => push.pusher.noteAsked(id, message),
    );

  function handlePair(raw: string, res: Parameters<typeof sendJson>[0]): void {
    // The code and the token would cross the Wi‑Fi in the clear.
    if (!allowPlainLan) return sendJson(res, 426, { error: "encryption_required" });
    let json: unknown;
    try {
      json = JSON.parse(raw || "{}");
    } catch {
      return sendJson(res, 400, { error: "bad_request" });
    }
    const body = PairRequest.safeParse(json);
    if (!body.success) return sendJson(res, 400, { error: "bad_request" });
    const verdict = codes.verify(body.data.code);
    if (verdict === "too_many_attempts") return sendJson(res, 429, { error: verdict });
    if (verdict === "invalid_code") return sendJson(res, 400, { error: verdict });
    const token = tokens.issue(body.data.client);
    pairing.paired(body.data.client, "lan");
    log.info(`Paired a new phone: ${body.data.client.name}`, { platform: body.data.client.platform });
    sendJson(res, 200, { token, daemon: info });
  }

  /** `pair` inside an encrypted channel, with the typed code or a pairing offer's secret. */
  function pairPhone(credential: string, client: ClientInfo, route: Route): PairVerdict {
    const verdict = codes.verify(credential);
    if (verdict === "too_many_attempts") pairing.voided();
    if (verdict !== "ok") return { ok: false, code: verdict };
    const token = tokens.issue(client, { sealed: true });
    pairing.paired(client, route);
    log.info(`Paired a new phone: ${client.name}`, { platform: client.platform, route });
    return { ok: true, token };
  }

  /** While a pairing offer is live the relay admits the phone that scanned it (PROTOCOL.md "Pairing offer (QR code)"). */
  const offerAccess = (): string[] => {
    const secret = codes.liveSecret();
    return secret ? [accessHash(secret)] : [];
  };
  let offerExpiry: NodeJS.Timeout | null = null;
  codes.onChange(() => {
    relayLink?.tokensChanged();
    if (offerExpiry) clearTimeout(offerExpiry);
    offerExpiry = null;
    if (codes.liveSecret() === null) return;
    // Nothing calls `verify` when an offer just runs out, so take its hash off the relay by the clock.
    offerExpiry = setTimeout(() => relayLink?.tokensChanged(), CODE_TTL_MS + 1000);
    offerExpiry.unref();
  });

  const attachments = createAttachmentStore(opts.attachmentsDir ?? paths.attachments);
  const push = startPush({
    registry,
    tokens,
    daemon: info,
    staticKey: e2eKey,
    relay: () => (opts.relay === false ? null : loadRelayConfig(opts.relayPath ?? paths.relay)),
    configPath: opts.pushPath ?? paths.push,
    devicesPath: opts.pushDevicesPath ?? (opts.tokensPath === null ? undefined : paths.pushDevices),
    log,
  });
  const live = new LiveConnections();

  // Prompts Claude Code is showing, which a phone can answer (PROTOCOL.md "Prompts").
  const prompts = new PromptStore();
  const promptTests = new PromptTests(prompts);
  prompts.on("opened", (frame) => push.pusher.noteAsked(frame.sessionId, promptText(frame)));
  prompts.on("answered", (id) => registry.applyHook(id, "working"));
  registry.on("removed", (id) => {
    prompts.closeSession(id);
    activity.forget(id);
    catchUp.cancel(id);
    interruptCatchUp.cancel(id);
  });
  registry.on("updated", (s) => {
    if (s.status === "gone") prompts.closeSession(s.id);
  });

  /** Ends pairings: the tokens are gone already; this closes what was open with them. Returns how many connections. */
  function closeConnectionsOf(gone: TokenRecord[], why: string): number {
    let closed = 0;
    for (const r of gone) {
      closed += live.revoke(r.token, why);
      log.info(`Unpaired a phone: ${r.client.name}`, { device: r.id, platform: r.client.platform, why });
    }
    return closed;
  }

  const devices = {
    list: (): Device[] => tokens.list().map((r) => deviceOf(r, live.routesOf(r.token))),
    unpair(id: string): { closed: number } | null {
      const gone = tokens.revoke(id);
      return gone ? { closed: closeConnectionsOf([gone], "unpaired on the Mac") } : null;
    },
    unpairAll(): { removed: number; closed: number } {
      const gone = tokens.revokeAll();
      return { removed: gone.length, closed: closeConnectionsOf(gone, "unpaired on the Mac") };
    },
  };

  /** The prompts phones sent with an id, so one sent again after a dropped connection is typed once. */
  const sentInputs = new SentInputs();

  /** One protocol connection, the same for a LAN socket and a relay pipe. */
  const makeConnection = (
    out: (frame: DaemonFrame) => void,
    close: (code: number, reason: string) => void,
    via: { route: Route; sealed: boolean },
  ) =>
    new Connection({
      registry,
      attachments,
      sentInputs,
      activity,
      interrupted,
      isValidToken: (t) => tokens.has(t),
      sealed: via.sealed,
      route: via.route,
      // Plain is for phones that were never encrypted, and only while the daemon allows it.
      acceptsPlain: (t) => allowPlainLan && tokens.get(t)?.sealed !== true,
      onHello(connection, token, client) {
        live.add(token, connection);
        tokens.touch(token, { sealed: via.sealed, client });
        if (!via.sealed) log.warn(`${client.name} connected without encryption. Update Grenade on that phone.`, { device: tokens.get(token)?.id });
      },
      onEnd(connection, token) {
        live.remove(token, connection);
        tokens.touch(token);
      },
      pair: pairPhone,
      push: push.pusher,
      prompts,
      groups: groupOrder,
      conversations,
      unpair(token) {
        const id = tokens.get(token)?.id;
        const gone = id ? tokens.revoke(id) : undefined;
        if (gone) closeConnectionsOf([gone], "unpaired on the phone");
      },
      daemon: info,
      log,
      out,
      close,
    });

  const wss = new WebSocketServer({ server: http, path: WS_PATH });
  wss.on("connection", (socket: WebSocket, req) => {
    const lan = new LanSocket({
      socket: {
        send: (text) => {
          if (socket.readyState === socket.OPEN) socket.send(text);
        },
        close: (code, reason) => socket.close(code, reason),
      },
      staticKey: e2eKey,
      makeConnection: (out, close, sealed) => makeConnection(out, close, { route: "lan", sealed }),
      log,
      label: req.socket.remoteAddress ?? "lan",
    });
    socket.on("message", (data) => lan.handleMessage(data.toString()));
    socket.on("close", () => lan.handleClose());
    socket.on("error", (e) => log.debug("WebSocket error", { error: e }));
  });

  const deviceIdleMs = opts.deviceIdleMs ?? DEVICE_IDLE_MS;
  const unpairIdle = (): void => {
    if (deviceIdleMs > 0) closeConnectionsOf(tokens.revokeIdle(deviceIdleMs), "not seen for a long time");
  };
  unpairIdle();
  const idleTimer = setInterval(unpairIdle, 60 * 60 * 1000);
  idleTimer.unref();

  const relayPath = opts.relayPath ?? paths.relay;
  let relayLink: RelayLink | null = null;
  /** (Re)reads relay.json and restarts the link. Called at start and by `grenade relay on|off`. */
  function startRelay(): RelayStatus {
    const config = opts.relay === false ? null : loadRelayConfig(relayPath);
    if (relayLink) {
      // A relay this Mac leaves must not go on admitting its phones.
      if (relayLink.id !== config?.id) relayLink.leave();
      else relayLink.stop();
      log.info("Disconnected from the relay");
    }
    relayLink = null;
    if (opts.relay === false) return { state: "off", phones: 0, disabled: true };
    applyRelayInfo(info, config);
    if (!config) return { state: "off", phones: 0 };
    relayLink = new RelayLink({
      config,
      name: info.name,
      version: VERSION,
      accessHashes: () => [...tokens.list().map((t) => accessHash(t.token)), ...offerAccess()],
      localIps: () => localIpv4(networkInterfaces()),
      openPipe: (conn, send, onEnd) =>
        new PhonePipe({ conn, staticKey: e2eKey, send, makeConnection: (out, close) => makeConnection(out, close, { route: "relay", sealed: true }), log, onEnd }),
      log,
    });
    relayLink.start();
    log.info("Connecting to the relay", { url: config.url, id: config.id });
    return relayLink.status();
  }
  const updates = new UpdateChecker({
    running: VERSION,
    log,
    installed: () => (opts.updates?.program ? installedVersion(opts.updates.program) : null),
    busy: () => registry.list().some(isBusy),
    checkTap: opts.updates?.checkTap ?? process.env["GRENADE_UPDATE_CHECK"] !== "off",
    ...(opts.updates?.restart ? { restart: opts.updates.restart } : {}),
    installer: opts.updates?.program ? installerFor(resolveProgram(opts.updates.program) ?? opts.updates.program, process.execPath) : null,
    auto: () => opts.updates?.auto ?? readAuto(),
  });

  const relayStatus = (): RelayStatus => relayLink?.status() ?? { state: "off", phones: 0, ...(opts.relay === false ? { disabled: true } : {}) };
  tokens.onChange(() => relayLink?.tokensChanged());
  startRelay();

  const control: Server = createControlServer({
    registry,
    codes,
    typedCode: (code) => typedCode(code, e2eKey.publicKey),
    offerUrl: (secret) => offerUrlFor(info, secret, localIpv4(networkInterfaces()), port),
    pairing,
    devices,
    daemon: info,
    startedAt: Date.now(),
    log,
    promptTests,
    relay: {
      status: relayStatus,
      reload() {
        const status = startRelay();
        // With push on `auto`, turning remote access on or off turns push on or off.
        push.relayChanged();
        return status;
      },
    },
    push,
    updates,
  });

  await listen(http, port, "0.0.0.0");
  await listen(control, controlPort, "127.0.0.1");
  const discovery = opts.advertise === false ? null : startDiscovery({ port, id: info.id, name: info.name, key: info.key ?? "", log });
  log.info(`Grenade ${VERSION} is running as "${info.name}" on port ${port}`, { id: info.id, controlPort });
  if (allowPlainLan) log.warn("Accepting phones without encryption on the Wi‑Fi (--allow-plain-lan). Update them, then start without it.");
  log.info("Pair a phone with: grenade pair");
  updates.start();

  return {
    info,
    port,
    controlPort,
    async stop() {
      clearInterval(idleTimer);
      updates.stop();
      if (offerExpiry) clearTimeout(offerExpiry);
      mirror.stop();
      poller.stop();
      relayLink?.stop();
      push.stop();
      // Held hook requests would keep the HTTP server from closing.
      prompts.closeAll();
      summarizer?.stop();
      catchUp.stop();
      interruptCatchUp.stop();
      await discovery?.stop();
      for (const c of wss.clients) c.close(1001, "daemon stopping");
      await Promise.all([closeServer(wss), closeServer(http), closeServer(control)]);
      log.info("Grenade stopped");
      log.close();
    },
  };
}

function startSummarizer(registry: SessionRegistry, log: Logger, enabled: boolean): Summarizer | null {
  if (!enabled) return null;
  const bin = resolveClaudeBin();
  if (!bin) {
    log.info("Session summaries are off: claude was not found (set CLAUDE_BIN)");
    return null;
  }
  const summarizer = new Summarizer({ registry, log, run: (input) => runClaudeSummary(bin, input) });
  summarizer.start();
  return summarizer;
}

function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function closeServer(s: { close(cb?: (err?: Error) => void): unknown }): Promise<void> {
  return new Promise((resolve) => s.close(() => resolve()));
}
