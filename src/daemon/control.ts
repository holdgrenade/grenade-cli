/**
 * Loopback-only JSON API used by the `grenade` CLI. Never exposed on the network.
 *   GET  /status            → { id, name, version, key, relay, uptimeMs, sessions, relayLink, update }
 *   GET  /update            → UpdateStatus   (the version on disk, the latest release from the tap, when it was read)
 *   POST /update/check      → UpdateStatus   (reads the tap now)
 *   POST /update/install    → UpdateStatus   (installs the latest release now, in the background; the Mac app's Update)
 *   POST /update/restart    { force? } → { restarting: true } | 409 { error: "busy" | "cannot_restart" }   (the Mac app's Restart)
 *   POST /relay/reload      → RelayStatus (re-reads relay.json, restarts the relay link)
 *   GET  /terminal          → TerminalStatus   (which terminal sessions open in on the Mac, if any)
 *   POST /terminal/reload   → TerminalStatus   (re-reads terminal.json and opens the tabs it now asks for)
 *   GET  /sessions          → Session[]
 *   POST /sessions          { name, cwd, agent, group? } → Session
 *   PUT  /sessions/:id/group { group: string | null, index? } → Session (null moves it into a group of its own; index places or reorders)
 *   DELETE /sessions/:id    → { ok }
 *   POST /pair-code         → { code, typed, secret, offer, expiresAt }   (`typed` is what a person types: the code and its check digits;
 *                             `offer` is the URL for the QR code, PROTOCOL.md "Pairing offer (QR code)")
 *   GET  /pair-code         → PairingState   (what became of the last pair code: waiting, paired with which phone, expired)
 *   GET  /devices           → Device[]   (paired phones, without their tokens)
 *   GET  /published         → PublishedLink[]   (canvases published to secret links, without their keys)
 *   DELETE /published/<token> → PublishedLink[]   (takes that link down at the share host)
 *   DELETE /devices/:id     → { ok, closed }   (unpair one phone; `closed` connections went with it)
 *   DELETE /devices         → { removed, closed }   (unpair every phone)
 *   GET  /push              → PushStatus   (on or off, the relay pushes go through, the phones that registered)
 *   POST /push/reload       → PushStatus   (re-reads push.json)
 *   POST /push/test         → TestPushResult[]   (a test notification to every registered phone)
 *   POST /voice/reload      → VoiceProviderInfo[]   (re-reads voice-keys.json and tells the clients; a key is never in it, only masked)
 *   GET  /agents            → { agents: AgentSetup[] }   (each agent this daemon can start from its PATH, signed in or not, and the
 *                             commands that install it and sign it in: the Mac app's first run)
 *   POST /prompts/test      { kind, session?, wait? } → { promptId, sessionId, sessionName, kind, phones }
 *                             (puts a test card on a session, PROTOCOL.md "Prompts"; `wait` is in seconds)
 *   GET  /prompts/test/:id  → PromptTestResult   (answers when the phone has, or the wait ran out)
 *   GET  /talk/thread       → TalkThreadFrame   (today's typed Talk thread, PROTOCOL.md "Talk by text"; `grenade talk log`)
 *   POST /talk/say          { text, id? } → { id, said }   (the owner's words, as a `talk.say`; `grenade talk`)
 *   POST /talk/agent        { agent } → TalkThreadFrame | 400   (the agent that answers; `grenade talk agent`)
 *   POST /talk/tool         { turn, secret, name, arguments } → { text, isError } | 403   (one call of Grenade's MCP server,
 *                             `grenade talk-mcp`, for the running turn only)
 *   POST /clips             { path, title, line?, before?, session? } → Clip   (keeps a file an agent recorded as a clip of
 *                             today, PROTOCOL.md "Showreel"; `grenade clip`)
 *   GET  /clips?date=       → ClipsFrame   (a day's clips; today without a date)
 *   GET  /showreel?date=    → ShowreelFrame   (a day's showreel, cut now when a clip came since)
 *   POST /showreel/make     { date? } → ShowreelFrame   (cuts it again with the model now)
 *   GET  /showreel/settings → { hour }   /   POST /showreel/settings { hour } → { hour }   (the end-of-day hour)
 *   POST /showreel/render   { date?, portrait?, fps?, out? } → { path, seconds, width, height, frames }   (renders the day's reel to an
 *                             MP4 in the Movies folder with Chrome and ffmpeg; `grenade showreel render`)
 */
