/**
 * Which session the owner means, worked out from their words by fixed rules instead of the agent's judgement, so a
 * prompt never goes to a session on a guess (PROTOCOL.md "Talk by text", "What the agent may do"). Pure, tested.
 *
 * A port of the apps' `VoiceRouter` (grenade-ios `Grenade/Core/Voice/VoiceRouter.swift`), so typed and spoken Talk
 * route alike: the same weights, threshold, tie margin, stop words and outcomes. Change both together.
 *
 * Each candidate is scored, in the order Adam gave (2026-10-04): a word of the intent in the title counts most, then
 * one in the summary, then the status (working or waiting above idle), then how recently it was active. The
 * confidence says how well the best one matched and how far ahead of the next it is. Under the threshold, or with the
 * next one too close, the decision is to ask the owner. A title said exactly routes to it whatever the scores.
 */
import type { SessionStatus } from "@grenade/protocol";

// Each weight is more than everything below it together, so one word in a title outranks any summary, status and
// recency, and so on down.
export const TITLE_WEIGHT = 8;
export const SUMMARY_WEIGHT = 4;
/** The folder's name and the session's own name count as the summary does: "the relay one" means the session in grenade-relay. */
export const NAME_WEIGHT = SUMMARY_WEIGHT;
/** What the session last said or was asked. */
export const RECENT_WORDS_WEIGHT = SUMMARY_WEIGHT;
export const ACTIVE_WEIGHT = 2;
/** The most recency adds: for a session whose status changed this moment, fading to nothing over `RECENCY_WINDOW_MS`. */
export const RECENCY_WEIGHT = 1;
export const RECENCY_WINDOW_MS = 60 * 60 * 1000;

/** Under this the owner is asked. */
export const THRESHOLD = 0.6;
/** The next candidate within this share of the best one's score is a tie. */
export const TIE_MARGIN = 0.1;
/** How the confidence is made up: the lead over the next candidate that matched, and how strongly the best matched. */
export const LEAD_SHARE = 0.6;
export const STRENGTH_SHARE = 0.4;
/** How many candidates a question names. */
export const NAMED = 3;

/** Words that say nothing about which session is meant. */
export const STOP_WORDS: ReadonlySet<string> = new Set([
  "a", "an", "the", "one", "ones", "session", "sessions", "agent", "to", "of", "in", "on", "at", "for", "with", "about",
  "my", "that", "this", "it", "is", "and", "or", "please", "tell", "ask", "send", "say", "check", "read", "what", "how",
  "thing", "project", "status",
]);

/** What routing may lead to. Nothing else: not starting a session, not answering a permission, question or plan. */
export const ROUTE_ACTIONS = ["status", "read", "prompt"] as const;
export type RouteAction = (typeof ROUTE_ACTIONS)[number];

export function isRouteAction(value: unknown): value is RouteAction {
  return typeof value === "string" && (ROUTE_ACTIONS as readonly string[]).includes(value);
}

export interface Candidate {
  /** The session's id. */
  key: string;
  handle: string;
  /** The session's heading: what the owner reads and says. */
  title: string;
  name: string;
  folder: string;
  summary?: string | undefined;
  status: SessionStatus;
  /** When the status last changed, in ms. */
  statusSince: number;
  recentWords?: string | undefined;
}

export interface Scored {
  candidate: Candidate;
  score: number;
  /** The part of the score that came from the intent's words. */
  words: number;
}

export type Outcome = { route: Candidate } | { confirm: string };

export interface Decision {
  outcome: Outcome;
  /** 0 to 1. */
  confidence: number;
  /** Best first. */
  ranked: Scored[];
}

/** The candidates a question names, best first. */
export function askAbout(decision: Decision): Candidate[] {
  return decision.ranked.slice(0, NAMED).map((s) => s.candidate);
}

export function decide(intent: string, explicitTitle: string | undefined, action: RouteAction, candidates: readonly Candidate[], now: number): Decision {
  // A prompt cannot go to a session that has ended.
  const live = candidates.filter((c) => action !== "prompt" || c.status !== "gone");
  const words = keywords(intent);
  const ranked = live.map((c) => score(c, words, now)).sort((a, b) => (a.score !== b.score ? b.score - a.score : a.candidate.key < b.candidate.key ? -1 : a.candidate.key > b.candidate.key ? 1 : 0));

  const said = explicitTitle?.trim();
  if (said) {
    const exact = live.filter((c) => same(c.title, said) || same(c.name, said));
    if (exact.length === 1) return { outcome: { route: exact[0]! }, confidence: 1, ranked };
    if (exact.length === 0) return { outcome: { confirm: `No session is called ${said}.` }, confidence: 0, ranked };
    return { outcome: { confirm: `Several sessions are called ${said}.` }, confidence: 0, ranked };
  }

  const best = ranked[0];
  if (!best || best.words <= 0) return { outcome: { confirm: "Nothing in the request matched a session." }, confidence: 0, ranked };
  // Only a candidate the words also matched contests the best one: a busy session nobody named does not.
  const next = ranked.slice(1).find((s) => s.words > 0);
  const lead = next ? (best.score - next.score) / best.score : 1;
  const strength = Math.min(1, best.words / TITLE_WEIGHT);
  const confidence = clamp(LEAD_SHARE * lead + STRENGTH_SHARE * strength);
  if (next && lead < TIE_MARGIN) {
    return { outcome: { confirm: `${best.candidate.title} and ${next.candidate.title} match about equally.` }, confidence, ranked };
  }
  if (confidence < THRESHOLD) return { outcome: { confirm: "The match is not sure enough." }, confidence, ranked };
  return { outcome: { route: best.candidate }, confidence, ranked };
}

/** One candidate's score. A word counts once, where it weighs most. */
export function score(candidate: Candidate, keywords: readonly string[], now: number): Scored {
  const title = new Set(words(candidate.title));
  const names = new Set([...words(candidate.name), ...words(candidate.folder)]);
  const summary = new Set(words(candidate.summary ?? ""));
  const recent = new Set(words(candidate.recentWords ?? ""));
  let matched = 0;
  for (const keyword of keywords) {
    if (title.has(keyword)) matched += TITLE_WEIGHT;
    else if (summary.has(keyword)) matched += SUMMARY_WEIGHT;
    else if (names.has(keyword)) matched += NAME_WEIGHT;
    else if (recent.has(keyword)) matched += RECENT_WORDS_WEIGHT;
  }
  const active = candidate.status === "working" || candidate.status === "waiting" ? ACTIVE_WEIGHT : 0;
  const age = Math.max(0, now - candidate.statusSince);
  const recency = RECENCY_WEIGHT * Math.max(0, 1 - age / RECENCY_WINDOW_MS);
  return { candidate, score: matched + active + recency, words: matched };
}

/** The intent's words that can tell sessions apart: lowercased, whole words, no stop words, each once. */
export function keywords(intent: string): string[] {
  const seen = new Set<string>();
  return words(intent).filter((w) => {
    if (STOP_WORDS.has(w) || seen.has(w)) return false;
    seen.add(w);
    return true;
  });
}

/** Lowercased runs of letters and digits: "grenade-relay" is "grenade" and "relay". */
export function words(text: string): string[] {
  return text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 0);
}

/** Equal ignoring case, accents and the spaces around them. */
function same(a: string, b: string): boolean {
  return a.trim().localeCompare(b.trim(), undefined, { sensitivity: "base" }) === 0;
}

function clamp(value: number): number {
  return Math.min(Math.max(value, 0), 1);
}
