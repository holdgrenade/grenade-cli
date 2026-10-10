import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ActivityEntry, HighlightTile } from "@grenade/protocol";
import { gatherHighlights, shippedTiles } from "../src/highlights/gatherHighlights.js";
import { highlightIdOf } from "../src/highlights/highlightId.js";
import { captionFor, entriesInTurn, firstLine, isApproach, wordsOf } from "../src/highlights/highlightWords.js";
import { PictureStore, findResizer } from "../src/highlights/pictureStore.js";
import { picturesIn, screenshotWrittenBy } from "../src/highlights/transcriptPictures.js";
import { entriesIn, TalkThread } from "../src/talk/talkThread.js";

const line = (o: object) => JSON.stringify(o);
const at = (m: number) => `2026-10-09T16:${String(m).padStart(2, "0")}:00.000Z`;

describe("transcriptPictures", () => {
  it("finds a picture the agent read, a screenshot a command wrote and an image a tool showed it, in the window only", () => {
    const jsonl = [
      line({ type: "assistant", timestamp: at(1), message: { content: [{ type: "tool_use", name: "Read", input: { file_path: "/tmp/before.png" } }] } }),
      line({ type: "assistant", timestamp: at(5), message: { content: [{ type: "tool_use", name: "Read", input: { file_path: "/tmp/shot.png" } }] } }),
      line({ type: "assistant", timestamp: at(6), message: { content: [{ type: "tool_use", name: "Read", input: { file_path: "/tmp/notes.md" } }] } }),
      line({ type: "assistant", timestamp: at(7), message: { content: [{ type: "tool_use", name: "Bash", input: { command: "screencapture -x -R 0,0,800,600 /tmp/win.png && ls" } }] } }),
      line({ type: "assistant", timestamp: at(8), message: { content: [{ type: "tool_use", name: "Bash", input: { command: 'xcrun simctl io booted screenshot "/tmp/sim shot.png"' } }] } }),
      line({ type: "user", timestamp: at(9), message: { content: [{ type: "tool_result", content: [{ type: "text", text: "Captured" }, { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "/9j/4AAQ" } }] }] } }),
      line({ type: "assistant", timestamp: at(10), message: { content: [{ type: "tool_use", name: "Read", input: { file_path: "/tmp/shot.png" } }] } }),
      "not json",
      line({ type: "assistant", timestamp: at(30), message: { content: [{ type: "tool_use", name: "Read", input: { file_path: "/tmp/after.png" } }] } }),
    ].join("\n");
    const found = picturesIn(jsonl, at(4), at(20));
    expect(found).toEqual([
      { kind: "path", path: "/tmp/shot.png", at: at(5) },
      { kind: "path", path: "/tmp/win.png", at: at(7) },
      { kind: "path", path: "/tmp/sim shot.png", at: at(8) },
      { kind: "inline", mime: "image/jpeg", data: "/9j/4AAQ", at: at(9) },
    ]);
  });

  it("reads what a screenshot command writes, and nothing from other commands", () => {
    expect(screenshotWrittenBy("screencapture -x out.png")).toBe("out.png");
    expect(screenshotWrittenBy("xcrun simctl io booted screenshot /tmp/a.png")).toBe("/tmp/a.png");
    expect(screenshotWrittenBy("xcrun simctl list devices")).toBeNull();
    expect(screenshotWrittenBy("ls -la *.png")).toBeNull();
    expect(screenshotWrittenBy("sips -Z 640 in.png --out small.png")).toBeNull();
  });
});

