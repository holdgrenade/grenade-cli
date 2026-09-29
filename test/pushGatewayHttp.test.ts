import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PushRequest } from "@grenade/protocol";
import { postPush } from "../src/push/pushGateway.js";

const request = PushRequest.parse(JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "grenade-protocol", "fixtures", "http.relay.push.request.json"), "utf8")));

/** A push route on a local port: answers what `answer` says and keeps what it was sent. */
async function route(answer: (body: unknown, authorization: string | undefined) => { status: number; body: unknown }) {
  const seen: Array<{ method: string | undefined; url: string | undefined; body: unknown }> = [];
  const server: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body: unknown = JSON.parse(raw);
      seen.push({ method: req.method, url: req.url, body });
      const a = answer(body, req.headers.authorization);
      res.writeHead(a.status, { "content-type": "application/json" });
      res.end(JSON.stringify(a.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, seen, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

describe("postPush over HTTP", () => {
  let open: Server | null = null;
  afterEach(() => {
    open?.close();
    open = null;
  });

  it("sends a body the route accepts", async () => {
    const r = await route((body) => (PushRequest.safeParse(body).success ? { status: 200, body: { ok: true } } : { status: 400, body: { error: "bad_request" } }));
    open = r.server;
    expect(await postPush({ url: r.url }, request)).toEqual({ outcome: "sent", status: 200 });
    expect(r.seen).toEqual([{ method: "POST", url: "/v1/push", body: request }]);
  });

  it("brings the registration key, and hears a refusal", async () => {
    const r = await route((_, authorization) => (authorization === "Bearer k" ? { status: 200, body: { ok: true } } : { status: 401, body: { error: "unauthorized" } }));
    open = r.server;
    expect((await postPush({ url: r.url, key: "k" }, request)).outcome).toBe("sent");
    expect(await postPush({ url: r.url }, request)).toEqual({ outcome: "refused", status: 401, error: "unauthorized" });
  });

  it("a relay that does not answer in time is worth another try", async () => {
    const r = await route(() => ({ status: 200, body: { ok: true } }));
    open = r.server;
    r.server.removeAllListeners("request");
    r.server.on("request", () => {
      /* never answers */
    });
    const result = await postPush({ url: r.url }, request, fetch, 200);
    expect(result.outcome).toBe("retry");
    r.server.closeAllConnections();
  });
});