import type { Clip, ClipsFrame, PublishedLink, ShowreelFrame, TalkThreadFrame } from "@grenade/protocol";
import { ClipError } from "../showreel/clipStore.js";
import { RenderError, type RenderOptions, type Rendered } from "../showreel/render/renderVideo.js";
import type { ClipInput } from "../showreel/clipFile.js";
import { randomUUID } from "node:crypto";
import { addressedToLoopback, fromWebPage, isLoopback } from "./loopback.js";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { PromptKind, SessionCreateFrame, TALK_TEXT_MAX, SessionGroupFrame, type DaemonInfo, type PromptFrame, type VoiceProviderInfo } from "@grenade/protocol";
import type { Logger } from "../log.js";
import type { SessionRegistry } from "../sessions/registry.js";
import type { RelayStatus } from "../relay/relayLink.js";
import type { Device } from "./devices.js";
import type { PairingCodes } from "./pairing.js";
import type { PairingState } from "../pairing/pairingWatch.js";
import type { PairingPause } from "./pairingPause.js";
import type { PushStatus, TestPushResult } from "../push/pusher.js";
import type { UpdateStatus } from "../update/versions.js";
import type { TerminalStatus } from "../terminal/mirror.js";
import type { AgentSetup } from "../agents/agentSetup.js";
import { PROMPT_TEST_WAIT_MAX_S, PROMPT_TEST_WAIT_S, type PromptTestResult } from "../prompts/promptTests.js";
import { readBody, sendJson } from "./http.js";

export interface ControlDeps {
  registry: SessionRegistry;
  codes: PairingCodes;
  /** The code with its check digits (PROTOCOL.md "Key check for typed codes"). */
  typedCode(code: string): string;
  /** The pairing offer's URL for a freshly minted secret. */
  offerUrl(secret: string): string;
  pairing: { minted(expiresAt: number): void; state(): PairingState };
  /** PROTOCOL.md "Pausing after wrong codes": no code is made while paused. */
  pause: Pick<PairingPause, "pausedUntil" | "status">;
  devices: {
    list(): Device[];
    unpair(id: string): { closed: number } | null;
    unpairAll(): { removed: number; closed: number };
  };
  daemon: DaemonInfo;
  startedAt: number;
  log: Logger;
  relay: { status(): RelayStatus; reload(): RelayStatus };
  push: { status(): PushStatus; reload(): PushStatus; test(): Promise<TestPushResult[]> };
  terminal: { status(): TerminalStatus; reload(): TerminalStatus };
  /** Voice providers' keys (PROTOCOL.md "Voice providers"). Absent in tests that have none. */
  voice?: { reload(): VoiceProviderInfo[] };
  /** Canvases published to secret links (PROTOCOL.md "Publishing"). Absent when this daemon publishes none. */
  publish?: { list(): PublishedLink[]; remove(token: string): Promise<PublishedLink[]> };
  /** What each agent needs on this computer (`findAgentSetup`). Absent in tests that have none. */
  agents?: () => Promise<AgentSetup[]>;
  updates: {
    current(): UpdateStatus;
    checkTap(): Promise<UpdateStatus>;
    installNow(): Promise<UpdateStatus>;
    restartNow(force: boolean): "restarting" | "busy" | "cannotRestart";
  };
  /** Test cards. Absent means this daemon has no prompts to offer. */
  promptTests?: {
    start(sessionId: string, kind: PromptKind, waitMs: number): PromptFrame;
    result(promptId: string): Promise<PromptTestResult> | undefined;
  };
  /** Typed Talk (PROTOCOL.md "Talk by text"). Absent in tests that have none. */
  talk?: {
    frame(): TalkThreadFrame;
    say(id: string, text: string): boolean;
    setAgent(agent: string): boolean;
    tool(turn: unknown, secret: unknown, name: string, args: Record<string, unknown>): Promise<{ ok: true; text: string; isError: boolean } | { ok: false; message: string }>;
  };
  /** Clips and the day's showreel (PROTOCOL.md "Showreel"). Absent in tests that have none. */
  showreel?: {
    addClip(input: ClipInput): Promise<Clip>;
    clips(date: string | undefined): ClipsFrame;
    frame(date: string | undefined): ShowreelFrame;
    make(date: string | undefined): Promise<ShowreelFrame>;
    hour(): number;
    setHour(hour: number): void;
    render(date: string | undefined, options: RenderOptions): Promise<Rendered>;
  };
  /** Inject a test activity entry. */
  activityTests?: {
    noteErrored(sessionId: string, message: string): void;
  };
}

