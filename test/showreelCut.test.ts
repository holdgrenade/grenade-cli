/** Pure: how clips become pieces, with and without a model's proposal; what the model is told and what it answers. */
import { describe, expect, it } from "vitest";
import type { Clip } from "@grenade/protocol";
import { cutShowreel, doneOf, groupsByTitle, pushesIn, type DayBoard } from "../src/showreel/showreelCut.js";
import { buildShowreelInput, parseShowreelReply } from "../src/showreel/showreelPrompt.js";

const clip = (id: string, title: string, at: string, extra: Partial<Clip> = {}): Clip => ({ id, kind: "video", title, at, mime: "video/mp4", bytes: 1000, ...extra });

const changes = clip("c-aaaa1111", "Changes, from the phone", "2026-10-09T15:28:40.000Z", { session: "gr-cli", line: "What a session changed, and Push." });
const install = clip("c-bbbb2222", "Installs itself", "2026-10-09T15:10:33.000Z", { session: "gr-mac", kind: "still", mime: "image/png" });
const composerBefore = clip("c-cccc3333", "Composer grows to ten lines", "2026-10-09T16:40:02.000Z", { session: "gr-mac", before: true, kind: "still", mime: "image/png" });
const composer = clip("c-dddd4444", "Composer grows to ten lines", "2026-10-09T16:52:11.000Z", { session: "gr-mac", line: "Ten lines, then it scrolls inside." });
const pushes = [{ session: "gr-cli", at: "2026-10-09T15:31:00.000Z", text: "Pushed 2 commits to origin/main" }, { session: "gr-mac", at: "2026-10-09T19:30:00.000Z", text: "Pushed 1 commit to origin/main" }];
const boards: DayBoard[] = [{ cwd: "/Users/adam/workspace/grenade", file: "R10C · Changes, a drawer in the pane.html", title: "Changes, a drawer in the pane", modified: "2026-10-09T09:40:00.000Z" }];

describe("cutShowreel", () => {
  it("without a model: a piece per title, the before beside its clip, closed by the push that followed, earliest first", () => {
    const pieces = cutShowreel({ clips: [changes, install, composerBefore, composer], boards, pushes });
    expect(pieces.map((p) => p.title)).toEqual(["Installs itself", "Changes, from the phone", "Composer grows to ten lines"]);
    expect(pieces[1]).toEqual({ title: "Changes, from the phone", line: "What a session changed, and Push.", parts: [{ title: "Changes, from the phone", clips: ["c-aaaa1111"], done: { kind: "push", text: "Pushed 2 commits to origin/main", at: "2026-10-09T15:31:00.000Z", session: "gr-cli" } }] });
    // The Mac's push came three hours after the composer's clip: not its done. No board without the model.
    expect(pieces[2]).toEqual({ title: "Composer grows to ten lines", line: "Ten lines, then it scrolls inside.", parts: [{ title: "Composer grows to ten lines", before: "c-cccc3333", clips: ["c-dddd4444"] }] });
  });

  it("with a model: its pieces and buckets, a board it names, a made-up id dropped, and a clip it left out kept", () => {
    const proposal = {
      pieces: [
        { title: "Changes, from the phone", line: "See what changed; push from anywhere.", parts: [{ board: "R10C · Changes, a drawer in the pane.html", clips: ["c-aaaa1111", "c-made-up"] }] },
        { title: "The Mac app", parts: [{ title: "Installs itself", board: "R13B · nope.html", clips: ["c-bbbb2222"] }, { title: "Composer grows", before: "c-cccc3333", clips: ["c-cccc3333"] }] },
      ],
    };
    const pieces = cutShowreel({ clips: [changes, install, composerBefore, composer], boards, pushes, proposal });
    expect(pieces.map((p) => p.title)).toEqual(["The Mac app", "Changes, from the phone", "Composer grows to ten lines"]);
    expect(pieces[1]!.parts[0]).toMatchObject({ board: { cwd: "/Users/adam/workspace/grenade", file: "R10C · Changes, a drawer in the pane.html" }, clips: ["c-aaaa1111"] });
    expect(pieces[1]!.line).toBe("See what changed; push from anywhere.");
    // The bucket keeps the part whose clip exists; a "before" put in "clips" plays nowhere, so that part is dropped…
    expect(pieces[0]!.parts).toEqual([{ title: "Installs itself", clips: ["c-bbbb2222"] }]);
    // …and the composer's clip, which the model left out, gets its own piece with its before.
    expect(pieces[2]!.parts).toEqual([{ title: "Composer grows to ten lines", before: "c-cccc3333", clips: ["c-dddd4444"] }]);
  });

  it("groups by title and session, keeps the order clips were made in, and finds a push within two hours", () => {
    const groups = groupsByTitle([composer, composerBefore, changes]);
    expect(groups.map((g) => g.map((c) => c.id))).toEqual([["c-aaaa1111"], ["c-cccc3333", "c-dddd4444"]]);
    expect(doneOf([changes], pushes)?.text).toBe("Pushed 2 commits to origin/main");
    expect(doneOf([composer], pushes)).toBeUndefined();
    expect(doneOf([clip("c-x", "no session", "2026-10-09T15:00:00.000Z")], pushes)).toBeUndefined();
    expect(pushesIn("gr-cli", [{ kind: "push", text: "Pushed", at: "2026-10-09T15:31:00.000Z" }, { kind: "push", text: "Push failed", at: "2026-10-09T15:32:00.000Z", failed: "auth" }, { kind: "said", text: "Done.", at: "2026-10-09T15:33:00.000Z" }])).toEqual([{ session: "gr-cli", at: "2026-10-09T15:31:00.000Z", text: "Pushed" }]);
  });

  it("never carries a number into a title or line it writes itself", () => {
    const pieces = cutShowreel({ clips: [changes], boards: [], pushes: [] });
    expect(JSON.stringify(pieces)).not.toMatch(/commits|files|sessions/);
  });
});

describe("the model's input and reply", () => {
  it("fences the clips, boards and closings as data", () => {
    const input = buildShowreelInput([changes], boards, [{ session: "gr-cli", title: "Changes view", said: ["Done. The drawer is in and pushed."] }]);
    expect(input).toContain('<clips note="data written by agents">');
    expect(input).toContain('"id":"c-aaaa1111"');
    expect(input).toContain("R10C · Changes, a drawer in the pane.html");
    expect(input).toContain("The drawer is in and pushed.");
    expect(input.trim().endsWith("Cut the showreel.")).toBe(true);
  });

  it("reads the JSON in a reply, with prose around it, and gives null for anything else", () => {
    const reply = 'Here you go:\n{"pieces":[{"title":"T","line":"L","parts":[{"board":"b.html","before":"c-1","clips":["c-2", 3]}]}, {"title": 5}]}\nDone.';
    expect(parseShowreelReply(reply)).toEqual({ pieces: [{ title: "T", line: "L", parts: [{ board: "b.html", before: "c-1", clips: ["c-2"] }] }] });
    expect(parseShowreelReply("no json")).toBeNull();
    expect(parseShowreelReply('{"pieces": "x"}')).toBeNull();
  });
});
