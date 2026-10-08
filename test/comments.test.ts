/** Comments on published links (PROTOCOL.md "Comments"): the daemon pulls them, keeps them, and the owner answers. */
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DaemonFrame, type ShareCommentEvent, type ShareCommentPost } from "@grenade/protocol";
import { CommentError, CommentService, COMMENTS_IDLE_MS, COMMENTS_WATCHED_MS, type CommentLink } from "../src/publish/comments.js";
import { OwnerName } from "../src/publish/owner.js";
import { ShareClient, ShareHostError, type Fetch } from "../src/publish/shareClient.js";
import { Connection, type CommentsPort, type OwnerPort, type PublishPort } from "../src/daemon/wsHandler.js";
import { createLogger, silentLogger } from "../src/log.js";

const TOKEN = "k7Fq2xN9pWm4Lq0Z";
const KEY = "a".repeat(43);
const ana = { id: "AnaAnaAnaAnaAna0", name: "Ana", owner: false };

/** The share host's comments, as `ShareClient` asks for them. */
class FakeHost {
  events: ShareCommentEvent[] = [];
  gets: (string | undefined)[] = [];
  posts: ShareCommentPost[] = [];
  down = false;
  private n = 0;
  add(kind: ShareCommentEvent["kind"], fields: Partial<ShareCommentEvent> = {}): ShareCommentEvent {
    this.n += 1;
    const id = fields.id ?? `Ev${String(this.n).padStart(14, "0")}`;
    const event: ShareCommentEvent = { id, cursor: `${String(this.n).padStart(16, "0")}-${id}`, kind, thread: fields.thread ?? id, author: ana, at: new Date(Date.UTC(2026, 9, 8, 20, this.n)).toISOString(), ...fields };
    this.events.push(event);
    return event;
  }
  client = {
    getComments: async (_token: string, _key: string, after?: string) => {
      this.gets.push(after);
      if (this.down) throw new ShareHostError("The share host did not answer.", 0);
      const events = this.events.filter((e) => after === undefined || e.cursor > after);
      const cursor = this.events.at(-1)?.cursor;
      return cursor ? { events, cursor } : { events };
    },
    postComment: async (_token: string, _key: string, post: ShareCommentPost) => {
      this.posts.push(post);
      return this.add(post.kind, { ...(post.thread ? { thread: post.thread } : {}), author: { ...post.author, owner: true }, ...(post.text ? { text: post.text } : {}) });
    },
  };
}