export function createControlServer(d: ControlDeps): Server {
  return createServer(async (req, res) => {
    try {
      // Loopback is not enough: a web page in a browser on this Mac reaches 127.0.0.1 too.
      if (fromWebPage(req.headers.origin)) return sendJson(res, 403, { error: "forbidden" });
      // A page that rebinds its own name to 127.0.0.1 sends no Origin on a GET; its Host gives it away.
      if (!addressedToLoopback(req.headers.host)) return sendJson(res, 403, { error: "forbidden" });
      await route(d, req, res);
    } catch (e) {
      d.log.error("CLI request failed", { url: req.url, error: e });
      sendJson(res, 500, { error: "internal", message: e instanceof Error ? e.message : String(e) });
    }
  });
}

async function route(d: ControlDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const method = req.method ?? "GET";
  if (method === "GET" && url.pathname === "/status") {
    return sendJson(res, 200, { ...d.daemon, uptimeMs: Date.now() - d.startedAt, sessions: d.registry.list().length, relayLink: d.relay.status(), update: d.updates.current(), pairingPause: d.pause.status() });
  }
  if (method === "GET" && url.pathname === "/update") return sendJson(res, 200, d.updates.current());
  if (method === "POST" && url.pathname === "/update/check") return sendJson(res, 200, await d.updates.checkTap());
  if (method === "POST" && url.pathname === "/update/install") return sendJson(res, 200, await d.updates.installNow());
  if (method === "POST" && url.pathname === "/update/restart") {
    const body = JSON.parse((await readBody(req)) || "{}") as { force?: unknown };
    const result = d.updates.restartNow(body.force === true);
    if (result === "restarting") return sendJson(res, 200, { restarting: true });
    return sendJson(res, 409, { error: result === "busy" ? "busy" : "cannot_restart" });
  }
  if (method === "POST" && url.pathname === "/relay/reload") return sendJson(res, 200, d.relay.reload());
  if (method === "GET" && url.pathname === "/terminal") return sendJson(res, 200, d.terminal.status());
  if (method === "POST" && url.pathname === "/terminal/reload") return sendJson(res, 200, d.terminal.reload());
  if (method === "GET" && url.pathname === "/push") return sendJson(res, 200, d.push.status());
  if (method === "POST" && url.pathname === "/push/reload") return sendJson(res, 200, d.push.reload());
  if (method === "POST" && url.pathname === "/push/test") return sendJson(res, 200, await d.push.test());
  if (method === "POST" && url.pathname === "/voice/reload") return sendJson(res, 200, d.voice?.reload() ?? []);
  if (method === "GET" && url.pathname === "/agents") return sendJson(res, 200, { agents: (await d.agents?.()) ?? [] });
  if (url.pathname.startsWith("/talk/")) return talkRoute(d, req, res, method, url.pathname);
  if (url.pathname === "/clips" || url.pathname.startsWith("/showreel")) return showreelRoute(d, req, res, method, url);
  if (method === "POST" && url.pathname === "/prompts/test") return startPromptTest(d, JSON.parse((await readBody(req)) || "{}"), res);
  if (method === "POST" && url.pathname === "/activity/test") return injectActivityTest(d, JSON.parse((await readBody(req)) || "{}"), res);
  const tested = url.pathname.match(/^\/prompts\/test\/([^/]+)$/);
  if (method === "GET" && tested?.[1]) {
    const result = d.promptTests?.result(tested[1]);
    return result ? sendJson(res, 200, await result) : sendJson(res, 404, { error: "not_found", message: `no test card ${tested[1]}` });
  }
  if (method === "GET" && url.pathname === "/sessions") return sendJson(res, 200, d.registry.list());
  if (method === "POST" && url.pathname === "/sessions") {
    const body = SessionCreateFrame.omit({ type: true }).safeParse(JSON.parse((await readBody(req)) || "{}"));
    if (!body.success) return sendJson(res, 400, { error: "bad_request", message: body.error.message });
    try {
      return sendJson(res, 201, await d.registry.create(body.data));
    } catch (e) {
      return sendJson(res, 409, { error: "conflict", message: e instanceof Error ? e.message : String(e) });
    }
  }
  const regroup = url.pathname.match(/^\/sessions\/([^/]+)\/group$/);
  if (method === "PUT" && regroup?.[1]) {
    const id = decodeURIComponent(regroup[1]);
    if (!d.registry.get(id)) return sendJson(res, 404, { error: "unknown_session" });
    const body = SessionGroupFrame.pick({ group: true, index: true }).safeParse(JSON.parse((await readBody(req)) || "{}"));
    if (!body.success) return sendJson(res, 400, { error: "bad_request", message: body.error.message });
    try {
      return sendJson(res, 200, d.registry.setGroup(id, body.data.group, body.data.index));
    } catch (e) {
      return sendJson(res, 409, { error: "conflict", message: e instanceof Error ? e.message : String(e) });
    }
  }
  const kill = url.pathname.match(/^\/sessions\/([^/]+)$/);
  if (method === "DELETE" && kill?.[1]) {
    if (!d.registry.get(kill[1])) return sendJson(res, 404, { error: "unknown_session" });
    await d.registry.kill(kill[1]);
    return sendJson(res, 200, { ok: true });
  }
  if (method === "POST" && url.pathname === "/pair-code") {
    const pausedUntil = d.pause.pausedUntil();
    if (pausedUntil !== null) return sendJson(res, 409, { error: "paused", pausedUntil, message: "pairing is paused after too many wrong codes" });
    const minted = d.codes.mint();
    d.pairing.minted(minted.expiresAt);
    return sendJson(res, 200, { ...minted, typed: d.typedCode(minted.code), offer: d.offerUrl(minted.secret) });
  }
  if (method === "GET" && url.pathname === "/pair-code") {
    const pausedUntil = d.pause.pausedUntil();
    return sendJson(res, 200, pausedUntil === null ? d.pairing.state() : { state: "paused", pausedUntil });
  }
  if (method === "GET" && url.pathname === "/devices") return sendJson(res, 200, d.devices.list());
  if (method === "DELETE" && url.pathname === "/devices") return sendJson(res, 200, d.devices.unpairAll());
  if (method === "GET" && url.pathname === "/published") return sendJson(res, 200, d.publish?.list() ?? []);
  const published = url.pathname.match(/^\/published\/([A-Za-z0-9_-]{16})$/);
  if (method === "DELETE" && published?.[1]) {
    if (!d.publish) return sendJson(res, 404, { error: "not_found", message: "this daemon publishes nothing" });
    try {
      return sendJson(res, 200, await d.publish.remove(published[1]));
    } catch (e) {
      return sendJson(res, 400, { error: "bad_request", message: e instanceof Error ? e.message : String(e) });
    }
  }
  const device = url.pathname.match(/^\/devices\/([^/]+)$/);
  if (method === "DELETE" && device?.[1]) {
    const r = d.devices.unpair(decodeURIComponent(device[1]));
    return r ? sendJson(res, 200, { ok: true, ...r }) : sendJson(res, 404, { error: "unknown_device" });
  }
  sendJson(res, 404, { error: "not_found" });
}

