import { EventEmitter } from "node:events";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ActivityEntry, DaemonFrame, Session } from "@grenade/protocol";
import type { ScreenFrame } from "../src/frames.js";
import { Connection, type ConversationsPort } from "../src/daemon/wsHandler.js";
import { silentLogger } from "../src/log.js";

const fixtures = join(import.meta.dirname, "..", "..", "grenade-protocol", "fixtures");
const fixture = (name: string) => readFileSync(join(fixtures, name), "utf8");

const session: Session = {
  id: "gr-a1b2c3",
  name: "grenade",
  agent: "claude",
  cwd: "/tmp",
  status: "waiting",
  statusSince: "2026-09-27T12:14:22.000Z",
  lastLine: "hi",
  createdAt: "2026-09-27T12:01:00.000Z",
};

class FakeRegistry extends EventEmitter {
  calls: string[] = [];
  sessions = new Map<string, Session>([[session.id, session]]);
  screens = new Map<string, ScreenFrame>();
  list() { return [...this.sessions.values()]; }
  get(id: string) { return this.sessions.get(id); }
  screenOf(id: string) { return this.screens.get(id); }
  subscribe(id: string) { this.calls.push(`subscribe:${id}`); }
  unsubscribe(id: string) { this.calls.push(`unsubscribe:${id}`); }
  async sendText(id: string, text: string, submit: boolean) { this.calls.push(`input:${id}:${text}:${submit}`); }
  async sendKey(id: string, key: string) { this.calls.push(`key:${id}:${key}`); }
  async resize(id: string, cols: number, rows?: number) { this.calls.push(`resize:${id}:${cols}:${rows}`); }
  async releaseSize(id: string) { this.calls.push(`release:${id}`); }
  seen(id: string) { this.calls.push(`seen:${id}`); }
  async history(id: string, before: number, count: number) {
    this.calls.push(`history:${id}:${before}:${count}`);
    return { type: "history" as const, sessionId: id, epoch: 3, start: before - 2, lines: ["a", "b"], styled: ["a", "b"] };
  }
  async create(i: { name: string; cwd: string; agent: Session["agent"] }) {
    const s = { ...session, id: `gr-${i.name}`, name: i.name, agent: i.agent, cwd: i.cwd };
    this.sessions.set(s.id, s);
    return s;
  }
  setGroup(id: string, group: string | null, index?: number) {
    this.calls.push(`group:${id}:${group}${index === undefined ? "" : `@${index}`}`);
    const before = this.sessions.get(id) ?? session;
    const s = { ...before, id, group: group ?? before.group ?? "g-new" };
    this.sessions.set(id, s);
    if (s.group !== before.group) this.emit("updated", s);
    return s;
  }
  async kill(id: string) { this.calls.push(`kill:${id}`); this.sessions.delete(id); }
}

class FakeActivity extends EventEmitter {
  entries = new Map<string, ActivityEntry[]>([[session.id, [{ kind: "said", text: "On it.", at: "2026-09-30T14:02:14.000Z" }]]]);
  entriesOf(id: string) { return this.entries.get(id) ?? []; }
}

class FakeGroups extends EventEmitter {
  order = ["g-7f3a91", "g-0c2d4e"];
  frame() { return { type: "groups" as const, order: [...this.order] }; }
  move(group: string, index: number) {
    const rest = this.order.filter((g) => g !== group);
    const next = [...rest.slice(0, index), group, ...rest.slice(index)];
    if (next.join() === this.order.join()) return false;
    this.order = next;
    this.emit("changed", this.frame());
    return true;
  }
}

