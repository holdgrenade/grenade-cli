import { EventEmitter } from "node:events";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ActivityEntry, DaemonFrame, Session } from "@grenade/protocol";
import type { ScreenFrame } from "../src/frames.js";
import { Connection, type ConversationsPort, type ModelsPort, type TermHandle, type TermOpen, type VoicePort } from "../src/daemon/wsHandler.js";
import { VoiceError } from "../src/voice/voiceProvider.js";
import { ModelSwitchError } from "../src/models/claudeModelSwitch.js";
import { silentLogger } from "../src/log.js";
import { UnknownGroupError } from "../src/sessions/registry.js";

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
  renameGroup(group: string, name: string | null) {
    this.calls.push(`rename:${group}:${name}`);
    // The one session here stands for every group but "g-nope".
    const first = group === "g-nope" ? undefined : this.sessions.get(session.id);
    if (!first) throw new UnknownGroupError(`no session in group ${group}`);
    const { groupName: was, ...rest } = first;
    const next = name?.trim() || undefined;
    const renamed: Session = next === undefined ? rest : { ...rest, groupName: next };
    this.sessions.set(renamed.id, renamed);
    if (was !== next) this.emit("updated", renamed);
    return { session: renamed, changed: was !== next };
  }
  async kill(id: string) { this.calls.push(`kill:${id}`); this.sessions.delete(id); }
}

class FakeActivity extends EventEmitter {
  entries = new Map<string, ActivityEntry[]>([[session.id, [{ kind: "said", text: "On it.", at: "2026-09-30T14:02:14.000Z" }]]]);
  entriesOf(id: string) { return this.entries.get(id) ?? []; }
}