/** The typed Talk routes: what `grenade talk` uses, and the MCP server's tool calls. */
async function talkRoute(d: ControlDeps, req: IncomingMessage, res: ServerResponse, method: string, path: string): Promise<void> {
  const talk = d.talk;
  if (!talk) return sendJson(res, 404, { error: "not_found", message: "this daemon has no typed Talk" });
  // Only processes on this computer: the control port binds to loopback, and the tool route says so twice.
  if (!isLoopback(req.socket.remoteAddress)) return sendJson(res, 403, { error: "forbidden" });
  if (method === "GET" && path === "/talk/thread") return sendJson(res, 200, talk.frame());
  const body = JSON.parse((await readBody(req)) || "{}") as Record<string, unknown>;
  if (method === "POST" && path === "/talk/say") {
    const text = typeof body["text"] === "string" ? body["text"].trim() : "";
    if (!text || text.length > TALK_TEXT_MAX) return sendJson(res, 400, { error: "bad_request", message: `say something, at most ${TALK_TEXT_MAX} characters` });
    const id = typeof body["id"] === "string" && body["id"] ? body["id"].slice(0, 64) : randomUUID();
    return sendJson(res, 200, { id, said: talk.say(id, text) });
  }
  if (method === "POST" && path === "/talk/agent") {
    const agent = typeof body["agent"] === "string" ? body["agent"] : "";
    if (!talk.setAgent(agent)) return sendJson(res, 400, { error: "bad_request", message: `${agent || "that agent"} cannot answer Talk on this computer` });
    return sendJson(res, 200, talk.frame());
  }
  if (method === "POST" && path === "/talk/tool") {
    const name = typeof body["name"] === "string" ? body["name"] : "";
    const args = typeof body["arguments"] === "object" && body["arguments"] !== null ? (body["arguments"] as Record<string, unknown>) : {};
    const done = await talk.tool(body["turn"], body["secret"], name, args);
    if (!done.ok) return sendJson(res, 403, { error: "forbidden", message: done.message });
    return sendJson(res, 200, { text: done.text, isError: done.isError });
  }
  sendJson(res, 404, { error: "not_found" });
}