describe("the comment service", () => {
  let dir: string;
  let host: FakeHost;
  let links: CommentLink[];
  let now: number;
  let timers: { fn: () => void; ms: number }[];
  const make = () =>
    new CommentService({
      dir,
      client: host.client,
      links: () => links,
      ownerName: () => "Mike",
      log: createLogger({ level: "error" }),
      now: () => new Date(now),
      setTimer: (fn, ms) => {
        const t = { fn, ms };
        timers.push(t);
        return t;
      },
      clearTimer: (t) => {
        timers = timers.filter((x) => x !== t);
      },
    });
  const tick = async (service: CommentService, ms: number) => {
    now += ms;
    const due = timers.splice(0);
    for (const t of due) t.fn();
    await new Promise((r) => setTimeout(r, 0));
    void service;
  };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "grenade-comments-"));
    host = new FakeHost();
    links = [{ token: TOKEN, key: KEY, live: true }];
    now = Date.UTC(2026, 9, 8, 21);
    timers = [];
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it("pulls after its cursor, keeps the events with mode 600, and reads them back", async () => {
    const first = host.add("comment", { anchor: { kind: "board", file: "R1A · Home.html", x: 1, y: 2 }, text: "One" });
    const service = make();
    await service.pull(TOKEN);
    expect(service.threads(TOKEN).map((t) => t.comments[0]!.text)).toEqual(["One"]);
    host.add("reply", { thread: first.id, text: "Two" });
    await service.pull(TOKEN);
    expect(host.gets).toEqual([undefined, first.cursor]);
    expect(service.threads(TOKEN)[0]!.comments).toHaveLength(2);
    const file = join(dir, `${TOKEN}.json`);
    expect(((await stat(file)).mode & 0o777).toString(8)).toBe("600");
    expect(make().threads(TOKEN)[0]!.comments).toHaveLength(2);
  });

  it("asks a watched link every 15 s, the others every 2 minutes, an expired one never", async () => {
    links.push({ token: "9pLm0QwErTy7_-ab", key: KEY, live: true }, { token: "ExpiredExpired00", key: KEY, live: false });
    const service = make();
    const stop = service.watch(TOKEN);
    service.start();
    await tick(service, 0);
    const asked = () => host.gets.length;
    const before = asked();
    await tick(service, COMMENTS_WATCHED_MS);
    expect(asked()).toBe(before + 1);
    stop();
    await tick(service, COMMENTS_WATCHED_MS);
    expect(asked()).toBe(before + 1);
    await tick(service, COMMENTS_IDLE_MS);
    expect(asked()).toBe(before + 3);
    service.stop();
  });

  it("the owner's reply goes with the key as the owner, counts as read, and is told", async () => {
    const thread = host.add("comment", { anchor: { kind: "board", file: "R1A · Home.html", x: 1, y: 2 }, text: "One" });
    host.add("reply", { thread: thread.id, text: "Two" });
    const service = make();
    await service.pull(TOKEN);
    expect(service.summary(TOKEN)).toEqual({ open: 1, unread: 2 });
    const told: unknown[] = [];
    service.on("changed", (f) => told.push(f));
    const frame = await service.reply(TOKEN, thread.id, "Thanks");
    expect(host.posts[0]).toEqual({ kind: "reply", thread: thread.id, text: "Thanks", author: { id: "owner", name: "Mike" } });
    expect(frame.threads[0]!.comments.at(-1)).toMatchObject({ text: "Thanks", author: { owner: true } });
    expect(service.summary(TOKEN)).toEqual({ open: 1, unread: 0 });
    expect(told.length).toBeGreaterThan(0);
    for (const f of told) expect(DaemonFrame.safeParse(f).success).toBe(true);
    await service.resolve(TOKEN, thread.id, true);
    expect(service.summary(TOKEN)).toEqual({ open: 0, unread: 0 });
  });

  it("seen marks a thread read; a reply to nothing or an expired link is refused", async () => {
    const thread = host.add("comment", { anchor: { kind: "board", file: "R1A · Home.html", x: 1, y: 2 }, text: "One" });
    const service = make();
    await service.pull(TOKEN);
    now = Date.parse(thread.at) + 1000;
    service.seen(TOKEN, thread.id);
    expect(service.summary(TOKEN).unread).toBe(0);
    await expect(service.reply(TOKEN, "NoSuchThread0000", "Hi")).rejects.toBeInstanceOf(CommentError);
    links = [{ token: TOKEN, key: KEY, live: false }];
    await expect(service.reply(TOKEN, thread.id, "Hi")).rejects.toThrow("expired");
  });

  it("a failed pull says why, once, and clears when the host answers again", async () => {
    host.down = true;
    const service = make();
    const told: { error?: string }[] = [];
    service.on("changed", (f) => told.push(f));
    await service.pull(TOKEN);
    await service.pull(TOKEN);
    expect(told).toHaveLength(1);
    expect(service.frame(TOKEN).error).toBe("The share host did not answer.");
    host.down = false;
    await service.pull(TOKEN);
    expect(service.frame(TOKEN).error).toBeUndefined();
  });
});

describe("the owner's name", () => {
  it("starts as the account's name, is kept, and tells of a change", async () => {
    const dir = await mkdtemp(join(tmpdir(), "grenade-owner-"));
    const path = join(dir, "owner.json");
    const owner = new OwnerName(path, () => "Mike Dick");
    expect(owner.name).toBe("Mike Dick");
    const told: string[] = [];
    owner.on("changed", (n) => told.push(n));
    owner.set("  ");
    expect(owner.name).toBe("");
    expect(new OwnerName(path, () => "Mike Dick").name).toBe("");
    owner.set("Mike");
    expect(told).toEqual(["", "Mike"]);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ name: "Mike" });
    await writeFile(path, "not json");
    expect(new OwnerName(path, () => "Fallback").name).toBe("Fallback");
    await rm(dir, { recursive: true, force: true });
  });
});

describe("the share client's comments", () => {
  it("asks after a cursor and posts the owner's event with the key", async () => {
    const calls: { url: string; method: string; auth?: string; body?: string }[] = [];
    const fetcher: Fetch = async (url, init) => {
      calls.push({ url, method: init.method, ...(init.headers["Authorization"] ? { auth: init.headers["Authorization"] } : {}), ...(typeof init.body === "string" ? { body: init.body } : {}) });
      const event = { id: "Ev00000000000001", cursor: "0000000000000001-Ev00000000000001", kind: "reply", thread: "Th00000000000001", author: { id: "owner", name: "Mike", owner: true }, text: "Hi", at: "2026-10-08T20:00:00.000Z" };
      return { status: 200, ok: true, json: async () => (init.method === "GET" ? { events: [event], cursor: event.cursor } : { event }), text: async () => "" };
    };
    const client = new ShareClient("https://share.test/", fetcher);
    const got = await client.getComments(TOKEN, KEY, "0000000000000000-Ev00000000000000");
    expect(got.cursor).toBe("0000000000000001-Ev00000000000001");
    expect(calls[0]!.url).toBe(`https://share.test/c/${TOKEN}/comments?after=0000000000000000-Ev00000000000000`);
    await client.postComment(TOKEN, KEY, { kind: "reply", thread: "Th00000000000001", author: { id: "owner", name: "Mike" }, text: "Hi" });
    expect(calls[1]).toMatchObject({ url: `https://share.test/v1/c/${TOKEN}/comments`, method: "POST", auth: `Bearer ${KEY}` });
  });
});

