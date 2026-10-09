/** Pure: the cut of a showreel as a video, the day's words, which boards the video needs, and the page that draws it. */
import { describe, expect, it } from "vitest";
import type { ShowreelFrame } from "@grenade/protocol";
import { boardsWanted, siblingsOf } from "../src/showreel/render/renderVideo.js";
import { videoPageHtml } from "../src/showreel/render/videoPage.js";
import { CHAPTER_MS, CLOSE_MS, OPEN_MS, SENTENCE_MS, WALL_MS, clipAssets, videoDay, videoTimeline, type VideoAsset } from "../src/showreel/render/videoTimeline.js";

const frame: ShowreelFrame = {
  type: "showreel",
  date: "2026-10-09",
  version: 3,
  opening: "Changes from the phone, and a Mac app that installs itself.",
  pieces: [
    { title: "Changes, from the phone", line: "What a session changed, and Push.", parts: [{ board: { cwd: "/p", file: "R10C · Drawer.html" }, clips: ["c-aaaa1111"], done: { kind: "push", text: "Pushed 2 commits to origin/main", at: "2026-10-09T15:31:00Z" } }] },
    { title: "The Mac app", parts: [{ title: "Installs itself", clips: ["c-bbbb2222"] }, { title: "Composer grows", before: "c-cccc3333", clips: ["c-dddd4444"] }] },
    { title: "Nothing here", parts: [{ clips: ["c-gone0000"] }] },
  ],
  clips: [
    { id: "c-aaaa1111", kind: "video", title: "Changes, from the phone", at: "2026-10-09T15:28:40Z", mime: "video/mp4", bytes: 10, seconds: 8 },
    { id: "c-bbbb2222", kind: "still", title: "Installs itself", at: "2026-10-09T15:10:33Z", mime: "image/png", bytes: 10 },
    { id: "c-cccc3333", kind: "still", title: "Composer grows", before: true, at: "2026-10-09T16:40:02Z", mime: "image/png", bytes: 10 },
    { id: "c-dddd4444", kind: "video", title: "Composer grows", at: "2026-10-09T16:52:11Z", mime: "video/mp4", bytes: 10, seconds: 6 },
  ],
};
const boardFiles = ["R10A · Switch.html", "R10B · Tab.html", "R10C · Drawer.html", "R13B · Moves itself.html"];
const assets: VideoAsset[] = [...clipAssets(frame.clips, (c) => `file:///clips/${c.id}`), ...boardFiles.map((f, i) => ({ id: `b-${i}`, url: `file:///boards/${i}.png`, kind: "board" as const, title: f }))];
const boardAsset = (file: string) => { const i = boardFiles.indexOf(file); return i < 0 ? undefined : `b-${i}`; };

describe("videoTimeline", () => {
  it("opens, says the sentence, flies the wall, a chapter per part, and closes, on the half-second grid", () => {
    const t = videoTimeline({ frame, assets, boardAsset, siblingsOf: (f) => siblingsOf(f, boardFiles), day: "Friday 9 October" });
    expect(t.scenes.map((s) => s.kind)).toEqual(["open", "sentence", "wall", "chapter", "chapter", "chapter", "close"]);
    expect(t.scenes[0]).toMatchObject({ from: 0, to: OPEN_MS, day: "Friday 9 October" });
    expect(t.scenes[1]).toMatchObject({ from: OPEN_MS, to: OPEN_MS + SENTENCE_MS, text: frame.opening });
    expect(t.scenes[2]).toMatchObject({ kind: "wall", assets: assets.map((a) => a.id), word: "Today." });
    const first = t.scenes[3]!;
    expect(first).toMatchObject({ kind: "chapter", title: "Changes, from the phone", line: "What a session changed, and Push.", boards: ["b-0", "b-1", "b-2"], chosen: "b-2", clip: "c-aaaa1111", done: "Pushed 2 commits to origin/main" });
    expect(first.to - first.from).toBe(CHAPTER_MS);
    // A bucket's parts are chapters of their own, titled by the part; a before rides beside its clip.
    expect(t.scenes[4]).toMatchObject({ title: "Installs itself", clip: "c-bbbb2222", boards: [] });
    expect(t.scenes[5]).toMatchObject({ title: "Composer grows", before: "c-cccc3333", clip: "c-dddd4444" });
    // A part whose clip the assets lack plays nothing; the montage needs four pictures left over, and none are.
    expect(t.scenes.at(-1)).toMatchObject({ kind: "close", day: "Friday 9 October" });
    expect(t.duration).toBe(OPEN_MS + SENTENCE_MS + WALL_MS + 3 * CHAPTER_MS + CLOSE_MS);
    expect(t.duration % 500).toBe(0);
  });

  it("skips the sentence and the wall when there is nothing for them", () => {
    const t = videoTimeline({ frame: { ...frame, opening: undefined, pieces: [frame.pieces[1]!] }, assets: assets.filter((a) => a.kind !== "board").slice(1, 2), boardAsset: () => undefined, siblingsOf: () => [], day: "Friday 9 October" });
    expect(t.scenes.map((s) => s.kind)).toEqual(["open", "wall", "chapter", "close"]);
  });

  it("writes the day in words and finds a board's revision siblings", () => {
    expect(videoDay("2026-10-09")).toBe("Friday 9 October");
    expect(videoDay("2026-10-09", "en-US")).toBe("Friday, October 9");
    expect(siblingsOf("R10C · Drawer.html", boardFiles)).toEqual(["R10A · Switch.html", "R10B · Tab.html"]);
    expect(siblingsOf("Notes.html", boardFiles)).toEqual([]);
  });

  it("wants the named boards and their revisions first, then the rest of the day, capped", () => {
    const boards = boardFiles.map((file) => ({ cwd: "/p", file, title: file, modified: "2026-10-09T10:00:00Z" }));
    expect(boardsWanted(frame, boards, 10).map((b) => b.file)).toEqual(["R10A · Switch.html", "R10B · Tab.html", "R10C · Drawer.html", "R13B · Moves itself.html"]);
    expect(boardsWanted(frame, boards, 2).map((b) => b.file)).toEqual(["R10A · Switch.html", "R10B · Tab.html"]);
  });

  it("writes one page that draws any instant and carries every asset", () => {
    const t = videoTimeline({ frame, assets, boardAsset, siblingsOf: (f) => siblingsOf(f, boardFiles), day: "Friday 9 October" });
    const html = videoPageHtml({ timeline: t, assets, width: 1920, height: 1080 });
    expect(html).toContain("window.__showreel = { seek, ready, duration: D.timeline.duration }");
    expect(html).toContain("file:///clips/c-aaaa1111");
    expect(html).toContain("file:///boards/2.png");
    expect(html).toContain("Changes from the phone, and a Mac app that installs itself.");
    expect(html).not.toContain("<script src=");
  });
});
