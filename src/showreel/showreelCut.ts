/**
 * Pure: how a day's clips become a showreel (PROTOCOL.md "Showreel"). Without a model, each title an agent gave its
 * clips is a piece: its `before` clip beside its clips, closed by the push that followed. With a model's proposal, the
 * pieces are the model's, with every clip or board it names that the day does not have dropped, and every clip it
 * left out given a piece of its own. No count of anything reaches the reel. No I/O, no clock.
 */
import { CLIP_LINE_MAX, CLIP_TITLE_MAX, PART_CLIPS_MAX, SHOWREEL_PIECES_MAX, type ActivityEntry, type Clip, type ShowreelBoard, type ShowreelDone, type ShowreelPart, type ShowreelPiece } from "@grenade/protocol";
import { foldText } from "./clipFile.js";

/** A board saved on the day, as the cut can name it. */
export interface DayBoard extends ShowreelBoard {
  /** What its `<title>` says, for the model. */
  title: string;
  modified: string;
}

/** A push of a session's branch on the day: the push entries of its activity, succeeded only. */
export interface DayPush {
  session: string;
  at: string;
  text: string;
}

/** What a model proposes: pieces that name clips by id and boards by file name. Anything else in it is ignored. */
export interface ShowreelProposal {
  pieces: {
    title: string;
    line?: string;
    parts: { title?: string; board?: string; before?: string; clips: string[] }[];
  }[];
}

export interface CutInput {
  clips: readonly Clip[];
  boards: readonly DayBoard[];
  pushes: readonly DayPush[];
  proposal?: ShowreelProposal | undefined;
}

/** A push closes a part when it came within this long after the part's last clip. */
export const DONE_WINDOW_MS = 2 * 60 * 60 * 1000;

/** The pieces of a day's reel, in play order. */
export function cutShowreel(input: CutInput): ShowreelPiece[] {
  const byId = new Map(input.clips.map((c) => [c.id, c]));
  const used = new Set<string>();
  const pieces: ShowreelPiece[] = [];
  if (input.proposal) {
    for (const proposed of input.proposal.pieces) {
      const parts: ShowreelPart[] = [];
      for (const p of proposed.parts) {
        const part = proposedPart(p, byId, used, input.boards, input.pushes);
        if (part) parts.push(part);
      }
      if (parts.length === 0) continue;
      const title = foldText(proposed.title, CLIP_TITLE_MAX) || parts[0]!.title || titleOf(byId.get(parts[0]!.clips[0]!)!);
      const line = proposed.line ? foldText(proposed.line, CLIP_LINE_MAX) : lineOf(parts, byId);
      pieces.push({ title, ...(line ? { line } : {}), parts: parts.slice(0, PART_CLIPS_MAX) });
    }
  }
  for (const group of groupsByTitle(input.clips.filter((c) => !used.has(c.id)))) {
    const part = partOf(group, input.pushes);
    for (const id of [...(part.before ? [part.before] : []), ...part.clips]) used.add(id);
    const line = lineOf([part], byId);
    pieces.push({ title: part.title ?? titleOf(group[0]!), ...(line ? { line } : {}), parts: [part] });
  }
  return pieces.sort((a, b) => firstAt(a, byId).localeCompare(firstAt(b, byId))).slice(0, SHOWREEL_PIECES_MAX);
}

/** A proposed part with only the clips the day has, each clip in one part only; null when nothing of it is left. */
function proposedPart(p: ShowreelProposal["pieces"][number]["parts"][number], byId: Map<string, Clip>, used: Set<string>, boards: readonly DayBoard[], pushes: readonly DayPush[]): ShowreelPart | null {
  const clips = p.clips.filter((id) => byId.has(id) && !used.has(id) && !byId.get(id)!.before).slice(0, PART_CLIPS_MAX);
  const before = p.before && byId.has(p.before) && !used.has(p.before) && byId.get(p.before)!.before ? p.before : undefined;
  if (clips.length === 0) return null;
  for (const id of [...(before ? [before] : []), ...clips]) used.add(id);
  const board = p.board ? boards.find((b) => b.file === p.board) : undefined;
  const title = p.title ? foldText(p.title, CLIP_TITLE_MAX) : undefined;
  const done = doneOf(clips.map((id) => byId.get(id)!), pushes);
  return {
    ...(title ? { title } : {}),
    ...(board ? { board: { cwd: board.cwd, ...(board.group ? { group: board.group } : {}), ...(board.canvas ? { canvas: board.canvas } : {}), file: board.file } } : {}),
    ...(before ? { before } : {}),
    clips,
    ...(done ? { done } : {}),
  };
}

/** Clips with the same title (and session) belong together, in the order they were made. */
export function groupsByTitle(clips: readonly Clip[]): Clip[][] {
  const groups = new Map<string, Clip[]>();
  for (const c of [...clips].sort((a, b) => a.at.localeCompare(b.at))) {
    const key = `${c.session ?? ""}|${c.title.trim().toLowerCase()}`;
    const group = groups.get(key);
    if (group) group.push(c);
    else groups.set(key, [c]);
  }
  return [...groups.values()];
}

/** One part from one group: the first `before` beside the rest, closed by the push that followed. */
function partOf(group: Clip[], pushes: readonly DayPush[]): ShowreelPart {
  const before = group.find((c) => c.before);
  const clips = group.filter((c) => !c.before).slice(0, PART_CLIPS_MAX);
  // A group with only a `before` still plays: the old behavior is what there is.
  const played = clips.length > 0 ? clips : before ? [before] : [];
  const done = doneOf(played, pushes);
  return {
    title: titleOf(group[0]!),
    ...(before && clips.length > 0 ? { before: before.id } : {}),
    clips: played.map((c) => c.id),
    ...(done ? { done } : {}),
  };
}

/** The first push of a clip's session after the part's last clip, within the window. */
export function doneOf(clips: readonly Clip[], pushes: readonly DayPush[]): ShowreelDone | undefined {
  const sessions = new Set(clips.map((c) => c.session).filter((s): s is string => !!s));
  const last = clips.map((c) => c.at).sort().at(-1);
  if (!last || sessions.size === 0) return undefined;
  const lastMs = Date.parse(last);
  const push = pushes
    .filter((p) => sessions.has(p.session) && Date.parse(p.at) >= lastMs && Date.parse(p.at) - lastMs <= DONE_WINDOW_MS)
    .sort((a, b) => a.at.localeCompare(b.at))[0];
  return push ? { kind: "push", text: foldText(push.text, 200), at: push.at, session: push.session } : undefined;
}

/** The pushes of a session's activity that moved commits: never a failed one. */
export function pushesIn(session: string, entries: readonly ActivityEntry[]): DayPush[] {
  return entries.filter((e) => e.kind === "push" && !e.failed).map((e) => ({ session, at: e.at, text: e.text }));
}

function titleOf(clip: Clip): string {
  return foldText(clip.title, CLIP_TITLE_MAX);
}

/** The first line any of the parts' clips carries. */
function lineOf(parts: readonly ShowreelPart[], byId: Map<string, Clip>): string | undefined {
  for (const part of parts) {
    for (const id of part.clips) {
      const line = byId.get(id)?.line;
      if (line) return foldText(line, CLIP_LINE_MAX);
    }
  }
  return undefined;
}

function firstAt(piece: ShowreelPiece, byId: Map<string, Clip>): string {
  return piece.parts.flatMap((p) => p.clips.map((id) => byId.get(id)?.at ?? "")).sort()[0] ?? "";
}
