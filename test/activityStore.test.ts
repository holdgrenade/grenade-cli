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

/** What a client holds after these frames: a `full` one replaces, the others append (the apps' `ActivityLog`). */
function shown(frames: ActivityFrame[]): string[] {
  let held: ActivityEntry[] = [];
  for (const f of frames) held = f.full ? f.entries : [...held, ...f.entries];
  return held.map((e) => `${e.kind}:${e.text}`);
}

describe("prompts that are pasted or sent while the agent works", () => {
  const pasted = '<pasted_content id="62cc">\nAdd topics\nfor the teams\n</pasted_content>';

  it("shows a pasted prompt at once, without its tags, and its transcript copy is not shown again", () => {
    const { s, frames } = store();
    s.append("gr-a", [said("Earlier.")]);
    s.noteAsked("gr-a", pasted, at);
    expect(frames.at(-1)?.entries).toEqual([asked("Add topics\nfor the teams")]);
    // The transcript's copy, read by the protocol's rule, has the same text.
    s.append("gr-a", [asked("Add topics\nfor the teams", "2026-09-30T14:02:11.000Z"), said("On it.")]);
    expect(shown(frames)).toEqual(["said:Earlier.", "asked:Add topics\nfor the teams", "said:On it."]);
    expect(s.entriesOf("gr-a").map((e) => e.text)).toEqual(["Earlier.", "Add topics\nfor the teams", "On it."]);
  });

  it("shows a prompt sent mid-turn once, where the transcript puts it", () => {
    const { s, frames } = store();
    s.append("gr-a", [asked("fix it"), said("Looking.")]);
    s.noteAsked("gr-a", "and the footer", at);
    s.append("gr-a", [said("Found it.")]);
    // Claude Code takes the prompt into the turn after the next tool call and writes it as a queued_command.
    s.append("gr-a", [asked("and the footer"), said("Footer too.")]);
    expect(shown(frames)).toEqual(["asked:fix it", "said:Looking.", "said:Found it.", "asked:and the footer", "said:Footer too."]);
    expect(shown(frames)).toEqual(s.entriesOf("gr-a").map((e) => `${e.kind}:${e.text}`));
  });

  it("shows each of two prompts sent mid-turn once", () => {
    const { s, frames } = store();
    s.append("gr-a", [asked("fix it")]);
    s.noteAsked("gr-a", "one", at);
    s.noteAsked("gr-a", pasted, at);
    expect(shown(frames)).toEqual(["asked:fix it", "asked:one", "asked:Add topics\nfor the teams"]);
    s.append("gr-a", [said("Working."), asked("one")]);
    s.append("gr-a", [said("Still."), asked("Add topics\nfor the teams"), said("Both done.")]);
    expect(shown(frames)).toEqual(["asked:fix it", "said:Working.", "asked:one", "said:Still.", "asked:Add topics\nfor the teams", "said:Both done."]);
    expect(shown(frames)).toEqual(s.entriesOf("gr-a").map((e) => `${e.kind}:${e.text}`));
  });

  it("keeps a hook prompt the transcript has not written yet last when a resumed session switches to its copy", () => {
    const { s, frames } = store();
    s.noteAsked("gr-a", "one", at);
    s.noteAsked("gr-a", "two", at);
    s.replace("gr-a", [said("History."), asked("one")]);
    expect(shown(frames)).toEqual(["said:History.", "asked:one", "asked:two"]);
    s.append("gr-a", [asked("two"), said("Done.")]);
    expect(shown(frames)).toEqual(["said:History.", "asked:one", "asked:two", "said:Done."]);
  });
});

describe("a prompt hook that arrives twice", () => {
  it("is one asked entry, and a prompt typed again later is another", () => {
    const { s, frames } = store();
    s.noteAsked("gr-a", "fix it", at);
    s.noteAsked("gr-a", "fix it", at);
    expect(s.entriesOf("gr-a")).toEqual([asked("fix it")]);
    expect(frames).toHaveLength(1);
    s.append("gr-a", [asked("fix it"), said("done")]);
    s.noteAsked("gr-a", "fix it", at);
    expect(s.entriesOf("gr-a").map((e) => e.kind)).toEqual(["asked", "said", "asked"]);
  });
});