function connect(opts: { token?: string; sealed?: boolean; acceptsPlain?: (token: string) => boolean; conversations?: ConversationsPort } = {}) {
  const registry = new FakeRegistry();
  const activity = new FakeActivity();
  const groups = new FakeGroups();
  const out: DaemonFrame[] = [];
  const closes: string[] = [];
  const saved: { sessionId: string; name: string; mime: string; bytes: number }[] = [];
  const events: string[] = [];
  const conn = new Connection({
    registry: registry as never,
    activity: activity as never,
    groups,
    attachments: {
      async save(sessionId, name, mime, data) {
        saved.push({ sessionId, name, mime, bytes: data.length });
        return { path: `/tmp/attachments/${sessionId}/${name}`, bytes: data.length };
      },
    },
    isValidToken: (t) => t === (opts.token ?? "grt_example_token"),
    sealed: opts.sealed ?? true,
    route: "lan",
    ...(opts.acceptsPlain ? { acceptsPlain: opts.acceptsPlain } : {}),
    ...(opts.conversations ? { conversations: opts.conversations } : {}),
    onHello: (_c, token) => events.push(`hello:${token}`),
    onEnd: (_c, token) => events.push(`end:${token}`),
    unpair: (token) => events.push(`unpair:${token}`),
    interrupted: (id) => events.push(`interrupted:${id}`),
    daemon: { id: "d_1", name: "Mac", version: "0.1.0" },
    log: silentLogger,
    out: (f) => out.push(f),
    close: (_c, r) => closes.push(r),
    setTimer: () => 0,
    clearTimer: () => {},
  });
  return { conn, registry, activity, groups, out, closes, saved, events };
}

