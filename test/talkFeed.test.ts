/** The feed: which row a session's change makes, and the watcher that settles, waits for the reply and dedupes. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DaemonFrame, TALK_FEED_TEXT_MAX, type ActivityEntry, type Session, type TalkEntry } from "@grenade/protocol";
import { FeedWatcher } from "../src/talk/feedWatcher.js";
import { REPLY_WAIT_MS, SENT_TURN_MS, SETTLE_MS, feedText, finishedText, freshReply, isOwnersPrompt, lastRowsBySession, repeatsLast, stillWaiting, waitingKind, workingText } from "../src/talk/talkFeed.js";
import type { NewTalkEntry } from "../src/talk/talkThread.js";

const fixtures = join(import.meta.dirname, "..", "..", "grenade-protocol", "fixtures");
const T0 = Date.parse("2026-10-06T09:00:00.000Z");

const session = (id: string, o: Partial<Session> = {}): Session => ({
  id,
  name: id.slice(3),
  agent: "claude",
  cwd: "/w",
  status: "idle",
  statusSince: "2026-10-06T08:00:00.000Z",
  lastLine: "",
  createdAt: "2026-10-06T08:00:00.000Z",
  ...o,
});
const at = (ms: number) => new Date(T0 + ms).toISOString();

describe("talkFeed rules", () => {
  it("folds and cuts a row's text", () => {
    expect(feedText("  Fixed   the\n\nbug.  ")).toBe("Fixed the bug.");
    const long = feedText("word ".repeat(100));
    expect(long).toHaveLength(TALK_FEED_TEXT_MAX);
    expect(long.endsWith("…")).toBe(true);
  });

  it("writes working for the owner's prompt, not for a slash command, the agent's own text, or a turn Talk sent", () => {
    expect(workingText("Add a lockout test\nfor the login", undefined, T0)).toBe("Add a lockout test for the login");
    expect(isOwnersPrompt("/model")).toBe(false);
    expect(workingText("<task-notification>done</task-notification>", undefined, T0)).toBeNull();
    expect(workingText("go", T0 - 5_000, T0)).toBeNull();
    expect(workingText("go", T0 - SENT_TURN_MS - 1, T0)).toBe("go");
    expect(workingText("   ", undefined, T0)).toBeNull();
    expect(workingText('<pasted_content id="62cc">\nAdd topics\nfor the teams\n</pasted_content>', undefined, T0)).toBe("Add topics for the teams");
  });

  it("reads waiting as the push does: answer and stopped need the owner, done finished", () => {
    const working = session("gr-a", { status: "working" });
    expect(waitingKind(working, session("gr-a", { status: "waiting", waitingFor: "answer" }))).toBe("needsYou");
    expect(waitingKind(working, session("gr-a", { status: "waiting", waitingFor: "stopped" }))).toBe("needsYou");
    expect(waitingKind(working, session("gr-a", { status: "waiting", waitingFor: "done" }))).toBe("finished");
    expect(waitingKind(working, session("gr-a", { status: "idle" }))).toBeNull();
    const done = session("gr-a", { status: "waiting", waitingFor: "done", statusSince: at(0) });
    expect(stillWaiting(done, done)).toBe(true);
    expect(stillWaiting(done, { ...done, status: "working" })).toBe(false);
    expect(stillWaiting(done, { ...done, statusSince: at(1) })).toBe(false);
  });

  it("takes the turn's own reply, never an earlier turn's, and falls back to the summary", () => {
    const entries: ActivityEntry[] = [
      { kind: "said", text: "old reply", at: at(-60_000) },
      { kind: "asked", text: "do it", at: at(0) },
      { kind: "said", text: "Did it.", at: at(5_000) },
    ];
    expect(freshReply(entries, T0)).toBe("Did it.");
    expect(freshReply(entries.slice(0, 2), T0)).toBeUndefined();
    expect(freshReply(entries.slice(0, 1), T0)).toBeUndefined();
    expect(finishedText(undefined, "Fixing the footer.")).toBe("Fixing the footer.");
    expect(finishedText(undefined, undefined)).toBe("");
  });

  it("dedupes against the session's last row, and reads it from a day's rows", () => {
    expect(repeatsLast({ kind: "needsYou", text: "Bash: rm" }, "needsYou", "Bash: rm")).toBe(true);
    expect(repeatsLast({ kind: "working", text: "x" }, "needsYou", "Bash: rm")).toBe(false);
    const frame = DaemonFrame.parse(JSON.parse(readFileSync(join(fixtures, "daemon.talk.thread.json"), "utf8")));
    if (frame.type !== "talk.thread") throw new Error("not a thread");
    const last = lastRowsBySession(frame.entries);
    expect(last.get("gr-a1b2c3")).toMatchObject({ kind: "finished" });
    expect(last.get("gr-d4e5f6")).toMatchObject({ kind: "needsYou", text: "Run npm test -- rateLimit?" });
    expect(last.get("gr-m4n5o6")).toMatchObject({ kind: "working" });
    expect(last.get("gr-j1k2l3")).toMatchObject({ kind: "started" });
    // Every feed row of the fixture is within the feed's cap.
    for (const e of frame.entries) if (["working", "needsYou", "finished"].includes(e.kind)) expect(e.text.length).toBeLessThanOrEqual(TALK_FEED_TEXT_MAX);
  });
});

class FakeRegistry extends EventEmitter {
  sessions = new Map<string, Session>();
  list() {
    return [...this.sessions.values()];
  }
  get(id: string) {
    return this.sessions.get(id);
  }
  update(s: Session) {
    this.sessions.set(s.id, s);
    this.emit("updated", s);
  }
}

describe("FeedWatcher", () => {
  let now = T0;
  beforeEach(() => {
    vi.useFakeTimers();
    now = T0;
  });
  afterEach(() => vi.useRealTimers());

  function setup(initial: Session[] = [session("gr-api", { title: "Login rate limit" })]) {
    const registry = new FakeRegistry();
    for (const s of initial) registry.sessions.set(s.id, s);
    const entries = new Map<string, ActivityEntry[]>();
    const asking = new Map<string, string>();
    const rows: TalkEntry[] = [];
    const watcher = new FeedWatcher({
      registry,
      entriesOf: (id) => entries.get(id) ?? [],
      askingOf: (id) => asking.get(id),
      hasActivity: (k) => k !== "shell",
      lastRow: (id) => [...rows].reverse().find((r) => r.session === id),
      append: (row: NewTalkEntry) => void rows.push({ ...row, id: `t-${rows.length + 1}`, at: new Date(now).toISOString() } as TalkEntry),
      now: () => now,
    });
    // The watcher's clock moves with the timers, a tenth of a second at a time.
    const advance = async (ms: number) => {
      for (let left = ms; left > 0; left -= 100) {
        const step = Math.min(100, left);
        now += step;
        await vi.advanceTimersByTimeAsync(step);
      }
    };
    const set = (o: Partial<Session>) => registry.update({ ...registry.get("gr-api")!, ...o });
    return { watcher, registry, entries, asking, rows, advance, set };
  }
  const short = (rows: TalkEntry[]) => rows.map((r) => `${r.kind}:${r.text}`);

  it("writes working when a turn starts and finished with the start of its reply", async () => {
    const { watcher, entries, rows, advance, set } = setup();
    watcher.asked("gr-api", "Add a lockout test");
    set({ status: "working", statusSince: at(0) });
    await advance(20_000);
    entries.set("gr-api", [{ kind: "asked", text: "Add a lockout test", at: at(0) }, { kind: "said", text: `Added the test.\n\n${"More. ".repeat(80)}`, at: at(19_000) }]);
    set({ status: "waiting", waitingFor: "done", statusSince: at(20_000) });
    await advance(SETTLE_MS);
    expect(short(rows)[0]).toBe("working:Add a lockout test");
    expect(rows[1]?.kind).toBe("finished");
    expect(rows[1]?.text.startsWith("Added the test. More.")).toBe(true);
    expect(rows[1]?.text).toHaveLength(TALK_FEED_TEXT_MAX);
    expect(rows[1]).toMatchObject({ session: "gr-api", title: "Login rate limit" });
  });

  it("waits for a reply the transcript has not given yet, and falls back to the summary", async () => {
    const { watcher, entries, rows, advance, set } = setup();
    watcher.asked("gr-api", "go");
    set({ status: "working", statusSince: at(0) });
    set({ status: "waiting", waitingFor: "done", statusSince: at(10) });
    await advance(SETTLE_MS + 1_000);
    expect(rows).toHaveLength(1);
    // The catch-up reads the reply a moment later: it is the row's text.
    entries.set("gr-api", [{ kind: "asked", text: "go", at: at(0) }, { kind: "said", text: "Gone.", at: at(2_000) }]);
    await advance(1_000);
    expect(short(rows)).toEqual(["working:go", "finished:Gone."]);
    // A reply that never comes: the summary, after the wait. (The store holds the hook's prompt before the feed hears it.)
    entries.set("gr-api", [...entries.get("gr-api")!, { kind: "asked", text: "again", at: new Date(now).toISOString() }]);
    watcher.asked("gr-api", "again");
    set({ status: "working", statusSince: at(30_000) });
    set({ status: "waiting", waitingFor: "done", statusSince: at(30_010), summary: "Doing it again." });
    await advance(SETTLE_MS + REPLY_WAIT_MS + 1_000);
    expect(short(rows).slice(2)).toEqual(["working:again", "finished:Doing it again."]);
  });

  it("writes nothing for a status that flickers and comes back", async () => {
    const { watcher, rows, advance, set } = setup();
    watcher.asked("gr-api", "go");
    set({ status: "working", statusSince: at(0) });
    set({ status: "waiting", waitingFor: "done", statusSince: at(10) });
    await advance(500);
    set({ status: "working", statusSince: at(600) });
    await advance(SETTLE_MS * 2);
    set({ status: "waiting", waitingFor: "answer", statusSince: at(4_000) });
    await advance(200);
    set({ status: "working", statusSince: at(4_300) });
    await advance(SETTLE_MS * 2);
    expect(short(rows)).toEqual(["working:go"]);
  });

  it("writes needsYou with what the card asks, once while the same question stays", async () => {
    const { asking, rows, advance, set } = setup();
    asking.set("gr-api", "Bash: npm test -- rateLimit");
    set({ status: "waiting", waitingFor: "answer", statusSince: at(0) });
    await advance(SETTLE_MS);
    // Answered in the terminal, then the same card again before anything else happened.
    set({ status: "working", statusSince: at(2_000) });
    set({ status: "waiting", waitingFor: "answer", statusSince: at(3_000) });
    await advance(SETTLE_MS);
    expect(short(rows)).toEqual(["needsYou:Bash: npm test -- rateLimit"]);
    // A turn that stopped partway needs the owner too, with no question to quote.
    asking.delete("gr-api");
    set({ status: "waiting", waitingFor: "stopped", statusSince: at(9_000) });
    await advance(SETTLE_MS);
    expect(short(rows)).toEqual(["needsYou:Bash: npm test -- rateLimit", "needsYou:"]);
  });

  it("writes no working for a turn Talk sent, and still its finished", async () => {
    const { watcher, entries, rows, advance, set } = setup();
    watcher.sentTo("gr-api");
    await advance(2_000);
    watcher.asked("gr-api", "How far did you get?");
    set({ status: "working", statusSince: at(2_000) });
    entries.set("gr-api", [{ kind: "asked", text: "How far did you get?", at: at(2_000) }, { kind: "said", text: "Halfway.", at: at(5_000) }]);
    set({ status: "waiting", waitingFor: "done", statusSince: at(6_000) });
    await advance(SETTLE_MS);
    expect(short(rows)).toEqual(["finished:Halfway."]);
  });

  it("writes no finished for a turn it did not see start, and nothing for a shell", async () => {
    const { rows, registry, advance, set } = setup([session("gr-api"), session("gr-sh", { agent: "shell" })]);
    // A daemon that restarted picks up a session that finishes: no turn start was seen.
    set({ status: "working", statusSince: at(0) });
    set({ status: "waiting", waitingFor: "done", statusSince: at(10) });
    registry.update(session("gr-sh", { agent: "shell", status: "waiting", waitingFor: "answer", statusSince: at(10) }));
    await advance(SETTLE_MS + REPLY_WAIT_MS);
    expect(rows).toEqual([]);
  });
});
