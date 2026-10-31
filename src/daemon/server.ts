/**
 * grenaded: wires everything together.
 *   :7788  HTTP  POST /pair, POST /hooks/claude, /hooks/claude/prompt and /hooks/codex (loopback only), GET /health   +   WebSocket at /ws (encrypted, src/daemon/lanSocket.ts)
 *   127.0.0.1:7789  control API for the CLI
 *   relay link (optional)  phones away from the LAN, end-to-end encrypted (src/relay/)
 */
import { computerWord, daemonOs } from "../platform/computer.js";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { networkInterfaces } from "node:os";
import { WebSocketServer, type WebSocket } from "ws";
import { CONTROL_PORT, DEFAULT_PORT, PROMPT_HOOK_PATH, PairRequest, WS_PATH, activityEntriesIn, codexActivityEntriesIn, endsStopped, workingDirectoryIn, type ClientInfo, type DaemonFrame, type DaemonInfo, type SessionContext } from "@grenade/protocol";
import { VERSION, defaultName, ensureDir, loadDaemonId, paths } from "../config.js";
import { createLogger, type Logger } from "../log.js";
import { startPoller, type Poller } from "../sessions/poller.js";
import { SessionRegistry } from "../sessions/registry.js";
import { EndedSessions } from "../sessions/endedSessions.js";
import { GroupOrderStore } from "../sessions/groupOrderStore.js";
import { TermStream } from "../sessions/termStream.js";
import { resolveClaudeBin, runClaudeSummary } from "../summary/claudeCli.js";
import { ContextBreakdown } from "../usage/contextBreakdown.js";
import { probeContext } from "../usage/contextProbe.js";
import { Summarizer } from "../summary/summarizer.js";
import { TerminalMirror, terminalFromEnv, type TerminalKind, type TerminalStatus } from "../terminal/mirror.js";
import { readTerminalSetting } from "../terminal/terminalSetting.js";
import { createTmux, type Tmux } from "../tmux/tmux.js";
import { readTranscriptModel } from "../transcript/readModel.js";
import { ModelSwitchError, switchClaudeModel, type ModelTerminal } from "../models/claudeModelSwitch.js";
import { aiTitleIn, clipTitle } from "../transcript/aiTitle.js";
import { ActivityStore } from "../activity/activityStore.js";
import { TranscriptReader } from "../activity/transcriptReader.js";
import { CatchUp } from "../activity/catchUp.js";
import { TranscriptFollower } from "../activity/follower.js";
import { AGENTS, agentInfo } from "../agents/agentCatalog.js";
import { CodexConversations } from "../conversations/codexConversations.js";
import { ConversationIndex } from "../conversations/conversationIndex.js";
import { AllConversations } from "../conversations/conversationSource.js";
import { ConversationMarks } from "../conversations/conversationMarks.js";
import { moveToTrash } from "../conversations/trash.js";
import { conversationIdOf, heldConversations, withLastSessions } from "../conversations/heldConversations.js";
import { claudeIsWorking } from "../activity/claudeScreen.js";
import { LiveConnections } from "./connections.js";
import { createControlServer } from "./control.js";
import { findAgentSetup, missingAgent } from "../agents/findAgentSetup.js";
import { deviceOf, type Device, type Route } from "./devices.js";
import { startDiscovery } from "./discovery.js";
import { underSystemd } from "../update/underService.js";
import { handleClaudeHook } from "./hooks.js";
import { handleCodexHook } from "./codexHooks.js";
import { ScreenPrompts } from "../prompts/screenPrompts.js";
import { ClaudeBackgroundWatch } from "../background/claudeBackgroundWatch.js";
import { codexBackgroundIn } from "../background/codexBackground.js";
import { watchScreenBackground } from "../background/screenBackground.js";
import { codexHookFlags } from "../hooks/installCodexHooks.js";
import { claudeHookFlags } from "../hooks/installHooks.js";
import { BROWSER_INSTRUCTIONS } from "../browser/browserPrompt.js";
import { CANVAS_INSTRUCTIONS } from "../canvas/canvasPrompt.js";
import { TODO_INSTRUCTIONS } from "../todos/todoPrompt.js";
import { readBody, sendJson } from "./http.js";
import { LanSocket } from "./lanSocket.js";
import { fromWebPage, isLoopback } from "./loopback.js";
import { typedCode } from "./pairCheck.js";
import { CODE_TTL_MS, DEVICE_IDLE_MS, PairingCodes, TokenStore, type TokenRecord } from "./pairing.js";
import { closePromptsByHook, handlePromptHook } from "./promptHook.js";
import { Connection, type ConversationsPort, type ModelsPort, type PairVerdict } from "./wsHandler.js";
import { offerUrlFor } from "../pairing/offer.js";
import { PairingWatch } from "../pairing/pairingWatch.js";
import { PairingPause, pauseWords, type PairRoute } from "./pairingPause.js";
import { createAttachmentStore } from "../attachments/attachmentStore.js";
import { BrowserBridge } from "../browser/browserBridge.js";
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
import { VoiceService } from "../voice/voiceService.js";
import { CanvasService } from "../canvas/canvasService.js";
import { connectLoopback } from "../forward/portForward.js";
import { CanvasWatcher } from "../canvas/canvasWatcher.js";
import { canvasInfoOf, listCanvas, readBoard } from "../canvas/canvasFolder.js";
import { Publisher } from "../publish/publisher.js";
import { ShareClient, type Fetch } from "../publish/shareClient.js";
import { CommentService } from "../publish/comments.js";
import { OwnerName } from "../publish/owner.js";
import { assetFiles, readAsset } from "../publish/publishFolder.js";
import { OFFICIAL_SHARE_URL, turnKindOf } from "@grenade/protocol";
import { PromptStore } from "../prompts/promptStore.js";
import { PromptTests } from "../prompts/promptTests.js";
import { promptText } from "../prompts/promptText.js";
import { SentInputs } from "./sentInputs.js";
import { PlanLimits } from "../usage/planLimits.js";
import { ConnectorReader } from "../connectors/connectorReader.js";
import { claudeStatusUsage, STATUS_LINE_PATH } from "../usage/claudeStatusLine.js";
import { readCodexUsage, readUserStatusLine } from "../usage/readUsage.js";
import { homedir } from "node:os";
import { TALK_AGENT_KINDS, type TalkAgentKind } from "../talk/talkAgents.js";
import { resolveTalkBin, runTalkAgent, type TalkRun } from "../talk/talkRunner.js";
import { TalkService } from "../talk/talkService.js";
import { HighlightsService } from "../highlights/highlightsService.js";
import { CanvasWork } from "../canvas/canvasWork.js";
import { GroupCanvasMover } from "../canvas/groupCanvasMover.js";
import { PictureStore } from "../highlights/pictureStore.js";
import { TalkTools } from "../talk/talkTools.js";
import { diskPlanFiles, PlanTracker, watchPlanFile } from "../plans/planTracker.js";
import { TodoStore } from "../todos/todoStore.js";
import { LibraryStore } from "../library/libraryStore.js";
import { ChangesTracker } from "../changes/changesTracker.js";
import { workOfHook, type HookWork } from "../changes/sessionWork.js";
import { enterClaudePlanMode } from "../plans/claudePlanMode.js";
import { shellLaunch, writeShellPrompt } from "../platform/shellPrompt.js";

