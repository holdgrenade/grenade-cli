/**
 * `grenade clip <file> --title … [--line …] [--before] [--session …]`: keeps a recording or a picture an agent made of
 * a feature in use as a clip of today (PROTOCOL.md "Showreel"), through `POST /clips`. The session is the one the
 * command runs in (`GRENADE_SESSION`, set by the daemon in every session's tmux) unless named. `grenade clips [date]`
 * lists a day's clips; `grenade showreel [date] [--make]` prints the day's reel, `grenade showreel hour <h>` sets when
 * it is cut.
 */
import { resolve } from "node:path";
import { InvalidArgumentError, type Command } from "commander";
import type { Clip, ClipsFrame, ShowreelFrame } from "@grenade/protocol";
import type { Control } from "./controlClient.js";

export interface ClipCommandDeps {
  control: Control;
}

export function registerClipCommand(program: Command, d: ClipCommandDeps): void {
  program
    .command("clip <file>")
    .description("keep a recording or a picture of a feature in use as a clip of today's showreel")
    .requiredOption("--title <title>", "the feature, in the product's words: \"Changes, from the phone\"")
    .option("--line <line>", "what it does, one line")
    .option("--before", "this shows the old behavior, recorded before the change")
    .option("--session <id>", "the session it belongs to (the one this runs in, unless given)")
    .action(async (file: string, opts: { title: string; line?: string; before?: boolean; session?: string }) => {
      const session = opts.session ?? process.env["GRENADE_SESSION"];
      const clip = await d.control<Clip>("POST", "/clips", { path: resolve(file), title: opts.title, ...(opts.line ? { line: opts.line } : {}), ...(opts.before ? { before: true } : {}), ...(session ? { session } : {}) });
      console.log(clipLine(clip));
    });

  program
    .command("clips [date]")
    .description("the clips of a day (today unless given, YYYY-MM-DD)")
    .action(async (date?: string) => {
      const frame = await d.control<ClipsFrame>("GET", `/clips${dateQuery(date)}`);
      if (frame.clips.length === 0) return console.log(`No clips on ${frame.date}. An agent records one with: grenade clip <file> --title "…"`);
      for (const clip of frame.clips) console.log(clipLine(clip));
    });

  const showreel = program
    .command("showreel [date]")
    .description("the day's showreel: the features shipped, as the clips cut into pieces (today unless given)")
    .option("--make", "cut it again now, with the model")
    .action(async (date: string | undefined, opts: { make?: boolean }) => {
      const frame = opts.make ? await d.control<ShowreelFrame>("POST", "/showreel/make", { ...(checkDate(date) ? { date } : {}) }) : await d.control<ShowreelFrame>("GET", `/showreel${dateQuery(date)}`);
      for (const line of showreelLines(frame)) console.log(line);
    });

  showreel
    .command("hour [hour]")
    .description("the hour of the day the showreel is cut and announced in Command Center (18 unless set)")
    .action(async (hour?: string) => {
      if (hour !== undefined) {
        const h = Number(hour);
        if (!Number.isInteger(h) || h < 0 || h > 23) throw new InvalidArgumentError("expected an hour, 0 to 23");
        const set = await d.control<{ hour: number }>("POST", "/showreel/settings", { hour: h });
        return console.log(`The showreel is cut at ${set.hour}:00.`);
      }
      const current = await d.control<{ hour: number }>("GET", "/showreel/settings");
      console.log(`The showreel is cut at ${current.hour}:00. Change it with: grenade showreel hour <0-23>`);
    });
}

function checkDate(date: string | undefined): date is string {
  if (date === undefined) return false;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new InvalidArgumentError("expected a day as YYYY-MM-DD");
  return true;
}

function dateQuery(date: string | undefined): string {
  return checkDate(date) ? `?date=${date}` : "";
}

/** One clip on one line: its id, kind, time, title and what else it carries. Pure. */
export function clipLine(clip: Clip): string {
  const time = new Date(clip.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const extra = [clip.before ? "before" : "", clip.seconds !== undefined ? `${clip.seconds} s` : "", clip.width && clip.height ? `${clip.width}×${clip.height}` : "", clip.session ?? ""].filter(Boolean);
  return `${clip.id}  ${clip.kind.padEnd(5)}  ${time}  ${clip.title}${clip.line ? ` — ${clip.line}` : ""}${extra.length ? `  (${extra.join(", ")})` : ""}`;
}

/** What `grenade showreel` prints: each piece, its parts and what they play. Pure. */
export function showreelLines(frame: ShowreelFrame): string[] {
  if (frame.pieces.length === 0) return [`No showreel for ${frame.date}: no clips yet. An agent records one with: grenade clip <file> --title "…"`];
  const titles = new Map(frame.clips.map((c) => [c.id, c]));
  const lines = [`Showreel · ${frame.date}${frame.madeAt ? ` · cut ${new Date(frame.madeAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : ""} · version ${frame.version}`];
  frame.pieces.forEach((piece, i) => {
    lines.push(`${i + 1}. ${piece.title}${piece.line ? ` — ${piece.line}` : ""}`);
    for (const part of piece.parts) {
      if (piece.parts.length > 1 && part.title) lines.push(`   · ${part.title}`);
      if (part.board) lines.push(`     board   ${part.board.file}`);
      if (part.before) lines.push(`     before  ${part.before}  ${titles.get(part.before)?.kind ?? ""}`);
      for (const id of part.clips) lines.push(`     clip    ${id}  ${titles.get(id)?.kind ?? ""}${titles.get(id)?.seconds !== undefined ? ` ${titles.get(id)!.seconds} s` : ""}`);
      if (part.done) lines.push(`     done    ${part.done.text}`);
    }
  });
  return lines;
}