describe("Connection", () => {
  it("requires hello first", async () => {
    const { conn, out, closes } = connect();
    await conn.handleMessage(fixture("client.ping.json"));
    expect(out[0]).toMatchObject({ type: "error", code: "unauthorized" });
    expect(closes).toEqual(["unauthorized"]);
  });

  it("rejects an unknown token", async () => {
    const { conn, out, closes } = connect({ token: "grt_other" });
    await conn.handleMessage(fixture("client.hello.json"));
    expect(out[0]).toMatchObject({ type: "error", code: "unauthorized" });
    expect(closes).toHaveLength(1);
  });

  it("answers hello with welcome and the session list", async () => {
    const { conn, out } = connect();
    await conn.handleMessage(fixture("client.hello.json"));
    expect(out[0]).toMatchObject({ type: "welcome", protocol: 1, daemon: { id: "d_1" } });
    expect(out[1]).toMatchObject({ type: "sessions", sessions: [{ id: "gr-a1b2c3" }] });
    expect(out[2]).toEqual({ type: "groups", order: ["g-7f3a91", "g-0c2d4e"] });
  });

  it("moves a group, and passes every change of the order on", async () => {
    const { conn, groups, out } = connect();
    await conn.handleMessage(fixture("client.hello.json"));
    out.length = 0;
    await conn.handleMessage(JSON.stringify({ type: "group.move", group: "g-0c2d4e", index: 0 }));
    expect(out).toEqual([{ type: "groups", order: ["g-0c2d4e", "g-7f3a91"] }]);
    // Where it already is: nothing changed, and this client still gets the order.
    await conn.handleMessage(JSON.stringify({ type: "group.move", group: "g-0c2d4e", index: 0 }));
    expect(out).toHaveLength(2);
    // A move from another client reaches this one; after close it no longer does.
    groups.move("g-7f3a91", 0);
    expect(out).toHaveLength(3);
    conn.handleClose();
    groups.move("g-0c2d4e", 0);
    expect(out).toHaveLength(3);
  });

  it("accepts every client fixture without a bad_frame", async () => {
    const everything: ConversationsPort = {
      async list() { return []; },
      async preview() { return []; },
      async delete() { return null; },
      async resume({ name }) { return { ...session, id: `gr-${name}`, name }; },
    };
    const { conn, out } = connect({ conversations: everything });
    // `unpair` ends the connection, so it goes last.
    const names = readdirSync(fixtures).filter((n) => n.startsWith("client.") && n !== "client.unpair.json");
    for (const name of [...names, "client.unpair.json"]) {
      const before = out.length;
      await conn.handleMessage(fixture(name));
      const errors = out.slice(before).filter((f) => f.type === "error" && f.code === "bad_frame");
      expect(errors, name).toEqual([]);
    }
  });

  it("dispatches input, key, seen, resize and subscribe to the registry", async () => {
    const { conn, registry, out } = connect();
    await conn.handleMessage(fixture("client.hello.json"));
    registry.screens.set(session.id, { type: "screen", sessionId: session.id, seq: 1, cols: 80, rows: 24, lines: ["hi"], cursor: { row: 0, col: 0 } });
    await conn.handleMessage(fixture("client.subscribe.json"));
    await conn.handleMessage(fixture("client.input.json"));
    await conn.handleMessage(fixture("client.key.json"));
    await conn.handleMessage(fixture("client.seen.json"));
    await conn.handleMessage(fixture("client.resize.json"));
    await conn.handleMessage(fixture("client.resize.release.json"));
    expect(registry.calls).toEqual([
      "subscribe:gr-a1b2c3",
      "input:gr-a1b2c3:Use tmux so I can still attach from the desktop:true",
      "key:gr-a1b2c3:ctrl-c",
      "seen:gr-a1b2c3",
      "resize:gr-a1b2c3:46:undefined",
      "release:gr-a1b2c3",
    ]);
    expect(out.find((f) => f.type === "screen")).toMatchObject({ seq: 1 });
  });

  it("acknowledges an input with an id and types a repeat of it once", async () => {
    const { conn, registry, out } = connect();
    await conn.handleMessage(fixture("client.hello.json"));
    await conn.handleMessage(fixture("client.input.json"));
    await conn.handleMessage(fixture("client.input.json"));
    const sent = { type: "input.sent", id: "6f1c2a3e-4b5d-4e6f-8a9b-0c1d2e3f4a5b", sessionId: "gr-a1b2c3" };
    expect(registry.calls).toEqual(["input:gr-a1b2c3:Use tmux so I can still attach from the desktop:true"]);
    expect(out.filter((f) => f.type === "input.sent")).toEqual([sent, sent]);
  });

  it("answers nothing to an input without an id", async () => {
    const { conn, registry, out } = connect();
    await conn.handleMessage(fixture("client.hello.json"));
    const before = out.length;
    await conn.handleMessage(JSON.stringify({ type: "input", sessionId: "gr-a1b2c3", text: "hi", submit: true }));
    expect(registry.calls).toEqual(["input:gr-a1b2c3:hi:true"]);
    expect(out.length).toBe(before);
  });

  it("gives the id back with the error when an input cannot be typed", async () => {
    const { conn, registry, out } = connect();
    await conn.handleMessage(fixture("client.hello.json"));
    registry.sendText = async () => { throw new Error("can't find session: gr-a1b2c3"); };
    await conn.handleMessage(fixture("client.input.json"));
    expect(out.at(-1)).toEqual({ type: "error", code: "unknown_session", message: "can't find session: gr-a1b2c3", ref: "input", id: "6f1c2a3e-4b5d-4e6f-8a9b-0c1d2e3f4a5b" });
    expect(out.some((f) => f.type === "input.sent")).toBe(false);
  });

  it("saves an attachment and answers with its path", async () => {
    const { conn, out, saved } = connect();
    await conn.handleMessage(fixture("client.hello.json"));
    await conn.handleMessage(fixture("client.attachment.json"));
    expect(saved).toEqual([{ sessionId: "gr-a1b2c3", name: "screenshot.png", mime: "image/png", bytes: 70 }]);
    expect(out.at(-1)).toEqual({ type: "attachment.saved", id: "att-1", sessionId: "gr-a1b2c3", path: "/tmp/attachments/gr-a1b2c3/screenshot.png", bytes: 70 });
  });

  it("refuses an attachment for a session it does not have", async () => {
    const { conn, out, saved } = connect();
    await conn.handleMessage(fixture("client.hello.json"));
    await conn.handleMessage(JSON.stringify({ type: "attachment", id: "a", sessionId: "gr-zzz", name: "x.png", mime: "image/png", data: "AA==" }));
    expect(saved).toEqual([]);
    expect(out.at(-1)).toMatchObject({ type: "error", code: "unknown_session", ref: "attachment" });
  });

  it("answers history with the registry's rows", async () => {
    const { conn, registry, out } = connect();
    await conn.handleMessage(fixture("client.hello.json"));
    await conn.handleMessage(fixture("client.history.json"));
    expect(registry.calls).toEqual(["history:gr-a1b2c3:1840:500"]);
    expect(out.at(-1)).toEqual({ type: "history", sessionId: "gr-a1b2c3", epoch: 3, start: 1838, lines: ["a", "b"], styled: ["a", "b"] });
  });

  it("forwards screen frames only for subscribed sessions and unsubscribes on close", async () => {
    const { conn, registry, out } = connect();
    await conn.handleMessage(fixture("client.hello.json"));
    await conn.handleMessage(fixture("client.subscribe.json"));
    registry.emit("screen", { type: "screen", sessionId: "gr-other", seq: 1, cols: 1, rows: 1, lines: [], cursor: { row: 0, col: 0 } });
    registry.emit("screen", { type: "screen", sessionId: session.id, seq: 2, cols: 1, rows: 1, lines: ["x"], cursor: { row: 0, col: 0 } });
    expect(out.filter((f) => f.type === "screen").map((f) => (f as ScreenFrame).seq)).toEqual([2]);
    conn.handleClose();
    expect(registry.calls).toContain("unsubscribe:gr-a1b2c3");
    expect(registry.listenerCount("screen")).toBe(0);
  });

  it("moves a session between groups and always answers with session.updated", async () => {
    const { conn, registry, out } = connect();
    await conn.handleMessage(fixture("client.hello.json"));
    out.length = 0;
    await conn.handleMessage(JSON.stringify({ type: "session.group", sessionId: session.id, group: null }));
    expect(registry.calls).toContain(`group:${session.id}:null`);
    expect(out).toEqual([{ type: "session.updated", session: { ...session, group: "g-new" } }]);
    out.length = 0;
    await conn.handleMessage(JSON.stringify({ type: "session.group", sessionId: session.id, group: null }));
    expect(out).toEqual([{ type: "session.updated", session: { ...session, group: "g-new" } }]);
    await conn.handleMessage(JSON.stringify({ type: "session.group", sessionId: session.id, group: "g-new", index: 2 }));
    expect(registry.calls).toContain(`group:${session.id}:g-new@2`);
  });

  it("reports unknown sessions", async () => {
    const { conn, out } = connect();
    await conn.handleMessage(fixture("client.hello.json"));
    await conn.handleMessage(JSON.stringify({ type: "subscribe", sessionId: "gr-nope" }));
    expect(out.at(-1)).toMatchObject({ type: "error", code: "unknown_session", ref: "subscribe" });
  });

  it("rejects the wrong protocol version", async () => {
    const { conn, out, closes } = connect();
    await conn.handleMessage(JSON.stringify({ type: "hello", protocol: 2, token: "grt_example_token", client: { name: "x", platform: "test", version: "0" } }));
    expect(out[0]).toMatchObject({ type: "error", code: "unsupported_protocol" });
    expect(closes).toHaveLength(1);
  });
});