/** The clip and showreel routes (PROTOCOL.md "Showreel"): `grenade clip`, `grenade clips`, `grenade showreel`. */
async function showreelRoute(d: ControlDeps, req: IncomingMessage, res: ServerResponse, method: string, url: URL): Promise<void> {
  const showreel = d.showreel;
  if (!showreel) return sendJson(res, 404, { error: "not_found", message: "this daemon keeps no clips" });
  if (!isLoopback(req.socket.remoteAddress)) return sendJson(res, 403, { error: "forbidden" });
  const date = dateParam(url.searchParams.get("date"));
  if (date === null) return sendJson(res, 400, { error: "bad_request", message: "date is YYYY-MM-DD" });
  if (method === "GET" && url.pathname === "/clips") return sendJson(res, 200, showreel.clips(date));
  if (method === "GET" && url.pathname === "/showreel") return sendJson(res, 200, showreel.frame(date));
  if (method === "GET" && url.pathname === "/showreel/settings") return sendJson(res, 200, { hour: showreel.hour() });
  const body = JSON.parse((await readBody(req)) || "{}") as Record<string, unknown>;
  if (method === "POST" && url.pathname === "/clips") {
    const path = typeof body["path"] === "string" ? body["path"] : "";
    const title = typeof body["title"] === "string" ? body["title"].trim() : "";
    if (!path.startsWith("/")) return sendJson(res, 400, { error: "bad_request", message: "path is the absolute path of the recording or picture" });
    if (!title) return sendJson(res, 400, { error: "bad_request", message: "a clip needs a title: what the feature is, in the product's words" });
    const session = typeof body["session"] === "string" && d.registry.get(body["session"]) ? body["session"] : undefined;
    try {
      const clip = await showreel.addClip({ path, title, ...(typeof body["line"] === "string" ? { line: body["line"] } : {}), ...(body["before"] === true ? { before: true } : {}), ...(session ? { session } : {}) });
      return sendJson(res, 201, clip);
    } catch (e) {
      if (e instanceof ClipError) return sendJson(res, 400, { error: "bad_request", message: e.message });
      throw e;
    }
  }
  if (method === "POST" && url.pathname === "/showreel/make") {
    const day = dateParam(typeof body["date"] === "string" ? body["date"] : null);
    if (day === null) return sendJson(res, 400, { error: "bad_request", message: "date is YYYY-MM-DD" });
    return sendJson(res, 200, await showreel.make(day));
  }
  if (method === "POST" && url.pathname === "/showreel/render") {
    const day = dateParam(typeof body["date"] === "string" ? body["date"] : null);
    if (day === null) return sendJson(res, 400, { error: "bad_request", message: "date is YYYY-MM-DD" });
    const options: RenderOptions = { ...(body["portrait"] === true ? { portrait: true } : {}), ...(typeof body["fps"] === "number" && body["fps"] >= 10 && body["fps"] <= 60 ? { fps: Math.round(body["fps"]) } : {}), ...(typeof body["out"] === "string" && body["out"].startsWith("/") ? { out: body["out"] } : {}) };
    try {
      return sendJson(res, 200, await showreel.render(day, options));
    } catch (e) {
      if (e instanceof RenderError) return sendJson(res, 400, { error: "bad_request", message: e.message });
      throw e;
    }
  }
  if (method === "POST" && url.pathname === "/showreel/settings") {
    const hour = body["hour"];
    if (typeof hour !== "number" || !Number.isInteger(hour) || hour < 0 || hour > 23) return sendJson(res, 400, { error: "bad_request", message: "hour is 0 to 23" });
    showreel.setHour(hour);
    return sendJson(res, 200, { hour });
  }
  sendJson(res, 404, { error: "not_found" });
}

