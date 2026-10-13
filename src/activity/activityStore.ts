/**
 * The activity of every session (PROTOCOL.md "Activity"): what the agent said and was asked, the last 200 entries
 * each, the whole text of each entry that was cut at `ACTIVITY_TEXT_MAX` (under its `cut` id, for `activity.text`),
 * and the `activity` frames that carry new ones to subscribed phones.
 */
import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { ACTIVITY_KEEP, STOPPED_TEXT, cutEntry, typedPromptText, type ActivityEntry, type ActivityFrame } from "@grenade/protocol";

/**
 * How many hook prompts may wait for the transcript's copy at once: prompts sent while the agent works each wait
 * until Claude Code takes them into the turn.
 */
export const PENDING_KEEP = 8;

/** The `text` of an `errored` entry when no message is available. */
export const ERRORED_TEXT = "An error occurred.";

/** How many cut entries' whole texts a session keeps, newest first (PROTOCOL.md "Activity"): a few MB at most. */
export const WHOLE_TEXTS_KEEP = 64;

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
  /** The whole text of each cut entry under its `cut` id, oldest first; the newest `WHOLE_TEXTS_KEEP` only. */
  wholes: Map<string, string>;
}

export class ActivityStore extends EventEmitter<ActivityEvents> {
  private readonly tracks = new Map<string, Track>();

  /** Everything held for a session, oldest first. */
  entriesOf(id: string): ActivityEntry[] {
    return this.tracks.get(id)?.entries ?? [];
  }

  /** The whole text of the session's cut entry with that `cut` id, or null when the store no longer has it. */
  wholeText(id: string, cut: string): string | null {
    return this.tracks.get(id)?.wholes.get(cut) ?? null;
  }

  /** The entries the transcript yielded since the last read, in order, each text whole: cut here and kept. */
  append(id: string, entries: ActivityEntry[]): void {
    if (entries.length === 0) return;
    const t = this.track(id);
    entries = entries.map((e) => this.cut(t, e));
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
    entries = entries.map((e) => this.cut(t, e));
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
    const t = this.track(id);
    const entry = this.cut(t, { kind: "asked", text, at });
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
    const t = this.track(id);
    if (t.entries.at(-1)?.kind === "errored") return;
    const entry = this.cut(t, { kind: "errored", text: message.trim() || ERRORED_TEXT, at });
    t.entries = [...t.entries, entry].slice(-ACTIVITY_KEEP);
    this.emit("activity", { type: "activity", sessionId: id, entries: [entry] });
  }

  /** A push of the session's branch, or one that failed (PROTOCOL.md "Changes", "The push card"): a card at once. */
  notePush(id: string, entry: ActivityEntry): void {
    const t = this.track(id);
    t.entries = [...t.entries, entry].slice(-ACTIVITY_KEEP);
    this.emit("activity", { type: "activity", sessionId: id, entries: [entry] });
  }

  /**
   * The `canvas` entries a turn ended with (PROTOCOL.md "The canvas card"). They go after the turn, before any `push`
   * entries that came after the turn's last words (pushes from `turnStart` on that end the list), and are then no later
   * than the first of them; moving them in front of entries the phone has sends the whole list.
   */
  noteCanvas(id: string, entries: ActivityEntry[], turnStart: number): void {
    if (entries.length === 0) return;
    const t = this.track(id);
    let at = t.entries.length;
    while (at > 0 && t.entries[at - 1]!.kind === "push" && Date.parse(t.entries[at - 1]!.at) >= turnStart) at--;
    const pushes = t.entries.slice(at);
    const first = pushes[0];
    const placed = first ? entries.map((e) => (Date.parse(e.at) > Date.parse(first.at) ? { ...e, at: first.at } : e)) : entries;
    t.entries = [...t.entries.slice(0, at), ...placed, ...pushes].slice(-ACTIVITY_KEEP);
    if (pushes.length === 0) this.emit("activity", { type: "activity", sessionId: id, entries: placed });
    else this.emit("activity", { type: "activity", sessionId: id, entries: t.entries, full: true });
  }

  /** The session is gone. */
  forget(id: string): void {
    this.tracks.delete(id);
  }

  private track(id: string): Track {
    let t = this.tracks.get(id);
    if (!t) {
      t = { entries: [], pending: [], pendingStop: null, wholes: new Map() };
      this.tracks.set(id, t);
    }
    return t;
  }

  /**
   * An entry as it is sent (the protocol's `cutEntry`): a text over `ACTIVITY_TEXT_MAX` is cut and its whole kept
   * under a fresh `cut` id, the oldest whole text going once the session has more than `WHOLE_TEXTS_KEEP`.
   */
  private cut(t: Track, entry: ActivityEntry): ActivityEntry {
    return cutEntry(entry, () => {
      const id = randomBytes(6).toString("hex");
      t.wholes.set(id, entry.text);
      while (t.wholes.size > WHOLE_TEXTS_KEEP) t.wholes.delete(t.wholes.keys().next().value!);
      return id;
    });
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
