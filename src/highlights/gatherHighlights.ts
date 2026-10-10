/**
 * What a turn's highlights are, from what was found (PROTOCOL.md "Highlights"): the tiles in the order they were made,
 * `shipped` after the pictures, the newest `HIGHLIGHT_TILES_MAX` kept, and the words. Pure; `HighlightsService` does
 * the finding.
 */
import { HIGHLIGHT_TILES_MAX, type ActivityEntry, type HighlightTile, type Highlights } from "@grenade/protocol";
import { wordsOf } from "./highlightWords.js";

/** Tiles found for a turn, in any order. */
export function gatherHighlights(found: readonly HighlightTile[], turn: readonly ActivityEntry[]): Highlights | null {
  const pictures = found.filter((t) => t.kind !== "shipped").sort(byTime);
  const shipped = found.filter((t) => t.kind === "shipped").sort(byTime);
  if (pictures.length === 0 && shipped.length === 0) return null;
  const room = Math.max(0, HIGHLIGHT_TILES_MAX - shipped.length);
  const tiles = [...pictures.slice(-room), ...shipped.slice(0, HIGHLIGHT_TILES_MAX)];
  const boardTimes = pictures.filter((t) => t.kind === "board").map((t) => t.at);
  return { tiles, words: wordsOf(turn, boardTimes) };
}

function byTime(a: HighlightTile, b: HighlightTile): number {
  return Date.parse(a.at) - Date.parse(b.at);
}

/** The push entries of the turn as `shipped` tiles: one per push that pushed something. */
export function shippedTiles(turn: readonly ActivityEntry[], idFor: (seed: string) => string): HighlightTile[] {
  return turn
    .filter((e) => e.kind === "push" && !e.failed && (e.commits?.length ?? 0) > 0)
    .map((e) => ({
      id: idFor(`push:${e.at}:${e.upstream ?? ""}`),
      kind: "shipped",
      at: e.at,
      caption: e.text.slice(0, 200),
      ...(e.upstream ? { upstream: e.upstream } : {}),
      ...(e.commits ? { commits: e.commits } : {}),
    }));
}
