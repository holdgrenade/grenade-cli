import { EventEmitter } from "node:events";
import type { Session } from "@grenade/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { silentLogger } from "../src/log.js";
import { claudeSummaryArgs } from "../src/summary/claudeCli.js";
import { Summarizer } from "../src/summary/summarizer.js";
import { SUMMARY_MAX, buildSummaryInput, parseSummaryReply } from "../src/summary/summaryPrompt.js";
import { aiTitleIn, clipTitle } from "../src/transcript/aiTitle.js";
import { summaryDelay } from "../src/summary/summaryTiming.js";

describe("buildSummaryInput", () => {
  it("keeps the last three prompts on one line each and the tail of the screen", () => {
    const text = buildSummaryInput({
      name: "grenade",
      agent: "claude",
      cwd: "/Users/me/grenade",
      prompts: ["one", "two\nlines", "three", "four"],
      lines: ["", "⏺ Bash(npm test)", "  ⎿ 42 passed   ", ""],
    });
    expect(text).toBe(
      [
        "Session: grenade (claude) in /Users/me/grenade",
        "",
        "Recent prompts from the user:",
        "- two lines",
        "- three",
        "- four",
        "",
        "End of the terminal screen:",
        "⏺ Bash(npm test)",
        "  ⎿ 42 passed",
      ].join("\n"),
    );
  });
  it("says when there is nothing to go on", () => {
    const text = buildSummaryInput({ name: "zsh", agent: "shell", cwd: "", prompts: [], lines: [] });
    expect(text).toContain("(none)");
    expect(text).toContain("(empty)");
    expect(text).toContain("an unknown folder");
  });
});

describe("parseSummaryReply", () => {
  it("reads a title and a summary, stripping labels, quotes and markdown", () => {
    expect(parseSummaryReply('\n  "Flaky reconnect test"\n"Fixing the flaky reconnect test."\nMore text')).toEqual({
      title: "Flaky reconnect test",
      summary: "Fixing the flaky reconnect test.",
    });
    expect(parseSummaryReply("**Title:** Poller refactor.\n- **Refactoring the poller.**")).toEqual({
      title: "Poller refactor",
      summary: "Refactoring the poller.",
    });
  });
  it("takes a single line as a summary without a title", () => {
    expect(parseSummaryReply("Refactoring the poller.")).toEqual({ title: undefined, summary: "Refactoring the poller." });
  });
  it("rejects empty replies", () => {
    expect(parseSummaryReply("  \n ")).toEqual({ title: undefined, summary: undefined });
    expect(parseSummaryReply('""')).toEqual({ title: undefined, summary: undefined });
  });
  it("clips long replies at a word with an ellipsis", () => {
    const { title, summary } = parseSummaryReply("word ".repeat(30) + "\n" + "word ".repeat(100));
    expect(summary!.length).toBeLessThanOrEqual(SUMMARY_MAX);
    expect(summary!.endsWith("word…")).toBe(true);
    expect(title!.length).toBeLessThanOrEqual(60);
    expect(title!.endsWith("word…")).toBe(true);
  });
});

describe("aiTitleIn", () => {
  it("takes the newest ai-title line", () => {
    const jsonl = [
      '{"type":"ai-title","aiTitle":"Grenade root directory","sessionId":"x"}',
      '{"type":"user","message":{"role":"user","content":"ai-title"}}',
      '{"type":"ai-title","aiTitle":"Session title rename","sessionId":"x"}',
      "not json",
    ].join("\n");
    expect(aiTitleIn(jsonl)).toBe("Session title rename");
    expect(aiTitleIn('{"type":"user"}')).toBeNull();
  });
  it("clips to one short line", () => {
    expect(clipTitle("  Login\n redirect fix. ")).toBe("Login redirect fix");
    expect(clipTitle("   ")).toBeUndefined();
  });
});

describe("summaryDelay", () => {
  it("runs at the wanted delay when never run", () => {
    expect(summaryDelay(1000, 0, undefined)).toBe(0);
    expect(summaryDelay(1000, 8000, undefined)).toBe(8000);
  });
  it("waits out the minimum gap after the last run", () => {
    expect(summaryDelay(10_000, 0, 0, 60_000)).toBe(50_000);
    expect(summaryDelay(70_000, 0, 0, 60_000)).toBe(0);
  });
});