/** A daemon's voice keys: OpenAI takes any key but "bad", and a token is the key's first letters with a count. */
class FakeVoice extends EventEmitter {
  keys = new Map<string, string>();
  minted = 0;
  frame() {
    const provider = (id: string, name: string, use: string) => ({ id, name, uses: [use], ...(this.keys.has(id) ? { key: "sk-…ABCD" } : {}) });
    return { type: "voice" as const, providers: [provider("openai", "OpenAI", "talk"), provider("wispr-flow", "Wispr Flow", "dictation")] };
  }
  async setKey(provider: string, key: string | null) {
    if (provider !== "openai" && provider !== "wispr-flow") throw new VoiceError("bad_frame", `no voice provider "${provider}"`);
    if (key === "bad") throw new VoiceError("provider_failed", "Incorrect API key provided.");
    if ((this.keys.get(provider) ?? null) === key) return false;
    if (key === null) this.keys.delete(provider);
    else this.keys.set(provider, key);
    this.emit("changed", this.frame());
    return true;
  }
  async token(provider: string, _use: string, _model: string | undefined) {
    if (!this.keys.has(provider)) throw new VoiceError("bad_frame", "No OpenAI API key is kept on this Mac.");
    this.minted += 1;
    return { token: `ek_${this.minted}`, expiresAt: new Date("2026-10-04T12:01:00.000Z"), once: provider === "openai" };
  }
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

function connect(opts: { token?: string; sealed?: boolean; acceptsPlain?: (token: string) => boolean; conversations?: ConversationsPort; models?: ModelsPort; voice?: VoicePort; openTerm?: (open: TermOpen) => TermHandle } = {}) {
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
    ...(opts.models ? { models: opts.models } : {}),
    ...(opts.voice ? { voice: opts.voice } : {}),
    ...(opts.openTerm ? { openTerm: opts.openTerm } : {}),
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

  it("renames a group: every client hears it once, a rename that changes nothing still answers, an unknown group is a bad frame", async () => {
    const { conn, registry, out } = connect();
    await conn.handleMessage(fixture("client.hello.json"));
    out.length = 0;
    await conn.handleMessage(fixture("client.group.rename.json"));
    expect(registry.calls).toContain("rename:g-7f3a91:Launch week");
    expect(out).toEqual([{ type: "session.updated", session: { ...session, groupName: "Launch week" } }]);
    await conn.handleMessage(fixture("client.group.rename.json"));
    expect(out).toHaveLength(2);
    await conn.handleMessage(JSON.stringify({ type: "group.rename", group: "g-7f3a91", name: null }));
    expect(out[2]).toEqual({ type: "session.updated", session });
    await conn.handleMessage(JSON.stringify({ type: "group.rename", group: "g-nope", name: "x" }));
    expect(out[3]).toMatchObject({ type: "error", code: "bad_frame", ref: "group.rename" });
  });

  it("switches a session's model, and says why when it cannot", async () => {
    const switched: string[] = [];
    let refuse = false;
    const models: ModelsPort = {
      async switch(s, model, effort) {
        if (refuse) throw new ModelSwitchError("Claude Code did not open its model picker.");
        switched.push(`${s.id}:${model}:${effort}`);
        const next = { ...s, model, ...(effort ? { effort } : {}) };
        registry.sessions.set(s.id, next);
        registry.emit("updated", next);
        return next;
      },
    };
    const { conn, registry, out } = connect({ models });
    await conn.handleMessage(fixture("client.hello.json"));
    out.length = 0;
    // The switch itself answers every client through the registry's `updated`.
    await conn.handleMessage(fixture("client.session.model.json"));
    expect(switched).toEqual(["gr-a1b2c3:Opus 5.5:high"]);
    expect(out).toEqual([{ type: "session.updated", session: { ...session, model: "Opus 5.5", effort: "high" } }]);
    // The same choice again touches nothing and still answers.
    await conn.handleMessage(fixture("client.session.model.json"));
    expect(switched).toHaveLength(1);
    expect(out).toHaveLength(2);
    const send = (frame: object) => conn.handleMessage(JSON.stringify({ type: "session.model", sessionId: session.id, ...frame }));
    await send({ model: "GPT-6-Luna" });
    expect(out[2]).toMatchObject({ type: "error", code: "bad_frame", ref: "session.model", message: "Claude Code has no model named GPT-6-Luna" });
    await send({ model: "Haiku 4.5", effort: "high" });
    expect(out[3]).toMatchObject({ type: "error", code: "bad_frame", ref: "session.model", message: "Haiku 4.5 has no high effort" });
    await conn.handleMessage(JSON.stringify({ type: "session.model", sessionId: "gr-nope", model: "Opus 5.5" }));
    expect(out[4]).toMatchObject({ type: "error", code: "unknown_session", ref: "session.model" });
    registry.sessions.set(session.id, { ...session, status: "working" });
    await send({ model: "Sonnet 5.5" });
    expect(out[5]).toMatchObject({ type: "error", code: "bad_frame", ref: "session.model", message: "the agent is working: choose a model when its turn is over" });
    registry.sessions.set(session.id, { ...session, waitingFor: "answer" });
    await send({ model: "Sonnet 5.5" });
    expect(out[6]).toMatchObject({ type: "error", code: "bad_frame", ref: "session.model" });
    registry.sessions.set(session.id, { ...session, agent: "codex" });
    await send({ model: "Sonnet 5.5" });
    expect(out[7]).toMatchObject({ type: "error", code: "bad_frame", ref: "session.model", message: "this session's agent has no models to choose from" });
    registry.sessions.set(session.id, session);
    refuse = true;
    await send({ model: "Sonnet 5.5", effort: "low" });
    expect(out[8]).toEqual({ type: "error", code: "tmux_failed", ref: "session.model", message: "Claude Code did not open its model picker." });
    expect(switched).toHaveLength(1);
  });

  it("answers session.model with bad_frame when the daemon switches no models", async () => {
    const { conn, out } = connect();
    await conn.handleMessage(fixture("client.hello.json"));
    out.length = 0;
    await conn.handleMessage(fixture("client.session.model.json"));
    expect(out[0]).toMatchObject({ type: "error", code: "bad_frame", ref: "session.model" });
  });

  it("accepts every client fixture without a bad_frame", async () => {
    const everything: ConversationsPort = {
      async list() { return []; },
      async preview() { return []; },
      async delete() { return null; },
      async resume({ name }) { return { ...session, id: `gr-${name}`, name }; },
    };
    const term = { input() {}, resize() {}, close() {} };
    const voice = new FakeVoice();
    const { conn, out } = connect({ conversations: everything, models: { async switch(s) { return s; } }, voice, openTerm: () => term });
    // `hello`, then `term.open` before the other term frames and `term.close` after them; `unpair` ends the connection, so it goes last.
    // `voice.key` before `voice.token`: a token needs a key.
    const first = ["client.hello.json", "client.term.open.json", "client.voice.key.json"];
    const last = ["client.term.close.json", "client.unpair.json"];
    const names = readdirSync(fixtures).filter((n) => n.startsWith("client.") && !first.includes(n) && !last.includes(n));
    for (const name of [...first, ...names, ...last]) {
      const before = out.length;
      await conn.handleMessage(fixture(name));
      const errors = out.slice(before).filter((f) => f.type === "error" && f.code === "bad_frame");
      expect(errors, name).toEqual([]);
    }
  });

  it("keeps a voice key and tells every client that asked; a refused key and a missing one are errors of their own", async () => {
    const voice = new FakeVoice();
    const { conn, out } = connect({ voice });
    const other = connect({ voice });
    await conn.handleMessage(fixture("client.hello.json"));
    await other.conn.handleMessage(fixture("client.hello.json"));
    out.length = 0;
    other.out.length = 0;
    // A client that never asked for `voice` still gets its answer, once; the other hears nothing.
    await conn.handleMessage(fixture("client.voice.key.json"));
    expect(out).toEqual([voice.frame()]);
    expect(out[0]).toMatchObject({ providers: [{ id: "openai", key: "sk-…ABCD" }, { id: "wispr-flow" }] });
    expect(other.out).toEqual([]);
    // Once it asked, a change by anyone reaches it, and its own change is not sent twice.
    await other.conn.handleMessage(fixture("client.voice.json"));
    await other.conn.handleMessage(fixture("client.voice.json"));
    expect(other.out).toHaveLength(2);
    await conn.handleMessage(JSON.stringify({ type: "voice.key", provider: "openai", key: null }));
    expect(other.out).toHaveLength(3);
    await other.conn.handleMessage(JSON.stringify({ type: "voice.key", provider: "wispr-flow", key: "fl-1" }));
    expect(other.out).toHaveLength(4);
    // Forgetting a key that is not kept changes nothing and still answers.
    await other.conn.handleMessage(JSON.stringify({ type: "voice.key", provider: "openai", key: null }));
    expect(other.out).toHaveLength(5);
    out.length = 0;
    await conn.handleMessage(JSON.stringify({ type: "voice.key", provider: "openai", key: "bad" }));
    expect(out).toEqual([{ type: "error", code: "provider_failed", message: "Incorrect API key provided.", ref: "voice.key" }]);
    await conn.handleMessage(JSON.stringify({ type: "voice.key", provider: "nobody", key: "k" }));
    expect(out[1]).toMatchObject({ type: "error", code: "bad_frame", ref: "voice.key" });
    // After close it hears no more.
    other.conn.handleClose();
    await conn.handleMessage(fixture("client.voice.key.json"));
    expect(other.out).toHaveLength(5);
  });

  it("answers voice.token with a token under the request's id, or an error under it", async () => {
    const voice = new FakeVoice();
    const { conn, out } = connect({ voice });
    await conn.handleMessage(fixture("client.hello.json"));
    out.length = 0;
    await conn.handleMessage(fixture("client.voice.token.json"));
    expect(out).toEqual([{ type: "error", code: "bad_frame", message: "No OpenAI API key is kept on this Mac.", ref: "voice.token", id: "v_1" }]);
    await conn.handleMessage(fixture("client.voice.key.json"));
    await conn.handleMessage(fixture("client.voice.token.json"));
    expect(out[2]).toEqual({ type: "voice.token", id: "v_1", provider: "openai", use: "talk", token: "ek_1", expiresAt: "2026-10-04T12:01:00.000Z", once: true });
    await conn.handleMessage(JSON.stringify({ type: "voice.key", provider: "wispr-flow", key: "fl-1" }));
    await conn.handleMessage(JSON.stringify({ type: "voice.token", id: "v_2", provider: "wispr-flow", use: "dictation" }));
    // A token that can be used again says nothing of `once`.
    expect(out[4]).toEqual({ type: "voice.token", id: "v_2", provider: "wispr-flow", use: "dictation", token: "ek_2", expiresAt: "2026-10-04T12:01:00.000Z" });
  });

  it("a daemon with no voice keys answers their frames with a bad frame", async () => {
    const { conn, out } = connect();
    await conn.handleMessage(fixture("client.hello.json"));
    out.length = 0;
    await conn.handleMessage(fixture("client.voice.json"));
    await conn.handleMessage(fixture("client.voice.token.json"));
    expect(out).toMatchObject([{ type: "error", code: "bad_frame", ref: "voice" }, { type: "error", code: "bad_frame", ref: "voice.token", id: "v_1" }]);
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
    const lists: boolean[] = [];
    const port: ConversationsPort = {
      async list(anyAgent) { lists.push(anyAgent); return calls.includes(`delete:${glass.id}`) ? [] : [glass]; },
      async preview(id) { return id === glass.id ? [{ kind: "asked", text: "Make it glass", at: "2026-10-02T14:14:10.000Z" }, { kind: "stopped", text: "Stopped", at: "2026-10-02T14:15:00.000Z" }] : null; },
      async delete(id) {
        calls.push(`delete:${id}`);
        return id === glass.id ? null : "it is open in a Grenade session; end that session first";
      },
      async resume({ name, agent, conversationId }) {
        calls.push(`resume:${name}:${conversationId}`);
        return conversationId === glass.id && agent === "claude" ? { ...session, id: `gr-${name}`, name, resumedFrom: conversationId } : `no ${agent} conversation ${conversationId} on this Mac`;
      },
    };
    return { port, calls, lists };
  }
  const hello = (platform = "ios", version = "1.0.13") =>
    JSON.stringify({ type: "hello", protocol: 1, token: "grt_example_token", client: { name: "Phone", platform, version } });

  it("lists every agent's conversations only to a client that asks with anyAgent, and keeps to it for a delete", async () => {
    const { port, lists } = withConversations();
    const { conn } = connect({ conversations: port });
    await conn.handleMessage(hello());
    await conn.handleMessage(JSON.stringify({ type: "conversations" }));
    await conn.handleMessage(JSON.stringify({ type: "conversations", anyAgent: true }));
    await conn.handleMessage(JSON.stringify({ type: "conversation.delete", conversationId: glass.id }));
    expect(lists).toEqual([false, true, true]);
  });

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

  it("refuses an agent it cannot start, resume for one without conversations or of the wrong agent, and every conversation frame without the port", async () => {
    const { port, calls } = withConversations();
    const a = connect({ conversations: port });
    await a.conn.handleMessage(hello());
    a.out.length = 0;
    await a.conn.handleMessage(JSON.stringify({ type: "session.create", name: "x", cwd: "/tmp", agent: "aider" }));
    await a.conn.handleMessage(JSON.stringify({ type: "session.create", name: "x", cwd: "/tmp", agent: "shell", resume: glass.id }));
    await a.conn.handleMessage(JSON.stringify({ type: "session.create", name: "x", cwd: "/tmp", agent: "codex", resume: glass.id }));
    expect(a.out).toMatchObject([
      { type: "error", code: "bad_frame", ref: "session.create", message: "this daemon cannot start aider" },
      { type: "error", code: "bad_frame", ref: "session.create", message: "Shell has no conversations to resume" },
      { type: "error", code: "bad_frame", ref: "session.create", message: `no codex conversation ${glass.id} on this Mac` },
    ]);
    // Only the Codex one got as far as the port, which knows which agent each conversation is.
    expect(calls.filter((c) => c.startsWith("resume:"))).toEqual([`resume:x:${glass.id}`]);
    const b = connect();
    await b.conn.handleMessage(hello());
    b.out.length = 0;
    await b.conn.handleMessage(JSON.stringify({ type: "conversations" }));
    expect(b.out[0]).toMatchObject({ type: "error", code: "bad_frame", ref: "conversations" });
  });
});

describe("Connection live terminal", () => {
  const hello = fixture("client.hello.json").replace(/"token":"[^"]*"/, '"token":"grt_example_token"');

  function withTerm() {
    const opened: TermOpen[] = [];
    const calls: string[] = [];
    const c = connect({
      openTerm(open) {
        opened.push(open);
        return {
          input: (b) => calls.push(`input:${b.toString("hex")}`),
          resize: (cols, rows) => calls.push(`resize:${cols}x${rows}`),
          close: () => calls.push("close"),
        };
      },
    });
    return { ...c, opened, calls };
  }

  it("opens, streams output as base64, passes input and resize, and closes", async () => {
    const { conn, out, opened, calls, events } = withTerm();
    await conn.handleMessage(hello);
    out.length = 0;
    await conn.handleMessage(fixture("client.term.open.json"));
    expect(opened[0]).toMatchObject({ sessionId: "gr-a1b2c3", cols: 46, rows: 30 });
    opened[0]!.output(Buffer.from("\x1bc/"), true);
    expect(out).toEqual([{ type: "term.output", sessionId: "gr-a1b2c3", data: Buffer.from("\x1bc/").toString("base64"), reset: true }]);
    await conn.handleMessage(fixture("client.term.input.json"));
    await conn.handleMessage(JSON.stringify({ type: "term.input", sessionId: "gr-a1b2c3", data: "Gw==" }));
    await conn.handleMessage(fixture("client.term.resize.json"));
    await conn.handleMessage(fixture("client.term.close.json"));
    expect(calls).toEqual(["input:2f", "input:1b", "resize:120x40", "close"]);
    expect(events).toContain("interrupted:gr-a1b2c3");
  });

  it("refuses input without an open stream", async () => {
    const { conn, out } = withTerm();
    await conn.handleMessage(hello);
    out.length = 0;
    await conn.handleMessage(fixture("client.term.input.json"));
    expect(out[0]).toMatchObject({ type: "error", code: "bad_frame", ref: "term.input" });
  });

  it("says term.closed when the stream ends by itself, and closes streams when the socket closes", async () => {
    const { conn, out, opened, calls } = withTerm();
    await conn.handleMessage(hello);
    await conn.handleMessage(fixture("client.term.open.json"));
    opened[0]!.closed("ended");
    expect(out.at(-1)).toEqual({ type: "term.closed", sessionId: "gr-a1b2c3", reason: "ended" });
    await conn.handleMessage(fixture("client.term.open.json"));
    conn.handleClose();
    expect(calls).toEqual(["close"]);
  });

  it("answers bad_frame when the daemon streams no terminal", async () => {
    const { conn, out } = connect();
    await conn.handleMessage(hello);
    out.length = 0;
    await conn.handleMessage(fixture("client.term.open.json"));
    expect(out[0]).toMatchObject({ type: "error", code: "bad_frame", ref: "term.open" });
  });
});