describe("Connection: encryption and unpairing", () => {
  it("refuses a plain hello without making the phone forget the Mac", async () => {
    const { conn, out, closes, events } = connect({ sealed: false });
    await conn.handleMessage(fixture("client.hello.json"));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ type: "error", code: "unsupported_protocol", ref: "hello" });
    expect(closes).toEqual(["unsupported_protocol"]);
    expect(events).toEqual([]);
  });

  it("still says unauthorized to a plain hello with an unknown token", async () => {
    const { conn, out } = connect({ sealed: false, token: "grt_other", acceptsPlain: () => true });
    await conn.handleMessage(fixture("client.hello.json"));
    expect(out[0]).toMatchObject({ type: "error", code: "unauthorized" });
  });

  it("accepts a plain hello when the daemon allows it for that token", async () => {
    const { conn, out, events } = connect({ sealed: false, acceptsPlain: (t) => t === "grt_example_token" });
    await conn.handleMessage(fixture("client.hello.json"));
    expect(out[0]).toMatchObject({ type: "welcome" });
    expect(events).toEqual(["hello:grt_example_token"]);
  });

  it("reports the end of a connection that had said hello, once", async () => {
    const { conn, events } = connect();
    await conn.handleMessage(fixture("client.hello.json"));
    conn.handleClose();
    conn.handleClose();
    expect(events).toEqual(["hello:grt_example_token", "end:grt_example_token"]);
  });

  it("unpair deletes the token, answers unpaired and closes", async () => {
    const { conn, out, closes, events } = connect();
    await conn.handleMessage(fixture("client.hello.json"));
    out.length = 0;
    await conn.handleMessage(fixture("client.unpair.json"));
    expect(events).toContain("unpair:grt_example_token");
    expect(out).toEqual([{ type: "unpaired" }]);
    expect(closes).toEqual(["unpaired"]);
    await conn.handleMessage(fixture("client.ping.json"));
    expect(out).toHaveLength(1);
  });

  it("a pairing ended on the Mac says unauthorized, closes, and ignores what still arrives", async () => {
    const { conn, out, closes } = connect();
    await conn.handleMessage(fixture("client.hello.json"));
    out.length = 0;
    conn.revoked("unpaired on the Mac");
    conn.revoked("unpaired on the Mac");
    expect(out).toEqual([{ type: "error", code: "unauthorized", message: "unpaired on the Mac" }]);
    expect(closes).toEqual(["unauthorized"]);
    await conn.handleMessage(fixture("client.input.json"));
    expect(out).toHaveLength(1);
  });

  it("revoking a connection that never said hello does nothing", () => {
    const { conn, out, closes } = connect();
    conn.revoked("unpaired on the Mac");
    expect(out).toEqual([]);
    expect(closes).toEqual([]);
  });
});

