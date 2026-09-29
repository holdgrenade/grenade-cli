import { describe, expect, it } from "vitest";
import { initialStatus, reduceStatus, shownWaitingFor, WAITING_TO_IDLE_MS, WORKING_SETTLE_MS, type StatusState } from "../src/sessions/status.js";

const run = (start: StatusState, events: Parameters<typeof reduceStatus>[1][]) => events.reduce(reduceStatus, start);

describe("status machine (heuristic agents)", () => {
  it("starts working, settles to waiting after 1.5 s of quiet", () => {
    let s = initialStatus(0);
    s = run(s, [{ kind: "output", changed: true, at: 100 }, { kind: "output", changed: false, at: 1000 }]);
    expect(s.status).toBe("working");
    s = reduceStatus(s, { kind: "output", changed: false, at: 100 + WORKING_SETTLE_MS });
    expect(s.status).toBe("waiting");
    expect(s.since).toBe(100 + WORKING_SETTLE_MS);
  });

  it("goes back to working when output changes", () => {
    let s = { ...initialStatus(0), status: "waiting" as const, since: 5000 };
    s = reduceStatus(s, { kind: "output", changed: true, at: 6000 });
    expect(s.status).toBe("working");
  });

  it("seen turns waiting into idle, and nothing else", () => {
    const waiting = { ...initialStatus(0), status: "waiting" as const };
    expect(reduceStatus(waiting, { kind: "seen", at: 1 }).status).toBe("idle");
    const working = initialStatus(0);
    expect(reduceStatus(working, { kind: "seen", at: 1 }).status).toBe("working");
  });

  it("waiting becomes idle after 10 minutes", () => {
    const waiting = { ...initialStatus(0), status: "waiting" as const, since: 0 };
    expect(reduceStatus(waiting, { kind: "output", changed: false, at: WAITING_TO_IDLE_MS - 1 }).status).toBe("waiting");
    expect(reduceStatus(waiting, { kind: "output", changed: false, at: WAITING_TO_IDLE_MS }).status).toBe("idle");
  });

  it("gone is terminal", () => {
    let s = reduceStatus(initialStatus(0), { kind: "gone", at: 1 });
    expect(s.status).toBe("gone");
    s = run(s, [{ kind: "hook", status: "working", at: 2 }, { kind: "output", changed: true, at: 3 }, { kind: "seen", at: 4 }]);
    expect(s.status).toBe("gone");
  });

  it("returns the same object when nothing changes", () => {
    const s = initialStatus(0);
    expect(reduceStatus(s, { kind: "output", changed: false, at: 10 })).toBe(s);
  });
});

describe("status machine (hook-driven)", () => {
  it("hooks win over output once seen", () => {
    let s = initialStatus(0);
    s = reduceStatus(s, { kind: "hook", status: "waiting", at: 100 });
    expect(s.status).toBe("waiting");
    expect(s.hookDriven).toBe(true);
    // the screen repaints (cursor blink, spinner) but the hook said waiting
    s = reduceStatus(s, { kind: "output", changed: true, at: 200 });
    expect(s.status).toBe("waiting");
    s = reduceStatus(s, { kind: "hook", status: "working", at: 300 });
    expect(s.status).toBe("working");
    // quiet screen does not flip a hook-driven working session to waiting
    s = reduceStatus(s, { kind: "output", changed: false, at: 300 + WORKING_SETTLE_MS * 5 });
    expect(s.status).toBe("working");
  });

  it("SessionEnd maps to idle via the hook event", () => {
    const s = reduceStatus(initialStatus(0), { kind: "hook", status: "idle", at: 1 });
    expect(s.status).toBe("idle");
  });
});

describe("why a session waits", () => {
  const hook = (status: "waiting" | "working" | "idle", at: number, waitingFor?: "answer" | "done") => ({ kind: "hook" as const, status, waitingFor, at });

  it("a hook says whether the agent asks or has finished", () => {
    expect(shownWaitingFor(reduceStatus(initialStatus(0), hook("waiting", 10, "answer")))).toBe("answer");
    expect(shownWaitingFor(reduceStatus(initialStatus(0), hook("waiting", 10, "done")))).toBe("done");
    expect(shownWaitingFor(reduceStatus(initialStatus(0), hook("waiting", 10)))).toBe("done");
  });

  it("a stable screen counts as finished", () => {
    const s = run(initialStatus(0), [{ kind: "output", changed: true, at: 100 }, { kind: "output", changed: false, at: 100 + WORKING_SETTLE_MS }]);
    expect(s.status).toBe("waiting");
    expect(shownWaitingFor(s)).toBe("done");
  });

  it("only a waiting session shows a reason", () => {
    const waiting = reduceStatus(initialStatus(0), hook("waiting", 10, "answer"));
    expect(shownWaitingFor(reduceStatus(waiting, { kind: "seen", at: 20 }))).toBeUndefined();
    expect(shownWaitingFor(reduceStatus(waiting, hook("working", 20)))).toBeUndefined();
    expect(shownWaitingFor(reduceStatus(waiting, { kind: "gone", at: 20 }))).toBeUndefined();
  });

  it("a question after a finished turn counts from the question", () => {
    const s = run(initialStatus(0), [hook("waiting", 10, "done"), hook("waiting", 50, "answer")]);
    expect(s).toMatchObject({ status: "waiting", waitingFor: "answer", since: 50 });
  });

  it("the same reason again changes nothing", () => {
    const first = reduceStatus(initialStatus(0), hook("waiting", 10, "answer"));
    expect(reduceStatus(first, hook("waiting", 6000, "answer"))).toBe(first);
  });

  it("a reason the user has seen does not raise the session again", () => {
    // PermissionRequest, the phone shows it, and six seconds later the Notification for the same prompt.
    const seen = run(initialStatus(0), [hook("waiting", 10, "answer"), { kind: "seen", at: 2000 }]);
    expect(seen.status).toBe("idle");
    expect(reduceStatus(seen, hook("waiting", 6000, "answer")).status).toBe("idle");
  });

  it("but the next question, after more work, does", () => {
    const s = run(initialStatus(0), [hook("waiting", 10, "answer"), { kind: "seen", at: 2000 }, hook("working", 3000), hook("waiting", 9000, "answer")]);
    expect(s).toMatchObject({ status: "waiting", waitingFor: "answer", since: 9000 });
  });

  it("a session that ended forgets what it waited for", () => {
    const s = run(initialStatus(0), [hook("working", 10), hook("idle", 20), hook("waiting", 30, "done")]);
    expect(s).toMatchObject({ status: "waiting", waitingFor: "done", since: 30 });
  });
});
