/**
 * Loopback-only JSON API used by the `grenade` CLI. Never exposed on the network.
 *   GET  /status            → { id, name, version, key, relay, uptimeMs, sessions, relayLink, update }
 *   GET  /update            → UpdateStatus   (the version on disk, the latest release from the tap, when it was read)
 *   POST /update/check      → UpdateStatus   (reads the tap now)
 *   POST /update/install    → UpdateStatus   (installs the latest release now, in the background; the Mac app's Update)
 *   POST /update/restart    { force? } → { restarting: true } | 409 { error: "busy" | "cannot_restart" }   (the Mac app's Restart)
 *   POST /relay/reload      → RelayStatus (re-reads relay.json, restarts the relay link)
 *   GET  /sessions          → Session[]
 *   POST /sessions          { name, cwd, agent, group? } → Session
 *   PUT  /sessions/:id/group { group: string | null, index? } → Session (null moves it into a group of its own; index places or reorders)
 *   DELETE /sessions/:id    → { ok }
 *   POST /pair-code         → { code, typed, secret, offer, expiresAt }   (`typed` is what a person types: the code and its check digits;
 *                             `offer` is the URL for the QR code, PROTOCOL.md "Pairing offer (QR code)")
 *   GET  /pair-code         → PairingState   (what became of the last pair code: waiting, paired with which phone, expired)
 *   GET  /devices           → Device[]   (paired phones, without their tokens)
 *   DELETE /devices/:id     → { ok, closed }   (unpair one phone; `closed` connections went with it)
 *   DELETE /devices         → { removed, closed }   (unpair every phone)
 *   GET  /push              → PushStatus   (on or off, the relay pushes go through, the phones that registered)
 *   POST /push/reload       → PushStatus   (re-reads push.json)
 *   POST /push/test         → TestPushResult[]   (a test notification to every registered phone)
 *   POST /prompts/test      { kind, session?, wait? } → { promptId, sessionId, sessionName, kind, phones }
 *                             (puts a test card on a session, PROTOCOL.md "Prompts"; `wait` is in seconds)
 *   GET  /prompts/test/:id  → PromptTestResult   (answers when the phone has, or the wait ran out)
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { PromptKind, SessionCreateFrame, SessionGroupFrame, type DaemonInfo, type PromptFrame } from "@grenade/protocol";
import type { Logger } from "../log.js";
import type { SessionRegistry } from "../sessions/registry.js";
import type { RelayStatus } from "../relay/relayLink.js";
import type { Device } from "./devices.js";
import type { PairingCodes } from "./pairing.js";
import type { PairingState } from "../pairing/pairingWatch.js";
import type { PushStatus, TestPushResult } from "../push/pusher.js";
import type { UpdateStatus } from "../update/versions.js";
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
  /** Inject a test activity entry. */
  activityTests?: {
    noteErrored(sessionId: string, message: string): void;
  };
}

export function createControlServer(d: ControlDeps): Server {
  return createServer(async (req, res) => {
    try {
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
    return sendJson(res, 200, { ...d.daemon, uptimeMs: Date.now() - d.startedAt, sessions: d.registry.list().length, relayLink: d.relay.status(), update: d.updates.current() });
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
  if (method === "GET" && url.pathname === "/push") return sendJson(res, 200, d.push.status());
  if (method === "POST" && url.pathname === "/push/reload") return sendJson(res, 200, d.push.reload());
  if (method === "POST" && url.pathname === "/push/test") return sendJson(res, 200, await d.push.test());
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
    const minted = d.codes.mint();
    d.pairing.minted(minted.expiresAt);
    return sendJson(res, 200, { ...minted, typed: d.typedCode(minted.code), offer: d.offerUrl(minted.secret) });
  }
  if (method === "GET" && url.pathname === "/pair-code") return sendJson(res, 200, d.pairing.state());
  if (method === "GET" && url.pathname === "/devices") return sendJson(res, 200, d.devices.list());
  if (method === "DELETE" && url.pathname === "/devices") return sendJson(res, 200, d.devices.unpairAll());
  const device = url.pathname.match(/^\/devices\/([^/]+)$/);
  if (method === "DELETE" && device?.[1]) {
    const r = d.devices.unpair(decodeURIComponent(device[1]));
    return r ? sendJson(res, 200, { ok: true, ...r }) : sendJson(res, 404, { error: "unknown_device" });
  }
  sendJson(res, 404, { error: "not_found" });
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