describe("claudeSummaryArgs", () => {
  it("uses Haiku with no tools, settings (hooks) or MCP", () => {
    const args = claudeSummaryArgs();
    expect(args.slice(0, 3)).toEqual(["-p", "--model", "haiku"]);
    expect(args).toContain("--no-session-persistence");
    expect(args[args.indexOf("--tools") + 1]).toBe("");
    expect(args[args.indexOf("--setting-sources") + 1]).toBe("");
  });
});

describe("Summarizer", () => {
  const base: Session = {
    id: "gr-a",
    name: "a",
    agent: "claude",
    cwd: "/Users/me/a",
    status: "working",
    statusSince: "2026-09-27T12:00:00.000Z",
    lastLine: "",
    createdAt: "2026-09-27T12:00:00.000Z",
  };

  function setup(reply: () => Promise<string> = async () => "Fixing the tests.") {
    const events = new EventEmitter();
    let session: Session | undefined = { ...base };
    let lines = ["$ npm test"];
    const summaries: string[] = [];
    const titles: string[] = [];
    const inputs: string[] = [];
    const registry = {
      on: (e: string, l: (...a: never[]) => void) => events.on(e, l),
      off: (e: string, l: (...a: never[]) => void) => events.off(e, l),
      get: () => session,
      screenOf: () => ({ lines }),
      setSummary: (_: string, s: string) => void summaries.push(s),
      setGuessedTitle: (_: string, t: string) => void titles.push(t),
    };
    const summarizer = new Summarizer({
      registry,
      log: silentLogger,
      now: () => Date.now(),
      run: (input) => {
        inputs.push(input);
        return reply();
      },
    });
    summarizer.start();
    return {
      summarizer,
      summaries,
      titles,
      inputs,
      update: (patch: Partial<Session>) => {
        session = { ...base, ...session, ...patch };
        events.emit("updated", session);
      },
      setLines: (l: string[]) => (lines = l),
      remove: () => {
        session = undefined;
        events.emit("removed", base.id);
      },
    };
  }

  beforeEach(() => vi.useFakeTimers());

  it("sets the title from a two-line reply", async () => {
    const s = setup(async () => "Test fixes\nFixing the tests.");
    s.update({ status: "waiting" });
    await vi.advanceTimersByTimeAsync(0);
    expect(s.titles).toEqual(["Test fixes"]);
    expect(s.summaries).toEqual(["Fixing the tests."]);
  });
  afterEach(() => vi.useRealTimers());

  it("summarizes a few seconds after work starts and at once when it waits", async () => {
    const s = setup();
    s.update({ status: "working" });
    await vi.advanceTimersByTimeAsync(7_000);
    expect(s.inputs).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(s.summaries).toEqual(["Fixing the tests."]);
    expect(s.titles).toEqual([]);

    s.setLines(["$ npm test", "42 passed"]);
    s.update({ status: "waiting" });
    await vi.advanceTimersByTimeAsync(0);
    expect(s.inputs).toHaveLength(1); // within a minute of the last run
    await vi.advanceTimersByTimeAsync(59_000);
    expect(s.inputs).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(s.inputs).toHaveLength(2);
  });

  it("skips a run when nothing the model sees has changed", async () => {
    const s = setup();
    s.update({ status: "waiting" });
    await vi.advanceTimersByTimeAsync(0);
    s.update({ status: "working" });
    s.update({ status: "waiting" });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(s.inputs).toHaveLength(1);
  });

  it("includes prompts from hooks", async () => {
    const s = setup();
    s.summarizer.notePrompt("gr-a", "add a summary to the list rows");
    await vi.advanceTimersByTimeAsync(8_000);
    expect(s.inputs[0]).toContain("- add a summary to the list rows");
  });

  it("does not run for removed or gone sessions, and retries after a failure", async () => {
    let fail = true;
    const s = setup(async () => {
      if (fail) throw new Error("no login");
      return "Back again.";
    });
    s.update({ status: "waiting" });
    await vi.advanceTimersByTimeAsync(0);
    expect(s.summaries).toEqual([]);
    fail = false;
    s.update({ status: "working" });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(s.summaries).toEqual(["Back again."]);

    s.update({ status: "gone" });
    s.update({ status: "waiting" });
    s.remove();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(s.inputs).toHaveLength(2);
  });
});
