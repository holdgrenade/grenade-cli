/**
 * The activity of every session (PROTOCOL.md "Activity"): what the agent said and was asked, the last 200 entries
 * each, and the `activity` frames that carry new ones to subscribed phones.
 */
import { EventEmitter } from "node:events";
import { ACTIVITY_KEEP, STOPPED_TEXT, activityText, type ActivityEntry, type ActivityFrame } from "@grenade/protocol";

/** The `text` of an `errored` entry when no message is available. */
export const ERRORED_TEXT = "An error occurred.";

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
  /** A `stopped` entry put in from the screen (`noteStopped`): the transcript's own, if it comes, is not sent again. */
  pendingStop: ActivityEntry | null;
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
    if (t.pendingStop) {
      t.pendingStop = null;
      const copy = entries.findIndex((e) => e.kind === "stopped");
      if (copy >= 0) entries = entries.filter((_, i) => i !== copy);
      if (entries.length === 0) return;
    }
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

  /**
   * The user stopped the agent and the screen shows it at its prompt, but the transcript has no line for it (a prompt
   * stopped before the agent wrote anything is taken back without one): the `stopped` entry, at once.
   */
  noteStopped(id: string, at: string): void {
    const entry: ActivityEntry = { kind: "stopped", text: STOPPED_TEXT, at };
    const t = this.track(id);
    if (t.entries.at(-1)?.kind === "stopped") return;
    t.pendingStop = entry;
    t.entries = [...t.entries, entry].slice(-ACTIVITY_KEEP);
    this.emit("activity", { type: "activity", sessionId: id, entries: [entry] });
  }

  /** The agent stopped with an error: shown at once as an `errored` card. */
  noteErrored(id: string, message: string, at: string): void {
    const text = activityText(message.trim() || ERRORED_TEXT);
    const entry: ActivityEntry = { kind: "errored", text, at };
    const t = this.track(id);
    if (t.entries.at(-1)?.kind === "errored") return;
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
      t = { entries: [], pending: null, pendingStop: null };
      this.tracks.set(id, t);
    }
    return t;
  }
}