/** A `date` as given: undefined for none (today), null for one that is not a day. */
function dateParam(raw: string | null): string | undefined | null {
  if (raw === null || raw === "") return undefined;
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : null;
}

/** `POST /activity/test`: injects a test errored entry on the named session, or the first running one. */
function injectActivityTest(d: ControlDeps, body: { session?: unknown; message?: unknown }, res: ServerResponse): void {
  const live = d.registry.list().filter((s) => s.status !== "gone");
  const wanted = typeof body.session === "string" ? body.session : undefined;
  const session = wanted ? live.find((s) => s.id === wanted || s.name === wanted) : live[0];
  if (!session) {
    const message = wanted ? `no running session ${wanted}` : "no session to inject the error into. Start one with: grenade new demo --agent shell";
    return sendJson(res, 409, { error: "conflict", message });
  }
  if (!d.activityTests) return sendJson(res, 409, { error: "conflict", message: "activity tests not wired up" });
  const message = typeof body.message === "string" && body.message.trim() ? body.message.trim() : "Test error: API error injected by grenade activity test.";
  d.activityTests.noteErrored(session.id, message);
  d.log.info(`Injected a test errored entry on ${session.name}`, { sessionId: session.id });
  sendJson(res, 201, { sessionId: session.id, sessionName: session.name, message });
}

/** `POST /prompts/test`: the card goes on the named session, or on the first one that is still running. */
function startPromptTest(d: ControlDeps, body: { kind?: unknown; session?: unknown; wait?: unknown }, res: ServerResponse): void {
  const kind = PromptKind.safeParse(body.kind ?? "permission");
  if (!kind.success) return sendJson(res, 400, { error: "bad_request", message: "kind is permission, question or plan" });
  const live = d.registry.list().filter((s) => s.status !== "gone");
  const wanted = typeof body.session === "string" ? body.session : undefined;
  const session = wanted ? live.find((s) => s.id === wanted || s.name === wanted) : live[0];
  if (!session) {
    const message = wanted ? `no running session ${wanted}` : "no session to show the card on. Start one with: grenade new demo --agent shell";
    return sendJson(res, 409, { error: "conflict", message });
  }
  if (!d.promptTests) return sendJson(res, 409, { error: "conflict", message: "this daemon has no answer cards" });
  const seconds = typeof body.wait === "number" && body.wait > 0 ? Math.min(body.wait, PROMPT_TEST_WAIT_MAX_S) : PROMPT_TEST_WAIT_S;
  const frame = d.promptTests.start(session.id, kind.data, seconds * 1000);
  const phones = d.devices.list().filter((phone) => phone.connected.length > 0).length;
  d.log.info(`Sent a test card to ${session.name}`, { kind: kind.data, prompt: frame.promptId, phones });
  sendJson(res, 201, { promptId: frame.promptId, sessionId: session.id, sessionName: session.name, kind: kind.data, phones });
}