describe("highlightWords", () => {
  const turn: ActivityEntry[] = [
    { kind: "asked", text: "Right-click the shelf: hide until needed, turn off, settings.", at: at(2) },
    { kind: "said", text: "I'll draw three ways first, then build the one you pick.", at: at(4) },
    { kind: "said", text: "Here are the three boards.", at: at(21) },
    { kind: "asked", text: "A. Build it; the toast for four seconds.", at: at(30) },
    { kind: "said", text: "The toast names the key that brings the shelf back.", at: at(44) },
    { kind: "said", text: "Done. Pushed to origin/main.", at: at(52) },
  ];

  it("picks the ask, the approach, the choice after a board and the result", () => {
    expect(wordsOf(turn, [at(21)]).map((w) => [w.kind, w.text])).toEqual([
      ["asked", "Right-click the shelf: hide until needed, turn off, settings."],
      ["said", "I'll draw three ways first, then build the one you pick."],
      ["chose", "A. Build it; the toast for four seconds."],
      ["said", "Done. Pushed to origin/main."],
    ]);
    // Without a board there is no choice, and a question back is not the approach.
    expect(wordsOf(turn, []).map((w) => w.kind)).toEqual(["asked", "said", "said"]);
    // Many prompts after the boards keep the first and the last two, and never push the result out.
    const long: ActivityEntry[] = [turn[0]!, turn[1]!, ...Array.from({ length: 8 }, (_, i): ActivityEntry => ({ kind: "asked", text: `Change ${i + 1}.`, at: at(22 + i) })), turn[5]!];
    const words = wordsOf(long, [at(21)]);
    expect(words.filter((w) => w.kind === "chose").map((w) => w.text)).toEqual(["Change 1.", "Change 7.", "Change 8."]);
    expect(words.at(-1)).toMatchObject({ kind: "said", text: "Done. Pushed to origin/main." });
    expect(isApproach("Which one?")).toBe(false);
    expect(isApproach("Sure.")).toBe(false);
  });

  it("captions a picture with the nearest sentence within ten minutes, later on a tie, else the name", () => {
    expect(captionFor(at(43), turn, "shot.png")).toBe("The toast names the key that brings the shelf back.");
    expect(captionFor(at(48), turn, "shot.png")).toBe("Done. Pushed to origin/main.");
    expect(captionFor("2026-10-09T18:30:00.000Z", turn, "shot.png")).toBe("shot.png");
    expect(firstLine("Fix this\nand that")).toBe("Fix this");
    expect(entriesInTurn(turn, at(20), at(45)).map((e) => e.at)).toEqual([at(21), at(30), at(44)]);
  });
});

describe("gatherHighlights", () => {
  const tile = (kind: string, m: number, extra: Partial<HighlightTile> = {}): HighlightTile => ({ id: highlightIdOf(`${kind}:${m}`), kind, at: at(m), caption: `${kind} ${m}`, ...extra });

  it("orders tiles by time with the push last, keeps the newest, and takes the words", () => {
    const found = [tile("screen", 44), tile("shipped", 52, { upstream: "origin/main", commits: [{ hash: "b095097", subject: "Shelf menu" }] }), tile("board", 21), tile("board", 23)];
    const turn: ActivityEntry[] = [{ kind: "asked", text: "Do it.", at: at(2) }, { kind: "said", text: "Done, and pushed to origin/main.", at: at(52) }];
    const h = gatherHighlights(found, turn)!;
    expect(h.tiles.map((t) => [t.kind, t.at])).toEqual([["board", at(21)], ["board", at(23)], ["screen", at(44)], ["shipped", at(52)]]);
    expect(h.words.map((w) => w.kind)).toEqual(["asked", "said"]);
    expect(gatherHighlights([], turn)).toBeNull();
    const many = Array.from({ length: 30 }, (_, i) => tile("screen", i));
    const capped = gatherHighlights([...many, tile("shipped", 59)], turn)!;
    expect(capped.tiles).toHaveLength(24);
    expect(capped.tiles[0]!.at).toBe(at(7));
    expect(capped.tiles.at(-1)!.kind).toBe("shipped");
  });

  it("makes a shipped tile from a push that pushed something, never from a failed one", () => {
    const turn: ActivityEntry[] = [
      { kind: "push", text: "Pushed 2 commits to origin/main", at: at(52), upstream: "origin/main", commits: [{ hash: "b095097", subject: "Shelf menu" }, { hash: "678a207", subject: "Menu bar" }] },
      { kind: "push", text: "Push failed (auth). Nothing was pushed.", at: at(53), upstream: "origin/main", failed: "auth" },
    ];
    const tiles = shippedTiles(turn, highlightIdOf);
    expect(tiles).toHaveLength(1);
    expect(tiles[0]).toMatchObject({ kind: "shipped", caption: "Pushed 2 commits to origin/main", upstream: "origin/main" });
    expect(tiles[0]!.commits).toHaveLength(2);
    expect(tiles[0]!.id).toMatch(/^h-[a-f0-9]{12}$/);
  });
});