describe("Connection activity", () => {
  it("sends the full activity of a Claude session on subscribe, then forwards new entries", async () => {
    const { conn, activity, out } = connect();
    await conn.handleMessage(fixture("client.hello.json"));
    await conn.handleMessage(fixture("client.subscribe.json"));
    expect(out.at(-1)).toEqual({ type: "activity", sessionId: session.id, full: true, entries: activity.entriesOf(session.id) });
    const frame = { type: "activity", sessionId: session.id, entries: [{ kind: "said", text: "Done.", at: "2026-09-30T14:06:41.000Z" }] };
    activity.emit("activity", frame);
    expect(out.at(-1)).toEqual(frame);
    activity.emit("activity", { ...frame, sessionId: "gr-other" });
    expect(out.at(-1)).toEqual(frame);
  });

  it("leaves stopped entries out for an app from before them", async () => {
    const { conn, activity, out } = connect();
    const stopped = { kind: "stopped", text: "Stopped", at: "2026-10-02T03:22:39.000Z" } as const;
    activity.entries.set(session.id, [...activity.entriesOf(session.id), stopped]);
    // The hello fixture is iPhone app 0.1.0.
    await conn.handleMessage(fixture("client.hello.json"));
    await conn.handleMessage(fixture("client.subscribe.json"));
    expect(out.at(-1)).toMatchObject({ type: "activity", full: true, entries: [{ kind: "said" }] });
    const sent = out.length;
    activity.emit("activity", { type: "activity", sessionId: session.id, entries: [stopped] });
    expect(out).toHaveLength(sent);
  });

  it("sends stopped entries to an app that reads them", async () => {
    const { conn, activity, out } = connect();
    const stopped = { kind: "stopped", text: "Stopped", at: "2026-10-02T03:22:39.000Z" } as const;
    const hello = JSON.parse(fixture("client.hello.json"));
    await conn.handleMessage(JSON.stringify({ ...hello, client: { ...hello.client, version: "1.0.8" } }));
    await conn.handleMessage(fixture("client.subscribe.json"));
    activity.emit("activity", { type: "activity", sessionId: session.id, entries: [stopped] });
    expect(out.at(-1)).toEqual({ type: "activity", sessionId: session.id, entries: [stopped] });
  });

  it("looks for an interrupt after Esc or Ctrl-C, not after other keys", async () => {
    const { conn, events } = connect();
    await conn.handleMessage(fixture("client.hello.json"));
    const key = (k: string) => conn.handleMessage(JSON.stringify({ type: "key", sessionId: session.id, key: k }));
    await key("escape");
    await key("ctrl-c");
    await key("enter");
    expect(events.filter((e) => e.startsWith("interrupted"))).toEqual([`interrupted:${session.id}`, `interrupted:${session.id}`]);
  });

  it("sends no activity for a session without a transcript", async () => {
    const { conn, registry, out } = connect();
    registry.sessions.set(session.id, { ...session, agent: "shell" });
    await conn.handleMessage(fixture("client.hello.json"));
    await conn.handleMessage(fixture("client.subscribe.json"));
    expect(out.some((f) => f.type === "activity")).toBe(false);
  });
});

