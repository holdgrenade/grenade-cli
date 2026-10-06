/** Which session the owner means, by fixed rules: the port of the apps' VoiceRouterTests, case for case. */
import { describe, expect, it } from "vitest";
import type { SessionStatus } from "@grenade/protocol";
import { NAME_WEIGHT, ROUTE_ACTIONS, SUMMARY_WEIGHT, THRESHOLD, askAbout, decide, isRouteAction, keywords, words, type Candidate, type Decision, type RouteAction } from "../src/talk/talkRouter.js";

const now = 1_000_000_000;

function candidate(handle: string, o: { title: string; summary?: string; folder?: string; status?: SessionStatus; minutesAgo?: number; recentWords?: string }): Candidate {
  return {
    key: `gr-${handle}`,
    handle,
    title: o.title,
    name: handle,
    folder: o.folder ?? "code",
    summary: o.summary,
    status: o.status ?? "idle",
    statusSince: now - (o.minutesAgo ?? 120) * 60_000,
    recentWords: o.recentWords,
  };
}

const route = (intent: string, candidates: Candidate[], o: { title?: string; action?: RouteAction } = {}): Decision => decide(intent, o.title, o.action ?? "prompt", candidates, now);
const routed = (d: Decision): string | null => ("route" in d.outcome ? d.outcome.route.handle : null);

describe("talkRouter", () => {
  it("keeps the words that count", () => {
    expect(keywords("Tell the Relay one, please: the relay!")).toEqual(["relay"]);
    expect(words("grenade-relay v2")).toEqual(["grenade", "relay", "v2"]);
    expect(keywords("the one")).toEqual([]);
  });

  it("weighs a word in the title above one in the summary", () => {
    const decision = route("the login one", [
      candidate("a", { title: "Rate limit the login route", minutesAgo: 600 }),
      candidate("b", { title: "Billing page", summary: "Fixing the login redirect.", status: "working", minutesAgo: 0 }),
    ]);
    // The summary's session is working and fresh, and still loses: each weight outranks all below it together.
    expect(decision.ranked.map((s) => s.candidate.handle)).toEqual(["a", "b"]);
    // That close, it asks. With the two equally busy the title's session is sure enough to send to.
    expect(routed(decision)).toBeNull();
    const clear = route("the login one", [candidate("a", { title: "Rate limit the login route" }), candidate("b", { title: "Billing page", summary: "Fixing the login redirect." })]);
    expect(routed(clear)).toBe("a");
    expect(clear.confidence).toBeGreaterThanOrEqual(THRESHOLD);
    expect(clear.confidence).toBeLessThan(1);
  });

  it("weighs a word in the summary above status, and status above recency", () => {
    const summary = route("the footer", [
      candidate("a", { title: "Website", summary: "Fixing the footer links.", minutesAgo: 600 }),
      candidate("b", { title: "Other", status: "working", minutesAgo: 0 }),
    ]);
    expect(summary.ranked[0]?.candidate.handle).toBe("a");
    const status = route(
      "anything",
      [
        candidate("idle", { title: "One", status: "idle", minutesAgo: 0 }),
        candidate("working", { title: "Two", status: "working", minutesAgo: 59 }),
        candidate("waiting", { title: "Three", status: "waiting", minutesAgo: 30 }),
      ],
      { action: "status" },
    );
    // Working and waiting above idle, however fresh the idle one; among the active ones the more recent first.
    expect(status.ranked.map((s) => s.candidate.handle)).toEqual(["waiting", "working", "idle"]);
  });

  it("counts the folder and the name as the summary does", () => {
    const decision = route("the relay one", [
      candidate("a", { title: "Close idle sockets", folder: "grenade-relay" }),
      candidate("b", { title: "Hold Grenade SEO program", folder: "grenade-website", status: "working", minutesAgo: 1 }),
    ]);
    expect(routed(decision)).toBe("a");
    expect(NAME_WEIGHT).toBe(SUMMARY_WEIGHT);
    const said = route("the migration", [candidate("a", { title: "API", recentWords: "Run migration 0042?" }), candidate("b", { title: "Shop" })]);
    expect(routed(said)).toBe("a");
  });

  it("routes a sole match, which a busy session nobody named does not contest", () => {
    const decision = route("the relay", [candidate("a", { title: "Relay", minutesAgo: 600 }), candidate("b", { title: "Website", status: "working", minutesAgo: 0 })]);
    expect(routed(decision)).toBe("a");
    expect(decision.confidence).toBe(1);
  });

  it("asks on a tie", () => {
    const decision = route("the api one", [candidate("a", { title: "API refactor", status: "working", minutesAgo: 5 }), candidate("b", { title: "API tests", status: "working", minutesAgo: 6 })]);
    expect("confirm" in decision.outcome && decision.outcome.confirm).toContain("API refactor");
    expect("confirm" in decision.outcome && decision.outcome.confirm).toContain("API tests");
    expect(askAbout(decision).map((c) => c.title)).toEqual(["API refactor", "API tests"]);
  });

  it("asks under the threshold", () => {
    // Both match in the title; one is working, which puts it ahead, but not by enough to send on.
    const decision = route("the api one", [candidate("a", { title: "API refactor", status: "working", minutesAgo: 0 }), candidate("b", { title: "API tests", status: "idle", minutesAgo: 600 })]);
    expect(decision.ranked[0]?.candidate.handle).toBe("a");
    expect(decision.confidence).toBeLessThan(THRESHOLD);
    expect(routed(decision)).toBeNull();
  });

  it("asks when nothing matched, and never guesses the busiest session", () => {
    const decision = route("the database thing", [candidate("a", { title: "Relay", status: "working", minutesAgo: 0 }), candidate("b", { title: "Website" })]);
    expect(routed(decision)).toBeNull();
    expect(decision.confidence).toBe(0);
    expect(routed(route("", [candidate("a", { title: "Relay" })]))).toBeNull();
  });

  it("routes to a title said exactly, whatever the scores", () => {
    const candidates = [candidate("a", { title: "API refactor", status: "working", minutesAgo: 0 }), candidate("b", { title: "API tests" }), candidate("c", { title: "api tests" })];
    const one = route("the api one", candidates, { title: " api REFACTOR " });
    expect(routed(one)).toBe("a");
    expect(one.confidence).toBe(1);
    // The session's name works as its title does.
    expect(routed(route("whatever", candidates, { title: "a" }))).toBe("a");
    expect(routed(route("the api one", candidates, { title: "API tests" }))).toBeNull();
    expect(routed(route("the api one", candidates, { title: "No such session" }))).toBeNull();
    // An empty title is no title.
    expect(routed(route("the refactor", candidates, { title: "  " }))).toBe("a");
  });

  it("sends no prompt to a session that ended, which can still be read", () => {
    const candidates = [candidate("a", { title: "Data pipeline", status: "gone" })];
    expect(routed(route("the pipeline", candidates, { action: "prompt" }))).toBeNull();
    expect(routed(route("the pipeline", candidates, { title: "Data pipeline", action: "prompt" }))).toBeNull();
    expect(routed(route("the pipeline", candidates, { action: "read" }))).toBe("a");
    expect(routed(route("the pipeline", candidates, { action: "status" }))).toBe("a");
  });

  it("leads only to a status, a read or a prompt", () => {
    expect([...ROUTE_ACTIONS]).toEqual(["status", "read", "prompt"]);
    expect(isRouteAction("create_session")).toBe(false);
    expect(isRouteAction("answer")).toBe(false);
    expect(isRouteAction("prompt")).toBe(true);
  });
});