describe("talkThread with highlights", () => {
  it("writes a changed row again under its id, and reads the newest line in the first one's place", () => {
    const dir = mkdtempSync(join(tmpdir(), "grenade-talk-"));
    const thread = new TalkThread(dir, () => new Date("2026-10-09T16:00:00.000Z"));
    const a = thread.append({ kind: "working", text: "Shelf", session: "gr-a", title: "Shelf" });
    const b = thread.append({ kind: "finished", text: "Done.", session: "gr-a", title: "Shelf" });
    thread.append({ kind: "you", id: "u-1", text: "Thanks" });
    const highlights = { tiles: [{ id: "h-0123456789ab", kind: "shipped", at: "2026-10-09T15:59:00.000Z", caption: "Pushed 1 commit to origin/main" }], words: [] };
    const updated = thread.update(b.id, (row) => ({ ...row, highlights }));
    expect(updated?.highlights).toEqual(highlights);
    expect(thread.update("t-9999", (row) => row)).toBeUndefined();
    const file = readFileSync(join(dir, "2026-10-09.jsonl"), "utf8");
    expect(file.split("\n").filter(Boolean)).toHaveLength(4);
    const rows = entriesIn(file);
    expect(rows.map((r) => r.id)).toEqual([a.id, b.id, "u-1"]);
    expect(rows[1]!.highlights).toEqual(highlights);
    const again = new TalkThread(dir, () => new Date("2026-10-09T17:00:00.000Z"));
    expect(again.find(b.id)?.highlights).toEqual(highlights);
    expect(again.entries()).toHaveLength(3);
  });
});

describe("pictureStore", () => {
  it("keeps nothing without a resizer, and finds one on a Mac or where ImageMagick is", async () => {
    expect(findResizer("linux", () => null)).toBeNull();
    expect(findResizer("linux", (c) => (c === "convert" ? "/usr/bin/convert" : null))).toEqual({ kind: "convert", bin: "/usr/bin/convert" });
    expect(findResizer("darwin", () => null)).toEqual({ kind: "sips" });
    const dir = mkdtempSync(join(tmpdir(), "grenade-highlights-"));
    const none = new PictureStore(dir, null);
    expect(none.canKeep).toBe(false);
    expect(await none.keepBytes(Buffer.from("x"), "gr-a", at(1))).toBeNull();
    expect(await none.read("h-0123456789ab")).toBeNull();
  });

  it.runIf(process.platform === "darwin")("keeps a copy as a JPEG with its size, once per content, reads it back, removes and prunes it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "grenade-highlights-"));
    // A 2×2 PNG.
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGP4z8DwHwyBNAAh9QT9+T7LjQAAAABJRU5ErkJggg==", "base64");
    const source = join(dir, "src.png");
    writeFileSync(source, png);
    let clock = new Date("2026-10-09T16:00:00.000Z");
    const store = new PictureStore(join(dir, "kept"), { kind: "sips" }, () => clock);
    const kept = await store.keepFile(source, "gr-a", at(1));
    expect(kept).toMatchObject({ mime: "image/jpeg", width: 2, height: 2 });
    expect(kept!.id).toMatch(/^h-[a-f0-9]{12}$/);
    expect(await store.keepBytes(png, "gr-b", at(2))).toMatchObject({ id: kept!.id });
    const read = await store.read(kept!.id);
    expect(read?.data.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
    expect(await store.prune(30)).toBe(0);
    clock = new Date("2026-11-20T16:00:00.000Z");
    expect(await store.prune(30)).toBe(1);
    expect(await store.read(kept!.id)).toBeNull();
    await store.remove(kept!.id);
  });
});
