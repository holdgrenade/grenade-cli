/**
 * The Claude Code conversations saved on this Mac (PROTOCOL.md "Conversations"): `<claude dir>/projects/<folder>/
 * <id>.jsonl`. Lists them for the `conversations` frame, finds one to resume, and reads one for a preview. Reads only;
 * a transcript is read again only when it changed. Grenade's own mark (which conversations are its copies) comes from ConversationMarks. `trashPaths` names
 * what a delete moves to the Trash; the move itself is `trash.ts`.
 */
import { open, readdir, readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { statSync } from "node:fs";
import { basename, join } from "node:path";
import { ACTIVITY_KEEP, CONVERSATIONS_MAX, activityEntriesIn, type ActivityEntry, type Conversation } from "@grenade/protocol";
import { conversationInfoIn, type ConversationInfo } from "./conversationInfo.js";
import type { ConversationMarks } from "./conversationMarks.js";
import { runningConversationIds } from "./runningClaude.js";

/** How much of each end of a transcript a list row is read from. */
const SLICE = 128 * 1024;

interface Found {
  id: string;
  path: string;
  mtimeMs: number;
  size: number;
}

export interface ConversationIndexOptions {
  /** Claude Code's folder: CLAUDE_CONFIG_DIR, else ~/.claude. */
  claudeDir: string;
  marks: ConversationMarks;
  /** Conversation id → the live Grenade session that holds it (its transcript is that conversation). */
  held(): Map<string, string>;
  /** Defaults to the files in `<claudeDir>/sessions` whose process is alive. */
  running?(): Promise<Set<string>>;
  isDirectory?(path: string): boolean;
}

export class ConversationIndex {
  private readonly cache = new Map<string, { mtimeMs: number; size: number; info: ConversationInfo | null }>();

  constructor(private readonly opts: ConversationIndexOptions) {}

  /** Every conversation, newest first, at most CONVERSATIONS_MAX. */
  async list(): Promise<Conversation[]> {
    const found = (await this.scan()).sort((a, b) => b.mtimeMs - a.mtimeMs);
    const running = await (this.opts.running?.() ?? runningConversationIds(join(this.opts.claudeDir, "sessions")));
    const held = this.opts.held();
    const isDirectory = this.opts.isDirectory ?? isDirectoryOnDisk;
    const out: Conversation[] = [];
    for (const f of found) {
      if (out.length >= CONVERSATIONS_MAX) break;
      const info = await this.infoOf(f);
      if (!info || !isDirectory(info.cwd)) continue;
      const sessionId = held.get(f.id);
      const copyOf = this.opts.marks.copyOf(f.id);
      out.push({
        id: f.id,
        cwd: info.cwd,
        title: info.title,
        ...(info.lastPrompt !== undefined ? { lastPrompt: info.lastPrompt } : {}),
        updatedAt: new Date(f.mtimeMs).toISOString(),
        // A conversation Grenade holds runs in Grenade, not somewhere else.
        ...(running.has(f.id) && !sessionId ? { running: true as const } : {}),
        ...(sessionId ? { sessionId } : {}),
        ...(copyOf ? { copyOf } : {}),
      });
    }
    return out;
  }

  /** The transcript and folder of a conversation, or null when there is none with that id. */
  async find(id: string): Promise<{ path: string; cwd: string } | null> {
    const f = (await this.scan()).find((c) => c.id === id);
    if (!f) return null;
    const info = await this.infoOf(f);
    return info ? { path: f.path, cwd: info.cwd } : null;
  }

  /**
   * What deleting a conversation moves to the Trash: its transcript and the folder of the same name beside it
   * (subagents, tool results), or why it may not be deleted. Grenade's session would write it again, and so would
   * another Claude Code process.
   */
  async trashPaths(id: string): Promise<{ paths: string[] } | { refused: string }> {
    const f = (await this.scan()).find((c) => c.id === id);
    if (!f) return { refused: `no conversation ${id} on this Mac` };
    if (this.opts.held().has(id)) return { refused: "it is open in a Grenade session; end that session first" };
    const running = await (this.opts.running?.() ?? runningConversationIds(join(this.opts.claudeDir, "sessions")));
    if (running.has(id)) return { refused: "it is open in another terminal; quit Claude Code there first" };
    const folder = f.path.slice(0, -".jsonl".length);
    this.cache.delete(f.path);
    return { paths: existsSync(folder) ? [f.path, folder] : [f.path] };
  }

  /** The last ACTIVITY_KEEP activity entries of a conversation, or null when there is none with that id. */
  async preview(id: string): Promise<ActivityEntry[] | null> {
    const f = (await this.scan()).find((c) => c.id === id);
    if (!f) return null;
    return activityEntriesIn(await readFile(f.path, "utf8")).slice(-ACTIVITY_KEEP);
  }

  /** Every `<id>.jsonl` directly in a project folder (subagent transcripts sit deeper and are not conversations). */
  private async scan(): Promise<Found[]> {
    const projects = join(this.opts.claudeDir, "projects");
    const folders = await readdir(projects, { withFileTypes: true }).catch(() => []);
    const out: Found[] = [];
    for (const folder of folders.filter((d) => d.isDirectory())) {
      const dir = join(projects, folder.name);
      const names = await readdir(dir).catch(() => [] as string[]);
      for (const name of names.filter((n) => n.endsWith(".jsonl"))) {
        const path = join(dir, name);
        const s = await stat(path).catch(() => null);
        if (s?.isFile()) out.push({ id: basename(name, ".jsonl"), path, mtimeMs: s.mtimeMs, size: s.size });
      }
    }
    return out;
  }

  private async infoOf(f: Found): Promise<ConversationInfo | null> {
    const hit = this.cache.get(f.path);
    if (hit && hit.mtimeMs === f.mtimeMs && hit.size === f.size) return hit.info;
    const { head, tail } = await readEnds(f.path, f.size).catch(() => ({ head: "", tail: "" }));
    const info = conversationInfoIn(head, tail);
    this.cache.set(f.path, { mtimeMs: f.mtimeMs, size: f.size, info });
    return info;
  }
}

/** The first and last SLICE bytes of a file; the whole file twice when it is small. */
async function readEnds(path: string, size: number): Promise<{ head: string; tail: string }> {
  const file = await open(path, "r");
  try {
    if (size <= 2 * SLICE) {
      const all = Buffer.alloc(size);
      await file.read(all, 0, size, 0);
      const text = all.toString("utf8");
      return { head: text, tail: text };
    }
    const head = Buffer.alloc(SLICE);
    const tail = Buffer.alloc(SLICE);
    await file.read(head, 0, SLICE, 0);
    await file.read(tail, 0, SLICE, size - SLICE);
    return { head: head.toString("utf8"), tail: tail.toString("utf8") };
  } finally {
    await file.close();
  }
}

function isDirectoryOnDisk(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