describe("comments on a connection", () => {
  const hello = { type: "hello", protocol: 1, token: "grt_t", client: { name: "Mac", platform: "macos", version: "1.0.150" } };
  const link = { token: TOKEN, kind: "canvas", cwd: "/p", folder: "/p/.grenade/canvas", title: "p", url: `https://share.holdgrenade.com/c/${TOKEN}`, scope: "newest", expiry: "never", boards: 2, created: "2026-10-05T00:00:00.000Z", updated: "2026-10-05T00:00:00.000Z", state: "live" } as const;
  class FakeComments extends EventEmitter implements CommentsPort {
    watching = 0;
    frame(token: string, id?: string) { return { type: "comments" as const, ...(id ? { id } : {}), token, threads: [] }; }
    watch() { this.watching++; return () => { this.watching--; }; }
    async reply(token: string) { return this.frame(token); }
    async resolve(token: string, thread: string) {
      if (thread === "NoSuchThread0000") throw new CommentError("That comment is gone.");
      return this.frame(token);
    }
    seenThreads: string[] = [];
    seen(_t: string, thread: string) { this.seenThreads.push(thread); }
  }
  class FakeOwner extends EventEmitter implements OwnerPort {
    name = "Mike";
    set(name: string) { this.name = name; this.emit("changed", name); return name; }
  }
  function connect(comments?: CommentsPort, owner?: OwnerPort) {
    const out: DaemonFrame[] = [];
    const registry = Object.assign(new EventEmitter(), { list: () => [], get: () => undefined, unsubscribe() {} });
    const publish = Object.assign(new EventEmitter(), { list: () => [link], publishCanvas: async () => [], publishPlan: async () => [], remove: async () => [] }) as unknown as PublishPort;
    const conn = new Connection({
      registry: registry as never,
      attachments: { save: async () => ({ path: "", bytes: 0 }) },
      isValidToken: () => true,
      sealed: true,
      route: "lan",
      publish,
      ...(comments ? { comments } : {}),
      ...(owner ? { owner } : {}),
      daemon: { id: "d_1", name: "Mac", version: "0.1.0" },
      log: silentLogger,
      out: (f) => out.push(f),
      close: () => {},
      setTimer: () => 0,
      clearTimer: () => {},
    });
    return { out, send: (frame: object) => conn.handleMessage(JSON.stringify(frame)), conn };
  }

  it("answers with the link's threads, follows them, and stops when the client leaves", async () => {
    const comments = new FakeComments();
    const { out, send, conn } = connect(comments);
    await send(hello);
    out.length = 0;
    await send({ type: "comments.list", id: "c_1", token: TOKEN });
    expect(out).toEqual([{ type: "comments", id: "c_1", token: TOKEN, threads: [] }]);
    expect(comments.watching).toBe(1);
    comments.emit("changed", { type: "comments", token: TOKEN, threads: [] });
    comments.emit("changed", { type: "comments", token: "9pLm0QwErTy7_-ab", threads: [] });
    expect(out).toHaveLength(2);
    await send({ type: "comment.seen", token: TOKEN, thread: "Th00000000000001" });
    expect(comments.seenThreads).toEqual(["Th00000000000001"]);
    conn.handleClose();
    expect(comments.watching).toBe(0);
    expect(comments.listenerCount("changed")).toBe(0);
  });

  it("refuses an unknown link, a thread that is gone, and a daemon without comments", async () => {
    const { out, send } = connect(new FakeComments());
    await send(hello);
    out.length = 0;
    await send({ type: "comments.list", id: "c_2", token: "9pLm0QwErTy7_-ab" });
    await send({ type: "comment.resolve", id: "c_3", token: TOKEN, thread: "NoSuchThread0000", resolved: true });
    expect(out).toEqual([
      { type: "error", code: "bad_frame", message: "That link is not one of this computer's.", ref: "comments.list", id: "c_2" },
      { type: "error", code: "bad_frame", message: "That comment is gone.", ref: "comment.resolve", id: "c_3" },
    ]);
    const bare = connect();
    await bare.send(hello);
    bare.out.length = 0;
    await bare.send({ type: "comments.list", id: "c_4", token: TOKEN });
    expect(bare.out[0]).toMatchObject({ type: "error", code: "bad_frame", id: "c_4" });
  });

  it("owner.name asks or sets, answering once with its id, and tells of later changes", async () => {
    const owner = new FakeOwner();
    const { out, send } = connect(new FakeComments(), owner);
    await send(hello);
    out.length = 0;
    await send({ type: "owner.name", id: "o_1" });
    await send({ type: "owner.name", id: "o_2", name: "" });
    expect(out).toEqual([{ type: "owner", id: "o_1", name: "Mike" }, { type: "owner", id: "o_2", name: "" }]);
    owner.set("Mike Dick");
    expect(out.at(-1)).toEqual({ type: "owner", name: "Mike Dick" });
  });
});
