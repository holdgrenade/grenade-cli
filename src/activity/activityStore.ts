/**
 * The activity of every session (PROTOCOL.md "Activity"): what the agent said and was asked, the last 200 entries
 * each, and the `activity` frames that carry new ones to subscribed phones.
 */
import { EventEmitter } from "node:events";
import { ACTIVITY_KEEP, STOPPED_TEXT, activityText, typedPromptText, type ActivityEntry, type ActivityFrame } from "@grenade/protocol";

/**
 * How many hook prompts may wait for the transcript's copy at once: prompts sent while the agent works each wait
 * until Claude Code takes them into the turn.
 */
export const PENDING_KEEP = 8;

/** The `text` of an `errored` entry when no message is available. */
export const ERRORED_TEXT = "An error occurred.";

export interface ActivityEvents {
  /** New entries of one session, in order; or, with `full`, everything held, when the order the phone has is wrong. */
  activity: [frame: ActivityFrame];
}

interface Track {
  entries: ActivityEntry[];
  /**
   * The prompts `UserPromptSubmit` hooks put in before the transcript recorded them, oldest first. The transcript's
   * copy of each is not sent again: the phone already shows the hook's entry, and showed it twice before this was so.
   * Several wait when prompts are sent while the agent works.
   */
  pending: ActivityEntry[];
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
    const copied = takeCopies(t, entries);
    if (copied.length === 0) {
      t.entries = [...t.entries, ...entries].slice(-ACTIVITY_KEEP);
      this.emit("activity", { type: "activity", sessionId: id, entries });
      return;
    }
    const lead = entries[0];
    if (copied.length === 1 && t.entries.at(-1) === copied[0] && lead?.kind === "asked" && lead.text === copied[0]?.text) {
      // The usual case: the hook's entry is the newest one and the transcript's copy leads the batch, so the
      // hook's entry stays and only what follows the copy is new.
      const rest = entries.slice(1);
      t.entries = [...t.entries, ...rest].slice(-ACTIVITY_KEEP);
      if (rest.length > 0) this.emit("activity", { type: "activity", sessionId: id, entries: rest });
      return;
    }
    // The transcript has a prompt elsewhere (a prompt sent while the agent worked, which it took into the turn later;
    // a read from the start after a restart; lines the last read missed): take the transcript's order, and send it
    // whole so the phone shows the same.
    t.entries = [...t.entries.filter((e) => !copied.includes(e)), ...entries].slice(-ACTIVITY_KEEP);
    this.emit("activity", { type: "activity", sessionId: id, entries: t.entries, full: true });
  }

  /**
   * Everything a session's transcript holds, in place of what the store has: a resumed session moving from the
   * original conversation to its copy (PROTOCOL.md "Conversations"), whose first read repeats the history. A hook's
   * prompt the transcript does not have yet stays last. Always sent as a `full` frame.
   */
  replace(id: string, entries: ActivityEntry[]): void {
    const t = this.track(id);
    takeCopies(t, entries);
    t.pendingStop = null;
    t.entries = [...entries, ...t.pending].slice(-ACTIVITY_KEEP);
    this.emit("activity", { type: "activity", sessionId: id, entries: t.entries, full: true });
  }

  /** The prompt of a `UserPromptSubmit` hook: shown at once, before the transcript has it. */
  noteAsked(id: string, prompt: string, at: string): void {
    // Read as the transcript reads it (a pasted prompt without its tags), so its copy there is known as the same.
    const text = typedPromptText(prompt);
    // A slash command, or something Claude Code wrote for the agent, is not the user talking.
    if (!text || text.startsWith("/")) return;
    const entry: ActivityEntry = { kind: "asked", text: activityText(text), at };
    const t = this.track(id);
    // The same hook from two places (the launch flags and an older copy in settings.json) is one prompt.
    const last = t.entries.at(-1);
    if (last && t.pending.includes(last) && last.text === entry.text) return;
    t.pending = [...t.pending.filter((e) => t.entries.includes(e)), entry].slice(-PENDING_KEEP);
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

  /** A push of the session's branch, or one that failed (PROTOCOL.md "Changes", "The push card"): a card at once. */
  notePush(id: string, entry: ActivityEntry): void {
    const t = this.track(id);
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
      t = { entries: [], pending: [], pendingStop: null };
      this.tracks.set(id, t);
    }
    return t;
  }
}

/**
 * The hook entries whose copies `entries` holds, each `asked` copy matched to the oldest waiting entry with its text;
 * they wait no longer.
 */
function takeCopies(t: Track, entries: readonly ActivityEntry[]): ActivityEntry[] {
  const copied: ActivityEntry[] = [];
  for (const e of entries) {
    if (e.kind !== "asked") continue;
    const match = t.pending.find((p) => p.text === e.text && !copied.includes(p));
    if (match) copied.push(match);
  }
  t.pending = t.pending.filter((p) => !copied.includes(p));
  return copied;
}