/** The largest message a socket on :7788 takes, the relay's cap too: a sealed 2 MiB attachment is about 3.75 MB. */
export const WS_MAX_MESSAGE_BYTES = 4 * 1024 * 1024;

export interface DaemonOptions {
  port?: number;
  controlPort?: number;
  name?: string;
  advertise?: boolean;
  log?: Logger;
  tmux?: Tmux;
  /** Why a session of an agent cannot start (`missingAgent`: its program is not on PATH). Default: that check, unless `tmux` is a test's. */
  missingAgent?: (agent: string) => string | null;
  tokensPath?: string | null;
  /** Where the pairing pause keeps its count (PROTOCOL.md "Pausing after wrong codes"); none when `tokensPath` is null. */
  pairingPausePath?: string;
  sessionsPath?: string | null;
  /** Claude Code's folder, where past conversations are read from (PROTOCOL.md "Conversations"). Default: paths.claudeDir. */
  claudeDir?: string;
  /** Codex's folder, where its past conversations are read from. Default: paths.codexDir. */
  codexDir?: string;
  /** Mirror sessions into terminal tabs. Pins it; without it `GRENADE_TERMINAL`, else `~/.grenade/terminal.json` read at every event (`none` when missing). */
  terminal?: TerminalKind;
  /** One-sentence session summaries via `claude -p` (Haiku). Defaults to on unless `GRENADE_SUMMARIES=off`. */
  summaries?: boolean;
  /** Connect to the relay in relay.json. Defaults to on; `--no-relay` turns it off. */
  relay?: boolean;
  relayPath?: string;
  e2eKeyPath?: string;
  /** Folder for files phones upload (`attachment` frames). Defaults to ~/.grenade/attachments. */
  attachmentsDir?: string;
  /** Where highlights keep their copies of pictures. Default: paths.highlights. */
  highlightsDir?: string;
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
  /** Where the phones' Mac boards are kept. Defaults to ~/.grenade/push-boards.json; in memory when tokens are. */
  pushBoardsPath?: string;
  /** Where the owner's voice provider keys are kept (PROTOCOL.md "Voice providers"). Defaults to ~/.grenade/voice-keys.json; in memory when tokens are. */
  voiceKeysPath?: string;
  /** How the daemon reaches a voice provider. Tests pass a fake. */
  voiceFetch?: typeof fetch;
  /** published.json (PROTOCOL.md "Publishing"). With `tokensPath: null` and none given, this daemon publishes nothing. */
  publishedPath?: string;
  /** The share host; default `GRENADE_SHARE_URL`, else the official one. */
  shareUrl?: string;
  /** How the share host is reached (tests). */
  shareFetch?: Fetch;
  /**
   * Updates (src/update/): ask the tap for the latest release (default on unless GRENADE_UPDATE_CHECK=off), watch the
   * version on disk behind `program` (the `grenade` command; none: nothing to watch), and call `restart` once a newer
   * one is there and no session is busy. Without `restart` the daemon only logs it. With `program` it also installs a
   * newer release itself, with the installer of that copy, unless `grenade update --auto off` (or `auto` here) says not.
   */
  updates?: { checkTap?: boolean; program?: string; restart?(installed: string): void; auto?: boolean };
  /**
   * Typed Talk (PROTOCOL.md "Talk by text"): where its day files and work folder are (default ~/.grenade/talk; with
   * `tokensPath: null` and none given, this daemon answers no typed Talk), `talk.json`, the agents that can answer
   * (default: those installed), how a turn runs (tests pass a fake) and the CLI whose `talk-mcp` the agent starts
   * (default: the script this process runs).
   */
  talk?: { dir?: string; settingsPath?: string; agents?: TalkAgentKind[]; run?: TalkRun; cli?: string };
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
  const publishedPath = opts.publishedPath ?? (opts.tokensPath === null ? undefined : paths.published);
  // Typed Talk: the agents installed here can answer it (PROTOCOL.md "Agents", `talk`).
  const talkDir = opts.talk?.dir ?? (opts.tokensPath === null ? undefined : paths.talk);
  const talkAgents: TalkAgentKind[] = talkDir ? (opts.talk?.agents ?? TALK_AGENT_KINDS.filter((k) => resolveTalkBin(k) !== undefined)) : [];
  const agents = AGENTS.map((a) => ((talkAgents as string[]).includes(a.kind) ? { ...a, talk: true as const } : a));
  const info: DaemonInfo = { id: loadDaemonId(), name: opts.name ?? defaultName(), version: VERSION, os: daemonOs(), key: e2eKey.publicKey.toString("base64"), e2e: 1, inputSent: 1, conversations: 1, conversationDelete: 1, term: 1, forward: 1, folders: 1, board: 1, groupNames: 1, keptGroups: 1, sessionTitles: 1, resumeEnded: 1, continueOriginal: 1, voice: 1, canvas: 1, canvases: 1, groupCanvasCwd: 1, limits: 1, connectors: 1, plans: 1, todos: 1, projectTodos: 1, library: 1, libraryProjects: 1, changes: 1, browser: 1, ...(publishedPath ? { publish: 1 as const, comments: 1 as const } : {}), codexActivity: 1, ...(talkDir ? { talk: 1 as const, talkHistory: 1 as const, highlights: 1 as const } : {}), agents };
  const allowPlainLan = opts.allowPlainLan === true;
  // Every agent starts with Grenade's hooks for this port: nothing in ~/.claude or ~/.codex has to change.
  const tmux = opts.tmux ?? createTmux({ agentFlags: {
        // Read as each session starts, so a status line the user set up since is the one it runs.
        get claude() {
          // Every session is told where its group's canvas is (`grenade canvas`) and how to add to its to-dos (`grenade
          // todo`); on a Mac, also to test web pages in the app's toolbox (`grenade browser`).
          const shared = `${CANVAS_INSTRUCTIONS}\n\n${TODO_INSTRUCTIONS}`;
          const instructions = process.platform === "darwin" ? `${BROWSER_INSTRUCTIONS}\n\n${shared}` : shared;
          return claudeHookFlags(port, readUserStatusLine(join(opts.claudeDir ?? paths.claudeDir, "settings.json")), instructions);
        },
        codex: codexHookFlags(port),
        // Shells start with Grenade's prompt, its files written (again, if a new version changed them) as each starts.
        shell: (shell: string) => {
          try {
            writeShellPrompt(paths.shell);
            return shellLaunch(shell, paths.shell, process.env["ZDOTDIR"]);
          } catch (e) {
            log.warn("Could not write the shell prompt; the shell starts with its own", { error: e });
            return shell;
          }
        },
      }, serverScope: underSystemd() });
  const tokens = new TokenStore(opts.tokensPath === null ? undefined : (opts.tokensPath ?? paths.tokens));
  const codes = new PairingCodes();
  const pairing = new PairingWatch();
  // Beside tokens.json, so a test daemon with its own tokens keeps its own count.
  const pausePath = opts.tokensPath === null ? undefined : (opts.pairingPausePath ?? (opts.tokensPath ? join(dirname(opts.tokensPath), "pairing-pause.json") : paths.pairingPause));
  const pause = new PairingPause(pausePath);
  const registry = new SessionRegistry({
    tmux,
    log,
    missingAgent: opts.missingAgent ?? (opts.tmux ? () => null : missingAgent),
    ...(opts.sessionsPath === null ? {} : { persistPath: opts.sessionsPath ?? paths.sessions }),
  });
  const summarizer = startSummarizer(registry, log, opts.summaries ?? process.env["GRENADE_SUMMARIES"] !== "off");
  await registry.adopt();
  // What each session's agent does with its plan, and its plan file (PROTOCOL.md "Plans").
  const plans = new PlanTracker(undefined, opts.claudeDir ?? paths.claudeDir);
  plans.on("plan", (id, plan) => registry.setPlan(id, plan, plans.pathOf(id)));
  for (const { id, path } of registry.planPaths()) plans.restore(id, path);
  // The user edited a plan since its agent last wrote it: the next thing they say tells the agent.
  registry.noteOnSubmit = (id) => plans.takeEditedNote(id);
  // An interrupt ends a turn without a hook.
  registry.on("updated", (s) => {
    if (s.status !== "working") plans.turnOver(s.id);
  });
  registry.on("removed", (id) => plans.forget(id));
  // Each session's to-do list (PROTOCOL.md "To-dos"), saved beside sessions.json as groups.json is.
  const todosPath = opts.sessionsPath === null ? undefined : opts.sessionsPath ? join(dirname(opts.sessionsPath), "todos.json") : paths.todos;
  // A conversation's folder, for a to-do list kept with it from before lists were the project's: its transcript's `cwd`.
  const conversationFolder = (conversation: string): string | undefined => {
    try {
      const projects = join(paths.claudeDir, "projects");
      for (const dir of readdirSync(projects)) {
        const file = join(projects, dir, `${conversation}.jsonl`);
        if (!existsSync(file)) continue;
        return /"cwd":"((?:[^"\\]|\\.)*)"/.exec(readFileSync(file, "utf8").slice(0, 200_000))?.[1];
      }
    } catch {
      // No Claude Code folder: the list waits for a session that resumes it.
    }
    return undefined;
  };
  const todos = new TodoStore(registry, log, todosPath, undefined, undefined, todosPath ? conversationFolder : undefined);
  // Saved beside sessions.json, so a test daemon with its own sessions file keeps its own order too.
  const groupsPath = opts.sessionsPath === null ? undefined : opts.sessionsPath ? join(dirname(opts.sessionsPath), "groups.json") : paths.groups;
  const groupOrder = new GroupOrderStore(registry, log, groupsPath);
  // A session started in (or moved into) a group kept with no session joins it (PROTOCOL.md "Kept groups").
  registry.keptGroups = groupOrder;
  const poller: Poller = startPoller({ tmux, registry, log });
  const pinnedTerminal = opts.terminal ?? terminalFromEnv();
  const mirror = new TerminalMirror({ registry, log, terminal: pinnedTerminal ?? (() => readTerminalSetting()) });
  const terminalStatus = (): TerminalStatus => ({ ...mirror.status(), pinned: pinnedTerminal !== undefined });
  mirror.start().catch((e) => log.warn("Could not mirror sessions into a terminal", { error: e }));

  // Each agent's plan windows on this computer, answered to `limits` (PROTOCOL.md "Usage").
  const planLimits = new PlanLimits();
  const connectors = new ConnectorReader();

  const http = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      if (req.method === "GET" && url.pathname === "/health") return sendJson(res, 200, { ok: true, ...info });
      // Everything else on this port is for the apps, the hooks and the CLI, never for a web page (`fromWebPage`).
      if (fromWebPage(req.headers.origin)) return sendJson(res, 403, { error: "forbidden" });
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
      if (req.method === "POST" && url.pathname === STATUS_LINE_PATH) {
        // Claude Code's status line payload (PROTOCOL.md "Usage"): the context and the plan windows.
        if (!isLoopback(req.socket.remoteAddress)) return sendJson(res, 403, { error: "forbidden" });
        applyStatusLine(url.searchParams.get("session"), await readBody(req));
        return sendJson(res, 200, { ok: true });
      }
      if (req.method === "POST" && url.pathname === "/hooks/codex") {
        if (!isLoopback(req.socket.remoteAddress)) return sendJson(res, 403, { error: "forbidden" });
        const codexSession = url.searchParams.get("session");
        const codexBody = await readBody(req);
        noteChangesHook(codexSession, codexBody);
        const r = applyCodexHook(codexSession, codexBody);
        noteCanvasHook(codexSession, codexBody);
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
  // Where each session's work stands in git, and its pushes (PROTOCOL.md "Changes").
  const changes = new ChangesTracker({ registry, activity, log });
  changes.start();
  registry.on("created", (s) => void changes.refresh(s.id));
  registry.on("removed", (id) => changes.forget(id));
  // Which session saved which board in which turn: the canvas card and Command Center's board tiles (PROTOCOL.md "The canvas card").
  const canvasWork = new CanvasWork({ registry, activity, home: homedir(), log });
  registry.on("updated", (s) => canvasWork.statusChanged(s));
  /**
   * What each session's newest turn is doing (PROTOCOL.md "Session", `turn`), so a list can say "Designing" and
   * "Designed" without the session's activity: worked out again whenever its activity, status, plan, writes or boards
   * change. `noteTurn` sends nothing when it is the same, so the update it causes ends here.
   */
  const refreshTurn = (id: string) => {
    const s = registry.get(id);
    if (!s) return;
    const entries = activity.entriesOf(id);
    const working = s.status === "working";
    const turn = entries.length === 0 && !working ? undefined
      : turnKindOf(entries, { planning: s.plan?.planning === true, drawing: canvasWork.drawing(id), edited: s.edited === true, working });
    registry.noteTurn(id, turn);
  };
  registry.on("updated", (s) => refreshTurn(s.id));
  activity.on("activity", (frame) => refreshTurn(frame.sessionId));
  registry.on("removed", (id) => canvasWork.forget(id));
  /** A hook of a session's agent, for its git changes: what the tool call wrote or committed is the session's work. */
  const noteChangesHook = (session: string | null, body: string) => {
    if (!session || !registry.get(session)) return;
    let work: HookWork | undefined;
    try {
      const p = JSON.parse(body || "{}") as { hook_event_name?: unknown; tool_name?: unknown; tool_input?: unknown; tool_response?: unknown; cwd?: unknown };
      work = workOfHook(p.hook_event_name, p.tool_name, p.tool_input, p.tool_response, typeof p.cwd === "string" ? p.cwd : registry.get(session)?.cwd);
    } catch {
      // Not JSON: the status hook answers that; the folder is read all the same.
    }
    changes.noteHook(session, work);
  };
  /** A hook's tool call, for the boards it wrote. */
  const noteCanvasHook = (session: string | null, body: string) => {
    if (!session || !registry.get(session)) return;
    try {
      const p = JSON.parse(body || "{}") as { hook_event_name?: unknown; tool_name?: unknown; tool_input?: unknown; cwd?: unknown };
      canvasWork.hook(session, p.hook_event_name, p.tool_name, p.tool_input, typeof p.cwd === "string" ? p.cwd : undefined);
      refreshTurn(session);
    } catch {
      // Not JSON: the status hook answers that.
    }
  };
  const transcripts = new TranscriptReader();
  /**
   * Reads a session's transcript: new activity into the store, a moved working directory and a new title into the
   * session. A Codex session's transcript is its rollout, read by Codex's rule; only Claude Code's says more.
   */
  const readActivity = (id: string, path: string) =>
    transcripts.readChunk(path).then(({ jsonl, fromStart }) => {
      if (registry.get(id)?.agent === "codex") {
        const entries = codexActivityEntriesIn(jsonl);
        activity.append(id, entries);
        return entries;
      }
      const entries = activityEntriesIn(jsonl);
      // A resumed session's copy repeats the whole history: it takes the place of what the store holds.
      if (fromStart && registry.get(id)?.resumedFrom !== undefined) activity.replace(id, entries);
      else activity.append(id, entries);
      const cwd = workingDirectoryIn(jsonl);
      if (cwd) registry.setCwd(id, cwd);
      const title = clipTitle(aiTitleIn(jsonl) ?? "");
      if (title) registry.setAiTitle(id, title);
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
  // Codex says when Esc stopped a turn (`Interrupt`), but may write `turn_aborted` to its rollout a moment later:
  // read until it is there.
  const codexStopCatchUp = new CatchUp(async (id, path) => (await readActivity(id, path)).some((e) => e.kind === "stopped"));
  // Hooks alone left the reply waiting for the next prompt at times: follow a working session's transcript as it is
  // written, and for a while after its turn ends.
  const follower = new TranscriptFollower({
    read: readActivity,
    size: async (path) => (await stat(path)).size,
    isWorking: (id) => registry.get(id)?.status === "working",
  });
  const interrupted = (id: string) => {
    const session = registry.get(id);
    const path = registry.transcriptOf(id);
    // A session that only waits for background tasks is at its prompt already: Esc stops nothing there.
    if (session?.agent === "claude" && session.status === "working" && !session.background && path) interruptCatchUp.start(id, path);
  };
  // The store lives in memory: after a restart, read every saved transcript from its start rather than wait for
  // each session's next hook, so a phone sees what was said the moment it subscribes.
  for (const { id, path } of registry.transcripts()) {
    readActivity(id, path).catch((e) => log.debug("Could not read the activity from a saved transcript", { session: id, path, error: e }));
    if (registry.get(id)?.status === "working") follower.follow(id, path);
  }

  // Past conversations of every agent that keeps them (PROTOCOL.md "Conversations"). Read only; Grenade's marks live beside sessions.json.
  const marksPath = opts.sessionsPath === null ? undefined : opts.sessionsPath ? join(dirname(opts.sessionsPath), "conversations.json") : paths.conversations;
  const marks = new ConversationMarks(log, marksPath);
  const held = () => heldConversations(registry.transcripts(), (id) => (registry.get(id)?.status ?? "gone") !== "gone");
  const talkWorkDir = talkDir ? join(talkDir, "work") : undefined;
  // Every conversation a Grenade session is in, running or ended (but `except`'s): never "open elsewhere" for Codex.
  const sessionsConversations = (except?: string) => new Set(registry.transcripts().filter((t) => t.id !== except).map((t) => conversationIdOf(t.path)));
  const codexConversations = new CodexConversations({ codexDir: opts.codexDir ?? paths.codexDir, marks, held, ours: () => sessionsConversations() });
  const conversationIndex = new AllConversations(
    [new ConversationIndex({ claudeDir: opts.claudeDir ?? paths.claudeDir, marks, held }), codexConversations],
    // Typed Talk's own conversations are the daemon's, not the owner's.
    (cwd) => talkWorkDir !== undefined && (cwd === talkWorkDir || cwd.startsWith(`${talkWorkDir}/`)),
  );
  // Switching a session's model (PROTOCOL.md "Models"). How it is done is the agent's own: Claude Code's picker.
  const switchingModel = new Set<string>();
  // The owner's keys for Talk, and the short-lived tokens clients get in their place.
  const voice = new VoiceService({
    path: opts.voiceKeysPath ?? (opts.tokensPath === null ? undefined : paths.voiceKeys),
    daemonId: info.id,
    log,
    ...(opts.voiceFetch ? { fetch: opts.voiceFetch } : {}),
  });
  // A group's design canvas (PROTOCOL.md "Canvas"): only the folders of the sessions it lists, read and never written.
  const canvasWatcher = new CanvasWatcher(undefined, undefined, (folder, error) => log.debug("Could not look at a canvas", { folder, error: error instanceof Error ? error.message : String(error) }));
  // A kept group's folder and canvases are served as its sessions' were (PROTOCOL.md "Kept groups").
  // Every canvas and plan by project, whatever happened to its group (PROTOCOL.md "Library"), saved beside sessions.json.
  const library = new LibraryStore({
    registry,
    kept: () => groupOrder.frame().kept ?? [],
    onKeptChanged: (cb) => groupOrder.on("changed", cb),
    plans,
    conversationFolders: async () => (await conversationIndex.list(true)).map((c) => c.cwd),
    claudeDir: opts.claudeDir ?? paths.claudeDir,
    home: homedir(),
    log,
    ...(opts.sessionsPath === null ? {} : { path: opts.sessionsPath ? join(dirname(opts.sessionsPath), "library.json") : paths.library }),
  });
  if (opts.sessionsPath !== null) void library.backfill();
  // A session may be started again in a group the Library remembers, as in a kept group (PROTOCOL.md "Library").
  registry.keptGroups = { keptGroup: (group) => groupOrder.keptGroup(group) ?? library.rememberedGroup(group) };
  // A group the Library remembers is served as a kept group is (PROTOCOL.md "Library", "A canvas").
  const canvas = new CanvasService(() => [...registry.list(), ...groupOrder.standIns(), ...library.standIns()], canvasWatcher);
  // Canvases published to secret links (PROTOCOL.md "Publishing"): the daemon keeps each page up to date as boards are saved.
  // Comments on those links (PROTOCOL.md "Comments"), pulled from the share host, and the owner's name the pages show.
  const shareClient = new ShareClient(opts.shareUrl ?? process.env["GRENADE_SHARE_URL"] ?? OFFICIAL_SHARE_URL, opts.shareFetch);
  const owner = publishedPath ? new OwnerName(join(dirname(publishedPath), "owner.json")) : undefined;
  let comments: CommentService | undefined;
  const publisher = publishedPath
    ? new Publisher({
        path: publishedPath,
        client: shareClient,
        ownerName: () => owner?.name ?? "",
        commentsOf: (token) => comments?.summary(token),
        folderOf: (pick) => canvas.folderOf(pick),
        nameOf: async (folder, id) => (await canvasInfoOf(folder, id)).name,
        listCanvas: (folder) => listCanvas(folder),
        watchCanvas: (folder, current, onChange) => canvasWatcher.watch(folder, current, () => onChange()),
        readBoard: (folder, file) => readBoard(folder, file, computerWord()),
        assetFiles,
        readAsset,
        planOf: (sessionId) => {
          const session = registry.get(sessionId);
          const path = plans.pathOf(sessionId);
          return session && path && agentInfo(session.agent)?.plans ? { path, cwd: session.cwd } : undefined;
        },
        readPlan: async (path) => {
          const file = await diskPlanFiles.read(path);
          return file ? Buffer.from(file.text, "utf8") : null;
        },
        watchPlan: (path, onChange) => watchPlanFile(path, onChange),
        log,
      })
    : undefined;
  // `group.canvasCwd` (PROTOCOL.md "Canvas", "Moving a group's canvases"): a group's canvases to another project, its links with them.
  const canvasMove = new GroupCanvasMover({ registry, groups: groupOrder, publish: publisher, home: homedir(), log });
  if (publisher && publishedPath) {
    const service = new CommentService({
      dir: join(dirname(publishedPath), "comments"),
      client: shareClient,
      links: () => publisher.commentLinks(),
      ownerName: () => owner?.name ?? "",
      log,
    });
    comments = service;
    service.on("changed", () => publisher.touch());
    owner?.on("changed", () => publisher.refreshAll());
  }
  const models: ModelsPort = {
    async switch(session, model, effort) {
      if (switchingModel.has(session.id)) throw new ModelSwitchError("A model switch is already under way in this session.");
      switchingModel.add(session.id);
      try {
        // Straight to tmux: what is typed here is no prompt, so nothing the registry does for one applies.
        const terminal: ModelTerminal = {
          lines: async () => (await tmux.capture(session.id)).lines,
          type: (text) => tmux.sendText(session.id, text, false),
          key: (key) => tmux.sendKey(session.id, key),
        };
        const switched = await switchClaudeModel(terminal, model, effort);
        return registry.chooseModel(session.id, model, switched.effort);
      } finally {
        switchingModel.delete(session.id);
      }
    },
  };

  const conversations: ConversationsPort = {
    // An ended session a conversation was in last (still listed) is named, so a client continues it there.
    list: async (anyAgent) => withLastSessions(await conversationIndex.list(anyAgent), registry.list(), registry.transcripts()),
    preview: (id) => conversationIndex.preview(id),
    async delete(id) {
      const target = await conversationIndex.trashPaths(id);
      if ("refused" in target) return target.refused;
      try {
        await moveToTrash(target.paths);
      } catch (e) {
        log.warn("Could not move a conversation to the Trash", { conversation: id, error: e });
        return `the ${computerWord()} could not move it to the Trash`;
      }
      log.info(`Moved conversation ${id} to the Trash`, { paths: target.paths.join(",") });
      return null;
    },
    async resume({ name, agent, group, conversationId, same }) {
      const found = await conversationIndex.find(conversationId);
      if (!found || found.agent !== agent) return `no ${agent} conversation ${conversationId} on this ${computerWord()}`;
      // The conversation itself when asked, unless its agent has it open elsewhere: then a copy (PROTOCOL.md "The same conversation").
      const fork = !same || (await conversationIndex.openElsewhere(conversationId));
      const session = await registry.create({ name, cwd: found.cwd, agent, group, resume: conversationId, fork });
      ended.holdFirstPrompt(session);
      // The agent writes the copy only with its first prompt; until then the session shows the original's history.
      // Read whole here, not through the reader, whose place in that file may belong to another session.
      registry.setTranscript(session.id, found.path);
      const history = await conversationIndex.preview(conversationId);
      if (history) activity.replace(session.id, history);
      log.info(fork ? `Resumed a copy of conversation ${conversationId}` : `Continued conversation ${conversationId}`, { session: session.id, cwd: found.cwd });
      return session;
    },
  };

  // An ended session started again in its place (PROTOCOL.md "Conversations", "An ended session").
  const ended = new EndedSessions({
    get: (id) => registry.get(id),
    transcriptOf: (id) => registry.transcriptOf(id),
    restart: (id, o) => registry.restart(id, o),
    setTranscript: (id, path) => registry.setTranscript(id, path),
    findConversation: (id) => conversationIndex.find(id),
    previewConversation: (id) => conversationIndex.preview(id),
    replaceActivity: (id, entries) => activity.replace(id, entries),
    openElsewhere: (id) => conversationIndex.openElsewhere(id),
    codexRolloutFor: (cwd, since, others) => codexConversations.rolloutFor(cwd, since, others),
    othersConversations: (id) => sessionsConversations(id),
    resumes: (agent) => AGENTS.some((a) => a.kind === agent && "conversations" in a && a.conversations === true),
    screenLines: (id) => registry.screenOf(id)?.lines,
    now: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  });

  /** One hook event of a session: its plan, status, summary input, model, activity and the text of a push. */
  const applyClaudeHook = (session: string | null, body: string) => {
    if (session) notePlanHook(session, body);
    noteChangesHook(session, body);
    const result = applyClaudeStatusHook(session, body);
    noteCanvasHook(session, body);
    return result;
  };
  const notePlanHook = (session: string, body: string) => {
    try {
      const payload: unknown = JSON.parse(body || "{}");
      if (typeof payload === "object" && payload !== null && registry.get(session)) plans.hook(session, payload);
    } catch {
      // Not JSON: the status hook answers that.
    }
  };
  const applyClaudeStatusHook = (session: string | null, body: string) =>
    handleClaudeHook(
      registry,
      session,
      body,
      log,
      (id, prompt) => {
        // Claude Code tells itself that a background task ended with a prompt of its own; the user asked nothing.
        if (!prompt.trimStart().startsWith("<task-notification>")) summarizer?.notePrompt(id, prompt);
        activity.noteAsked(id, prompt, new Date().toISOString());
        talk?.noteAsked(id, prompt);
        highlights?.turnStarted(id, prompt);
      },
      (id, path, event) => {
        // A resumed session names its copy from the first prompt on: remember it as Grenade's copy.
        const resumedFrom = registry.get(id)?.resumedFrom;
        if (resumedFrom && conversationIdOf(path) !== resumedFrom) marks.noteCopy(conversationIdOf(path), resumedFrom);
        registry.setTranscript(id, path);
        readTranscriptModel(path)
          .then((read) => read && registry.setModel(id, read.model, read.effort, read.at))
          .catch((e) => log.debug("Could not read the model from a transcript", { session: id, path, error: e }));
        catchUp.cancel(id);
        interruptCatchUp.cancel(id);
        follower.follow(id, path);
        readActivity(id, path)
          .then((entries) => {
            if (event === "Stop" && !entries.some((e) => e.kind === "said")) catchUp.start(id, path);
          })
          .catch((e) => log.debug("Could not read the activity from a transcript", { session: id, path, error: e }));
      },
      (id, message) => push.pusher.noteAsked(id, message),
    );

  /** One Codex hook event: status, summary input, model and activity (PROTOCOL.md "Codex hooks"). */
  const applyCodexHook = (session: string | null, body: string) =>
    handleCodexHook(registry, session, body, log, {
      onModel: (id, model) => registry.setModel(id, model),
      background: (id) => codexBackgroundIn(registry.screenOf(id)?.lines ?? []),
      onPrompt: (id, prompt) => {
        summarizer?.notePrompt(id, prompt);
        activity.noteAsked(id, prompt, new Date().toISOString());
        talk?.noteAsked(id, prompt);
        highlights?.turnStarted(id, prompt);
      },
      onTranscript: (id, path, event) => {
        registry.setTranscript(id, path);
        readCodexUsage(path)
          .then((usage) => {
            if (usage?.context) registry.setContext(id, usage.context);
            if (usage) planLimits.record("codex", usage.limits);
          })
          .catch((e) => log.debug("Could not read the usage from a Codex rollout", { session: id, path, error: e }));
        catchUp.cancel(id);
        codexStopCatchUp.cancel(id);
        follower.follow(id, path);
        readActivity(id, path)
          .then((entries) => {
            if (event === "Stop" && !entries.some((e) => e.kind === "said")) catchUp.start(id, path);
            if (event === "Interrupt" && !entries.some((e) => e.kind === "stopped")) codexStopCatchUp.start(id, path);
          })
          .catch((e) => log.debug("Could not read the activity from a Codex rollout", { session: id, path, error: e }));
      },
    });

  /**
   * What each Claude Code session's context holds (PROTOCOL.md "Usage", "Where it goes"): its folder measured by a
   * promptless claude, the conversation the rest. Off with GRENADE_CONTEXT_PROBE=off, or when claude is not found.
   */
  const claudeForContext = process.env["GRENADE_CONTEXT_PROBE"] === "off" ? undefined : resolveClaudeBin();
  const statusContexts = new Map<string, SessionContext>();
  const contextBreakdown = claudeForContext
    ? new ContextBreakdown({
        probe: (cwd) => probeContext(claudeForContext, cwd),
        onMeasured: (cwd) => {
          for (const [id, context] of statusContexts) {
            const s = registry.get(id);
            if (s?.cwd === cwd) registry.setContext(id, contextBreakdown!.of(cwd, context));
          }
        },
        log,
      })
    : undefined;

  /** One Claude Code status line payload: the session's context by Claude Code's own count, and the plan windows. */
  function applyStatusLine(session: string | null, body: string): void {
    let payload: unknown;
    try {
      payload = JSON.parse(body || "{}");
    } catch {
      return;
    }
    const usage = claudeStatusUsage(payload, new Date().toISOString());
    planLimits.record("claude", usage.limits);
    if (!session || !usage.context) return;
    const cwd = registry.get(session)?.cwd;
    statusContexts.set(session, usage.context);
    registry.setContext(session, contextBreakdown && cwd ? contextBreakdown.of(cwd, usage.context) : usage.context);
  }

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
    const verdict = checkPair(body.data.code, "lan");
    if (!verdict.ok) {
      const pausedUntil = verdict.pausedUntil === undefined ? {} : { pausedUntil: new Date(verdict.pausedUntil).toISOString() };
      return sendJson(res, verdict.code === "too_many_attempts" ? 429 : 400, { error: verdict.code, ...pausedUntil });
    }
    const token = tokens.issue(body.data.client);
    pairing.paired(body.data.client, "lan");
    log.info(`Paired a new phone: ${body.data.client.name}`, { platform: body.data.client.platform });
    sendJson(res, 200, { token, daemon: info });
  }

  /** `pair` inside an encrypted channel, with the typed code or a pairing offer's secret. */
  function pairPhone(credential: string, client: ClientInfo, route: Route): PairVerdict {
    const verdict = checkPair(credential, route);
    if (!verdict.ok) return verdict;
    const token = tokens.issue(client, { sealed: true });
    pairing.paired(client, route);
    log.info(`Paired a new phone: ${client.name}`, { platform: client.platform, route });
    return { ok: true, token };
  }

  /**
   * One pairing try, from either route (PROTOCOL.md "Pausing after wrong codes"): refused while paused, uncounted;
   * a wrong try while a code is live counts, and every fifth pauses pairing and throws the code away.
   */
  function checkPair(credential: string, route: PairRoute): { ok: true } | (PairVerdict & { ok: false }) {
    const paused = pause.pausedUntil();
    if (paused !== null) return { ok: false, code: "too_many_attempts", pausedUntil: paused, message: pausedSentence(paused) };
    const live = codes.liveSecret() !== null;
    const verdict = codes.verify(credential);
    if (verdict === "ok") {
      pause.succeeded();
      return { ok: true };
    }
    const strike = live ? pause.wrong(route) : null;
    if (strike) {
      codes.void();
      pairing.voided();
      log.warn(`Pairing paused for ${pauseWords(strike.pausedUntil - strike.at)} after ${strike.tries} wrong codes`, { route, strike: strike.strike });
      return { ok: false, code: "too_many_attempts", pausedUntil: strike.pausedUntil, message: pausedSentence(strike.pausedUntil) };
    }
    if (verdict === "too_many_attempts") pairing.voided();
    return { ok: false, code: verdict };
  }

  function pausedSentence(until: number): string {
    return `${info.name} has paused pairing after too many wrong codes. Try again in ${pauseWords(Math.max(until - Date.now(), 60_000))}, with a new code.`;
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
  const browser = new BrowserBridge({ computer: computerWord() });
  const push = startPush({
    registry,
    tokens,
    daemon: info,
    staticKey: e2eKey,
    relay: () => (opts.relay === false ? null : loadRelayConfig(opts.relayPath ?? paths.relay)),
    configPath: opts.pushPath ?? paths.push,
    devicesPath: opts.pushDevicesPath ?? (opts.tokensPath === null ? undefined : paths.pushDevices),
    boardsPath: opts.pushBoardsPath ?? (opts.tokensPath === null ? undefined : paths.pushBoards),
    log,
  });
  const live = new LiveConnections();

  // Prompts Claude Code is showing, which a phone can answer (PROTOCOL.md "Prompts").
  const prompts = new PromptStore();
  const promptTests = new PromptTests(prompts);
  prompts.on("opened", (frame) => push.pusher.noteAsked(frame.sessionId, promptText(frame)));
  // An answer is not a new turn: a session that background tasks held before the question is held again.
  prompts.on("answered", (id) => registry.applyHook(id, "working", undefined, true));
  // Dialogs read off the screen are cards too (PROTOCOL.md "Codex dialogs", "Claude Code dialogs").
  const screenPrompts = new ScreenPrompts(registry, prompts, log, (id) => switchingModel.has(id));
  // What an agent left running when its turn ended holds the session working (PROTOCOL.md "Background tasks"):
  // Codex's is read off its screen, and Claude Code's own files say when a task ended without a hook.
  watchScreenBackground(registry);
  const backgroundWatch = new ClaudeBackgroundWatch(registry, join(opts.claudeDir ?? paths.claudeDir, "sessions"), log);
  backgroundWatch.start();
  registry.on("removed", (id) => {
    prompts.closeSession(id);
    activity.forget(id);
    catchUp.cancel(id);
    interruptCatchUp.cancel(id);
    codexStopCatchUp.cancel(id);
    follower.forget(id);
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
      return gone ? { closed: closeConnectionsOf([gone], `unpaired on the ${computerWord()}`) } : null;
    },
    unpairAll(): { removed: number; closed: number } {
      const gone = tokens.revokeAll();
      return { removed: gone.length, closed: closeConnectionsOf(gone, `unpaired on the ${computerWord()}`) };
    },
  };

  /** The prompts phones sent with an id, so one sent again after a dropped connection is typed once. */
  const sentInputs = new SentInputs();

  // Typed Talk (PROTOCOL.md "Talk by text"): an agent on this computer with Grenade's tools, one turn at a time.
  const talk = talkDir && talkWorkDir
    ? new TalkService({
        dir: talkDir,
        workDir: talkWorkDir,
        settingsPath: opts.talk?.settingsPath ?? paths.talkSettings,
        tools: new TalkTools({
          sessions: () => registry.list(),
          screenLines: (id) => registry.screenOf(id)?.lines,
          entriesOf: (id) => activity.entriesOf(id),
          openPrompt: (id) => prompts.list().find((p) => p.sessionId === id),
          agentName: (kind) => AGENTS.find((a) => a.kind === kind)?.name ?? kind,
          hasActivity: (kind) => AGENTS.some((a) => a.kind === kind && "activity" in a && a.activity === true),
          codingAgents: () => AGENTS.filter((a) => "activity" in a && a.activity === true).map((a) => a.kind),
          conversationFolders: async () => (await conversationIndex.list(true)).map((c) => c.cwd),
          home: homedir(),
          create: (input) => registry.create(input),
          type: (id, text) => registry.sendText(id, text, true),
          now: () => Date.now(),
          sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
        }),
        registry,
        // The feed (PROTOCOL.md "The feed"): every coding session's turns, from its own status and words.
        feed: {
          entriesOf: (id) => activity.entriesOf(id),
          askingOf: (id) => {
            const open = prompts.list().find((p) => p.sessionId === id);
            return open ? promptText(open) : undefined;
          },
          hasActivity: (kind) => AGENTS.some((a) => a.kind === kind && "activity" in a && a.activity === true),
        },
        agents: talkAgents,
        agentName: (kind) => AGENTS.find((a) => a.kind === kind)?.name ?? kind,
        run: opts.talk?.run ?? runTalkAgent,
        mcp: { command: process.execPath, args: [opts.talk?.cli ?? process.argv[1] ?? join(import.meta.dirname, "..", "cli.js"), "talk-mcp"] },
        controlPort,
        log,
        computer: computerWord(),
      })
    : undefined;

  // Highlights (PROTOCOL.md "Highlights"): what a turn made, on its `finished` row, from what the daemon already has.
  const highlights = talk
    ? new HighlightsService({
        registry,
        entriesOf: (id) => activity.entriesOf(id),
        boardsOf: (id, from, to) => canvasWork.savedBoards(id, from, to),
        talk,
        pictures: new PictureStore(opts.highlightsDir ?? paths.highlights),
        attachmentsDir: opts.attachmentsDir ?? paths.attachments,
        log,
      })
    : undefined;
  talk?.on("entry", (entry) => highlights?.onEntry(entry));

  /** One protocol connection, the same for a LAN socket and a relay pipe. */
  const makeConnection = (
    out: (frame: DaemonFrame) => void,
    close: (code: number, reason: string) => void,
    via: { route: Route; sealed: boolean; local?: boolean },
  ) =>
    new Connection({
      registry,
      attachments,
      browser,
      local: via.local === true,
      sentInputs,
      activity,
      changes,
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
      board: push.board,
      prompts,
      groups: groupOrder,
      canvasMove,
      models,
      voice,
      canvas,
      ...(publisher ? { publish: publisher } : {}),
      ...(comments ? { comments } : {}),
      ...(owner ? { owner } : {}),
      plans: Object.assign(plans, {
        async enterPlanMode(sessionId: string) {
          // Straight to tmux, as a model switch is: a key, not a prompt.
          await enterClaudePlanMode({
            lines: async () => (await tmux.capture(sessionId)).lines,
            type: (text) => tmux.sendText(sessionId, text, false),
            key: (key) => tmux.sendKey(sessionId, key),
          });
          plans.enteredPlanMode(sessionId);
        },
      }),
      limits: planLimits,
      connectors,
      todos,
      library,
      conversations,
      ended,
      ...(talk ? { talk } : {}),
      ...(highlights ? { highlights } : {}),
      // Port forwarding (PROTOCOL.md "Port forwarding"): sockets to this computer's loopback address only.
      forwardConnect: connectLoopback,
      openTerm(open) {
        const stream = new TermStream({
          ...open,
          resize: (cols, rows, by) => registry.resize(open.sessionId, cols, rows, by),
          release: (by) => registry.releaseSize(open.sessionId, by),
          log,
        });
        stream.start();
        return stream;
      },
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

  // The largest frame a phone sends is an attachment (ATTACHMENT_MAX_BYTES, about 3.75 MB sealed), as on the relay.
  // A web page may not open the socket at all: it could spend wrong pairing tries and pause pairing (`fromWebPage`).
  const wss = new WebSocketServer({
    server: http,
    path: WS_PATH,
    maxPayload: WS_MAX_MESSAGE_BYTES,
    verifyClient: ({ req }: { req: IncomingMessage }) => !fromWebPage(req.headers.origin),
  });
  wss.on("connection", (socket: WebSocket, req) => {
    const lan = new LanSocket({
      socket: {
        send: (text) => {
          if (socket.readyState === socket.OPEN) socket.send(text);
        },
        close: (code, reason) => socket.close(code, reason),
      },
      staticKey: e2eKey,
      makeConnection: (out, close, sealed) => makeConnection(out, close, { route: "lan", sealed, local: isLoopback(req.socket.remoteAddress) }),
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
    todos,
    browser: { bridge: browser, attachments },
    codes,
    typedCode: (code) => typedCode(code, e2eKey.publicKey),
    offerUrl: (secret) => offerUrlFor(info, secret, localIpv4(networkInterfaces()), port),
    pairing,
    pause,
    devices,
    daemon: info,
    startedAt: Date.now(),
    log,
    agents: findAgentSetup,
    promptTests,
    activityTests: {
      noteErrored: (sessionId, message) => activity.noteErrored(sessionId, message, new Date().toISOString()),
    },
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
    voice,
    ...(talk ? { talk } : {}),
    ...(highlights ? { highlights } : {}),
    ...(publisher ? { publish: publisher } : {}),
    terminal: {
      status: terminalStatus,
      reload() {
        mirror.refresh();
        return terminalStatus();
      },
    },
    updates,
  });

  await listen(http, port, "0.0.0.0");
  await listen(control, controlPort, "127.0.0.1");
  const discovery = opts.advertise === false ? null : startDiscovery({ port, id: info.id, name: info.name, key: info.key ?? "", log });
  log.info(`Grenade ${VERSION} is running as "${info.name}" on port ${port}`, { id: info.id, controlPort });
  if (allowPlainLan) log.warn("Accepting phones without encryption on the Wi‑Fi (--allow-plain-lan). Update them, then start without it.");
  log.info("Pair a phone with: grenade pair");
  updates.start();
  void publisher?.start();
  comments?.start();

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
      publisher?.stop();
      comments?.stop();
      talk?.stop();
      library.stop();
      highlights?.stop();
      canvas.stop();
      changes.stop();
      push.stop();
      // Held hook requests would keep the HTTP server from closing.
      prompts.closeAll();
      summarizer?.stop();
      backgroundWatch.stop();
      catchUp.stop();
      interruptCatchUp.stop();
      codexStopCatchUp.stop();
      follower.stop();
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
