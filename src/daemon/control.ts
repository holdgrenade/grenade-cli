/**
 * Loopback-only JSON API used by the `grenade` CLI. Never exposed on the network.
 *   GET  /status            → { id, name, version, key, relay, uptimeMs, sessions, relayLink }
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
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { SessionCreateFrame, SessionGroupFrame, type DaemonInfo } from "@grenade/protocol";
import type { Logger } from "../log.js";
import type { SessionRegistry } from "../sessions/registry.js";
import type { RelayStatus } from "../relay/relayLink.js";
import type { Device } from "./devices.js";
import type { PairingCodes } from "./pairing.js";
import type { PairingState } from "../pairing/pairingWatch.js";
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
    return sendJson(res, 200, { ...d.daemon, uptimeMs: Date.now() - d.startedAt, sessions: d.registry.list().length, relayLink: d.relay.status() });
  }
  if (method === "POST" && url.pathname === "/relay/reload") return sendJson(res, 200, d.relay.reload());
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
