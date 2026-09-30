/**
 * The activity of every session (PROTOCOL.md "Activity"): what the agent said and was asked, the last 200 entries
 * each, and the `activity` frames that carry new ones to subscribed phones.
 */
import { EventEmitter } from "node:events";
import { ACTIVITY_KEEP, activityText, type ActivityEntry, type ActivityFrame } from "@grenade/protocol";

export interface ActivityEvents {
  /** New entries of one session, in order; or, with `full`, everything held, when the order the phone has is wrong. */
  activity: [frame: ActivityFrame];
}

interface Track {
  entries: ActivityEntry[];
  /**
   * The prompt a `UserPromptSubmit` hook put in before the transcript recorded it. The transcript's copy of it is
   * not sent again: the phone already shows the hook's entry, and showed it twice before this was so.
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
    const pending = t.pending;
    const copy = pending ? entries.findIndex((e) => e.kind === "asked" && e.text === pending.text) : -1;
    if (!pending || copy < 0) {
      t.entries = [...t.entries, ...entries].slice(-ACTIVITY_KEEP);
      this.emit("activity", { type: "activity", sessionId: id, entries });
      return;
    }
    t.pending = null;
    if (t.entries.at(-1) === pending && copy === 0) {
      // The usual case: the hook's entry is the newest one and the transcript's copy leads the batch, so the
      // hook's entry stays and only what follows the copy is new.
      const rest = entries.slice(1);
      t.entries = [...t.entries, ...rest].slice(-ACTIVITY_KEEP);
      if (rest.length > 0) this.emit("activity", { type: "activity", sessionId: id, entries: rest });
      return;
    }
    // The transcript has the prompt elsewhere (a read from the start after a restart, or lines the last read
    // missed): take the transcript's order, and send it whole so the phone shows the same.
    t.entries = [...t.entries.filter((e) => e !== pending), ...entries].slice(-ACTIVITY_KEEP);
    this.emit("activity", { type: "activity", sessionId: id, entries: t.entries, full: true });
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
