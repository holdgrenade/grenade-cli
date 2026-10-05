/** A Connection with a publish port: what a client asks for and what it is told (PROTOCOL.md "Publishing"). */
import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { DaemonFrame, type PublishedLink } from "@grenade/protocol";
import { Connection, type PublishPort } from "../src/daemon/wsHandler.js";
import { silentLogger } from "../src/log.js";
import { PublishError } from "../src/publish/publisher.js";

const hello = { type: "hello", protocol: 1, token: "grt_t", client: { name: "Mac", platform: "macos", version: "1.0.105" } };
const link: PublishedLink = { token: "k7Fq2xN9pWm4Lq0Z", kind: "canvas", cwd: "/p", folder: "/p/.grenade/canvas", title: "p", url: "https://share.holdgrenade.com/c/k7Fq2xN9pWm4Lq0Z", scope: "newest", expiry: "never", boards: 2, created: "2026-10-05T00:00:00.000Z", updated: "2026-10-05T00:00:00.000Z", state: "live" };

class FakePublisher extends EventEmitter implements PublishPort {
  links: PublishedLink[] = [];
  list() { return this.links; }
  async publishCanvas(cwd: string) {
    if (cwd !== "/p") throw new PublishError(`No session works in ${cwd}.`);
    this.links = [link];
    this.emit("changed", this.links);
    return this.links;
  }
  async remove() {
    this.links = [];
    this.emit("changed", this.links);
    return this.links;
  }
}

function connect(publish?: PublishPort) {
  const out: DaemonFrame[] = [];
  const registry = Object.assign(new EventEmitter(), { list: () => [], get: () => undefined, unsubscribe() {} });
  const conn = new Connection({
    registry: registry as never,
    attachments: { save: async () => ({ path: "", bytes: 0 }) },
    isValidToken: () => true,
    sealed: true,
    route: "lan",
    ...(publish ? { publish } : {}),
    daemon: { id: "d_1", name: "Mac", version: "0.1.0" },
    log: silentLogger,
    out: (f) => out.push(f),
    close: () => {},
    setTimer: () => 0,
    clearTimer: () => {},
  });
  const send = (frame: object) => conn.handleMessage(JSON.stringify(frame));
  return { out, send, conn };
}

describe("publishing on a connection", () => {
  it("answers each frame with every link and its id, and tells the client of later changes", async () => {
    const publisher = new FakePublisher();
    const { out, send } = connect(publisher);
    await send(hello);
    out.length = 0;
    await send({ type: "publish.list", id: "p_1" });
    expect(out).toEqual([{ type: "published", id: "p_1", links: [] }]);
    await send({ type: "publish.canvas", id: "p_2", cwd: "/p", scope: "newest" });
    expect(out.slice(1)).toEqual([{ type: "published", links: [link] }, { type: "published", id: "p_2", links: [link] }]);
    for (const f of out) expect(DaemonFrame.safeParse(f).success).toBe(true);
    out.length = 0;
    publisher.emit("changed", [{ ...link, state: "uploading" }]);
    expect(out).toEqual([{ type: "published", links: [{ ...link, state: "uploading" }] }]);
  });

  it("a client that never asked hears nothing of changes", async () => {
    const publisher = new FakePublisher();
    const { out, send } = connect(publisher);
    await send(hello);
    out.length = 0;
    publisher.emit("changed", [link]);
    expect(out).toEqual([]);
  });

  it("a refusal is bad_frame with the request's id; a daemon without publishing says so", async () => {
    const { out, send } = connect(new FakePublisher());
    await send(hello);
    out.length = 0;
    await send({ type: "publish.canvas", id: "p_3", cwd: "/etc", scope: "all" });
    expect(out).toEqual([{ type: "error", code: "bad_frame", message: "No session works in /etc.", ref: "publish.canvas", id: "p_3" }]);
    const bare = connect();
    await bare.send(hello);
    bare.out.length = 0;
    await bare.send({ type: "publish.list", id: "p_4" });
    expect(bare.out[0]).toMatchObject({ type: "error", code: "bad_frame", id: "p_4" });
  });

  it("stops telling a client that left", async () => {
    const publisher = new FakePublisher();
    const { send, conn } = connect(publisher);
    await send(hello);
    await send({ type: "publish.list", id: "p_1" });
    expect(publisher.listenerCount("changed")).toBe(1);
    conn.handleClose();
    expect(publisher.listenerCount("changed")).toBe(0);
  });
});