describe("Connection: conversations", () => {
  const glass = { id: "9a76de47-6489-4620-8e10-4bf9c4d12b09", cwd: "/tmp", title: "Glass buttons", updatedAt: "2026-10-02T14:31:00.000Z" };
  function withConversations() {
    const calls: string[] = [];
    const port: ConversationsPort = {
      async list() { return calls.includes(`delete:${glass.id}`) ? [] : [glass]; },
      async preview(id) { return id === glass.id ? [{ kind: "asked", text: "Make it glass", at: "2026-10-02T14:14:10.000Z" }, { kind: "stopped", text: "Stopped", at: "2026-10-02T14:15:00.000Z" }] : null; },
      async delete(id) {
        calls.push(`delete:${id}`);
        return id === glass.id ? null : "it is open in a Grenade session; end that session first";
      },
      async resume({ name, conversationId }) {
        calls.push(`resume:${name}:${conversationId}`);
        return conversationId === glass.id ? { ...session, id: `gr-${name}`, name, resumedFrom: conversationId } : null;
      },
    };
    return { port, calls };
  }
  const hello = (platform = "ios", version = "1.0.13") =>
    JSON.stringify({ type: "hello", protocol: 1, token: "grt_example_token", client: { name: "Phone", platform, version } });

  it("lists, previews and deletes", async () => {
    const { port, calls } = withConversations();
    const { conn, out } = connect({ conversations: port });
    await conn.handleMessage(hello());
    out.length = 0;
    await conn.handleMessage(JSON.stringify({ type: "conversations" }));
    expect(out).toEqual([{ type: "conversations", conversations: [glass] }]);
    await conn.handleMessage(JSON.stringify({ type: "conversation.preview", conversationId: glass.id }));
    expect(out[1]).toMatchObject({ type: "conversation.preview", conversationId: glass.id, entries: [{ kind: "asked" }, { kind: "stopped" }] });
    await conn.handleMessage(JSON.stringify({ type: "conversation.delete", conversationId: glass.id }));
    expect(calls).toEqual([`delete:${glass.id}`]);
    expect(out[2]).toEqual({ type: "conversations", conversations: [] });
    await conn.handleMessage(JSON.stringify({ type: "conversation.delete", conversationId: "held-one" }));
    expect(out[3]).toMatchObject({ type: "error", code: "bad_frame", ref: "conversation.delete", message: "could not delete the conversation: it is open in a Grenade session; end that session first" });
  });

  it("answers the retired archive with the list and changes nothing", async () => {
    const { port, calls } = withConversations();
    const { conn, out } = connect({ conversations: port });
    await conn.handleMessage(hello());
    out.length = 0;
    await conn.handleMessage(JSON.stringify({ type: "conversation.archive", conversationId: glass.id, archived: true }));
    expect(calls).toEqual([]);
    expect(out).toEqual([{ type: "conversations", conversations: [glass] }]);
  });

  it("leaves stopped out of a preview for an app from before it", async () => {
    const { port } = withConversations();
    const { conn, out } = connect({ conversations: port });
    await conn.handleMessage(hello("ios", "1.0.7"));
    out.length = 0;
    await conn.handleMessage(JSON.stringify({ type: "conversation.preview", conversationId: glass.id }));
    expect(out[0]).toMatchObject({ entries: [{ kind: "asked" }] });
  });

  it("answers an unknown conversation with bad_frame", async () => {
    const { port } = withConversations();
    const { conn, out } = connect({ conversations: port });
    await conn.handleMessage(hello());
    out.length = 0;
    await conn.handleMessage(JSON.stringify({ type: "conversation.preview", conversationId: "0000" }));
    await conn.handleMessage(JSON.stringify({ type: "session.create", name: "x", cwd: "/tmp", agent: "claude", resume: "0000" }));
    expect(out).toMatchObject([
      { type: "error", code: "bad_frame", ref: "conversation.preview" },
      { type: "error", code: "bad_frame", ref: "session.create" },
    ]);
  });

  it("resumes through the conversations port and answers with the sessions", async () => {
    const { port, calls } = withConversations();
    const { conn, out, registry } = connect({ conversations: port });
    await conn.handleMessage(hello());
    out.length = 0;
    await conn.handleMessage(fixture("client.session.create.resume.json"));
    expect(calls).toEqual([`resume:glass-buttons:${glass.id}`]);
    expect(registry.calls).toEqual([]);
    expect(out[0]).toMatchObject({ type: "sessions" });
  });

  it("refuses resume for an agent other than claude, and every conversation frame without the port", async () => {
    const { port } = withConversations();
    const a = connect({ conversations: port });
    await a.conn.handleMessage(hello());
    a.out.length = 0;
    await a.conn.handleMessage(JSON.stringify({ type: "session.create", name: "x", cwd: "/tmp", agent: "codex", resume: glass.id }));
    expect(a.out[0]).toMatchObject({ type: "error", code: "bad_frame", ref: "session.create" });
    const b = connect();
    await b.conn.handleMessage(hello());
    b.out.length = 0;
    await b.conn.handleMessage(JSON.stringify({ type: "conversations" }));
    expect(b.out[0]).toMatchObject({ type: "error", code: "bad_frame", ref: "conversations" });
  });
});
