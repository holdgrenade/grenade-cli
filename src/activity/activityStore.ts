/**
 * The activity of every session (PROTOCOL.md "Activity"): what the agent said and was asked, the last 200 entries
 * each, and the `activity` frames that carry new ones to subscribed phones.
 */
import { EventEmitter } from "node:events";
import { ACTIVITY_KEEP, activityText, type ActivityEntry, type ActivityFrame } from "@grenade/protocol";

export interface ActivityEvents {
  /** New entries of one session, in order. */
  activity: [frame: ActivityFrame];
}

interface Track {
  entries: ActivityEntry[];
  /**
   * The prompt a `UserPromptSubmit` hook put in before the transcript recorded it. When the transcript's copy
   * arrives the hook's entry gives way to it, so the entry sits where the transcript has it.
   */
  pending: ActivityEntry | null;
}

export class ActivityStore extends EventEmitter<ActivityEvents> {
  private readonly tracks = new Map<string, Track>();

  /** Everything held for a session, oldest first. */
  entriesOf(id: string): ActivityEntry[] {
    return this.tracks.get(id)?.entries ?? [];
  }

  /** The entries the transcript yielded since the last read, in order. */
  append(id: string, entries: ActivityEntry[]): void {
    if (entries.length === 0) return;
    const t = this.track(id);
    if (t.pending && entries.some((e) => e.kind === "asked" && e.text === t.pending?.text)) {
      t.entries = t.entries.filter((e) => e !== t.pending);
      t.pending = null;
    }
    t.entries = [...t.entries, ...entries].slice(-ACTIVITY_KEEP);
    this.emit("activity", { type: "activity", sessionId: id, entries });
  }

  /** The prompt of a `UserPromptSubmit` hook: shown at once, before the transcript has it. */
  noteAsked(id: string, prompt: string, at: string): void {
    const text = prompt.trim();
    // A slash command, or something Claude Code wrote for the agent, is not the user talking.
    if (!text || text.startsWith("/") || text.startsWith("<")) return;
    const entry: ActivityEntry = { kind: "asked", text: activityText(text), at };
    const t = this.track(id);
    t.pending = entry;
    t.entries = [...t.entries, entry].slice(-ACTIVITY_KEEP);
    this.emit("activity", { type: "activity", sessionId: id, entries: [entry] });
  }

  /** The session is gone. */
  forget(id: string): void {
    this.tracks.delete(id);
  }

  private track(id: string): Track {
    let t = this.tracks.get(id);
    if (!t) {
      t = { entries: [], pending: null };
      this.tracks.set(id, t);
    }
    return t;
  }
}
