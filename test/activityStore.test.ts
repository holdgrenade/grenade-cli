import { describe, expect, it } from "vitest";
import { ACTIVITY_KEEP, type ActivityEntry, type ActivityFrame } from "@grenade/protocol";
import { ActivityStore } from "../src/activity/activityStore.js";

const at = "2026-09-30T14:02:10.000Z";
const asked = (text: string, when = at): ActivityEntry => ({ kind: "asked", text, at: when });
const said = (text: string, when = at): ActivityEntry => ({ kind: "said", text, at: when });

function store() {
  const s = new ActivityStore();
  const frames: ActivityFrame[] = [];
  s.on("activity", (f) => frames.push(f));
  return { s, frames };
}

const stopped = (when = at): ActivityEntry => ({ kind: "stopped", text: "Stopped", at: when });

describe("ActivityStore", () => {
  it("puts in a stop the screen saw at once, once, and not the transcript's copy of it", () => {
    const { s, frames } = store();
    s.append("gr-a", [asked("go")]);
    s.noteStopped("gr-a", "2026-09-30T14:02:12.000Z");
    s.noteStopped("gr-a", "2026-09-30T14:02:13.000Z");
    expect(s.entriesOf("gr-a").map((e) => e.kind)).toEqual(["asked", "stopped"]);
    expect(frames.at(-1)).toEqual({ type: "activity", sessionId: "gr-a", entries: [stopped("2026-09-30T14:02:12.000Z")] });
    // The transcript's own line turns up late, with the next prompt.
    s.append("gr-a", [stopped(), asked("again")]);
    expect(s.entriesOf("gr-a").map((e) => e.kind)).toEqual(["asked", "stopped", "asked"]);
    expect(frames.at(-1)!.entries.map((e) => e.kind)).toEqual(["asked"]);
    // A later stop is a new one.
    s.append("gr-a", [stopped()]);
    expect(s.entriesOf("gr-a").map((e) => e.kind)).toEqual(["asked", "stopped", "asked", "stopped"]);
  });

  it("appends in order and sends each batch as one frame", () => {
    const { s, frames } = store();
    s.append("gr-a", [asked("fix it"), said("On it.")]);
    s.append("gr-a", [said("Done.")]);
    s.append("gr-a", []);
    expect(s.entriesOf("gr-a").map((e) => e.text)).toEqual(["fix it", "On it.", "Done."]);
    expect(frames).toHaveLength(2);
    expect(frames[1]).toEqual({ type: "activity", sessionId: "gr-a", entries: [said("Done.")] });
    expect(s.entriesOf("gr-b")).toEqual([]);
  });

  it("shows a hook's prompt at once and does not send the transcript's copy again", () => {
    const { s, frames } = store();
    s.append("gr-a", [said("Earlier.")]);
    s.noteAsked("gr-a", "  fix it \n", "2026-09-30T14:03:00.000Z");
    expect(s.entriesOf("gr-a").at(-1)).toEqual(asked("fix it", "2026-09-30T14:03:00.000Z"));
    expect(frames.at(-1)?.entries).toEqual([asked("fix it", "2026-09-30T14:03:00.000Z")]);
    // The transcript records the prompt with its own time, then the reply: the phone gets only the reply.
    s.append("gr-a", [asked("fix it", "2026-09-30T14:03:01.000Z"), said("On it.")]);
    expect(s.entriesOf("gr-a")).toEqual([said("Earlier."), asked("fix it", "2026-09-30T14:03:00.000Z"), said("On it.")]);
    expect(frames.at(-1)).toEqual({ type: "activity", sessionId: "gr-a", entries: [said("On it.")] });
    expect(frames).toHaveLength(3);
  });

  it("sends nothing when the transcript's copy is all the read brought", () => {
    const { s, frames } = store();
    s.noteAsked("gr-a", "fix it", at);
    s.append("gr-a", [asked("fix it", "2026-09-30T14:03:01.000Z")]);
    expect(frames).toHaveLength(1);
    expect(s.entriesOf("gr-a")).toEqual([asked("fix it", at)]);
  });

  it("puts a prompt noted before a restart's full read where the transcript has it, and sends it all again", () => {
    const { s, frames } = store();
    s.noteAsked("gr-a", "again", at);
    s.append("gr-a", [asked("first"), said("One."), asked("again"), said("Two.")]);
    expect(s.entriesOf("gr-a").map((e) => e.text)).toEqual(["first", "One.", "again", "Two."]);
    expect(frames.at(-1)).toEqual({ type: "activity", sessionId: "gr-a", entries: s.entriesOf("gr-a"), full: true });
  });

  it("sends it all again when the read also brought the reply the last read missed", () => {
    const { s, frames } = store();
    s.append("gr-a", [asked("first")]);
    s.noteAsked("gr-a", "again", at);
    s.append("gr-a", [said("One."), asked("again"), said("Two.")]);
    expect(s.entriesOf("gr-a").map((e) => e.text)).toEqual(["first", "One.", "again", "Two."]);
    expect(frames.at(-1)?.full).toBe(true);
  });

  it("keeps a repeated prompt when the transcript repeats it too", () => {
    const { s } = store();
    s.noteAsked("gr-a", "continue", at);
    s.append("gr-a", [asked("continue")]);
    s.noteAsked("gr-a", "continue", at);
    s.append("gr-a", [asked("continue")]);
    expect(s.entriesOf("gr-a").map((e) => e.text)).toEqual(["continue", "continue"]);
  });

  it("ignores slash commands and text the user did not type", () => {
    const { s, frames } = store();
    s.noteAsked("gr-a", "/model", at);
    s.noteAsked("gr-a", "<command-name>/clear</command-name>", at);
    s.noteAsked("gr-a", "   ", at);
    expect(s.entriesOf("gr-a")).toEqual([]);
    expect(frames).toEqual([]);
  });

  it("keeps the last 200 entries and forgets a gone session", () => {
    const { s } = store();
    s.append("gr-a", Array.from({ length: ACTIVITY_KEEP + 5 }, (_, i) => said(`s${i}`)));
    expect(s.entriesOf("gr-a")).toHaveLength(ACTIVITY_KEEP);
    expect(s.entriesOf("gr-a")[0]?.text).toBe("s5");
    s.forget("gr-a");
    expect(s.entriesOf("gr-a")).toEqual([]);
  });
});
