/**
 * The Codex conversations saved on this Mac (PROTOCOL.md "Conversations", Codex's row): the rollouts in
 * `<codex dir>/sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl`, titled by `<codex dir>/session_index.jsonl`. Codex's
 * ConversationSource. Reads only; a rollout is read again only when it changed. Codex has no file that says a thread
 * is open in another terminal, so none is `running`. A `codex fork` (how Grenade resumes one) writes only what comes
 * after the fork and points at the original, so a preview reads the original's lines first.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { ACTIVITY_KEEP, CONVERSATIONS_MAX, codexActivityEntriesIn, type ActivityEntry, type Conversation } from "@grenade/protocol";
import { codexConversationIdOf, codexConversationInfoIn, codexForkOf, codexLinesBefore, codexTitlesIn } from "./codexConversationInfo.js";
import type { ConversationInfo } from "./conversationInfo.js";
import type { ConversationMarks } from "./conversationMarks.js";
import type { ConversationSource } from "./conversationSource.js";
import { isDirectoryOnDisk, readEnds } from "./fileEnds.js";

/** How many forks back a preview follows. */
const FORK_DEPTH = 8;

interface Found {
  id: string;
  path: string;
  mtimeMs: number;
  size: number;
}

export interface CodexConversationsOptions {
  /** Codex's folder: CODEX_HOME, else ~/.codex. */
  codexDir: string;
  marks: ConversationMarks;
  /** Conversation id → the live Grenade session that holds it. */
  held(): Map<string, string>;
  isDirectory?(path: string): boolean;
}

export class CodexConversations implements ConversationSource {
  readonly agent = "codex";
  private readonly cache = new Map<string, { mtimeMs: number; size: number; title: string | undefined; info: ConversationInfo | null }>();

  constructor(private readonly opts: CodexConversationsOptions) {}

  async list(): Promise<Conversation[]> {
    const found = (await this.scan()).sort((a, b) => b.mtimeMs - a.mtimeMs);
    const titles = await this.titles();
    const held = this.opts.held();
    const isDirectory = this.opts.isDirectory ?? isDirectoryOnDisk;
    const out: Conversation[] = [];
    for (const f of found) {
      if (out.length >= CONVERSATIONS_MAX) break;
      const info = await this.infoOf(f, titles.get(f.id));
      if (!info || !isDirectory(info.cwd)) continue;
      const sessionId = held.get(f.id);
      const copyOf = this.opts.marks.copyOf(f.id);
      out.push({
        id: f.id,
        agent: this.agent,
        cwd: info.cwd,
        title: info.title,
        ...(info.lastPrompt !== undefined ? { lastPrompt: info.lastPrompt } : {}),
        updatedAt: new Date(f.mtimeMs).toISOString(),
        ...(sessionId ? { sessionId } : {}),
        ...(copyOf ? { copyOf } : {}),
      });
    }
    return out;
  }

  async find(id: string): Promise<{ path: string; cwd: string } | null> {
    const f = await this.findFile(id);
    if (!f) return null;
    const info = await this.infoOf(f, (await this.titles()).get(f.id));
    return info ? { path: f.path, cwd: info.cwd } : null;
  }

  async preview(id: string): Promise<ActivityEntry[] | null> {
    const thread = await this.withHistory(id, await this.scan(), 0);
    return thread === null ? null : codexActivityEntriesIn(thread.history + "\n" + thread.own).slice(-ACTIVITY_KEEP);
  }

  /**
   * A rollout's own lines, and the history it was forked with: the lines of the thread it was forked from up to the
   * fork (each rollout counts its own `ordinal`s), after that thread's own history. As far back as FORK_DEPTH; null
   * without the rollout.
   */
  private async withHistory(id: string, files: Found[], depth: number): Promise<{ history: string; own: string } | null> {
    const f = files.find((c) => c.id === id.toLowerCase());
    if (!f) return null;
    const own = await readFile(f.path, "utf8");
    const fork = depth < FORK_DEPTH ? codexForkOf(own) : null;
    const parent = fork ? await this.withHistory(fork.from, files, depth + 1) : null;
    if (!fork || !parent) return { history: "", own };
    return { history: parent.history + "\n" + codexLinesBefore(parent.own, fork.before), own };
  }

  /** The rollout, or why it may not be deleted: Grenade's session would write it again. Its title stays in Codex's index. */
  async trashPaths(id: string): Promise<{ paths: string[] } | { refused: string } | null> {
    const f = await this.findFile(id);
    if (!f) return null;
    if (this.opts.held().has(id)) return { refused: "it is open in a Grenade session; end that session first" };
    this.cache.delete(f.path);
    return { paths: [f.path] };
  }

  private async findFile(id: string): Promise<Found | undefined> {
    return (await this.scan()).find((f) => f.id === id.toLowerCase());
  }

  /** Every rollout under sessions/, three folders deep (year, month, day). */
  private async scan(): Promise<Found[]> {
    const out: Found[] = [];
    const walk = async (dir: string, depth: number): Promise<void> => {
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const e of entries) {
        const path = join(dir, e.name);
        if (depth < 3) {
          if (e.isDirectory()) await walk(path, depth + 1);
          continue;
        }
        const id = e.isFile() ? codexConversationIdOf(path) : null;
        if (!id) continue;
        const s = await stat(path).catch(() => null);
        if (s?.isFile()) out.push({ id, path, mtimeMs: s.mtimeMs, size: s.size });
      }
    };
    await walk(join(this.opts.codexDir, "sessions"), 0);
    return out;
  }

  private async titles(): Promise<Map<string, string>> {
    const text = await readFile(join(this.opts.codexDir, "session_index.jsonl"), "utf8").catch(() => "");
    return codexTitlesIn(text);
  }

  private async infoOf(f: Found, title: string | undefined): Promise<ConversationInfo | null> {
    const hit = this.cache.get(f.path);
    if (hit && hit.mtimeMs === f.mtimeMs && hit.size === f.size && hit.title === title) return hit.info;
    const { head, tail } = await readEnds(f.path, f.size).catch(() => ({ head: "", tail: "" }));
    const info = codexConversationInfoIn(head, tail, title);
    this.cache.set(f.path, { mtimeMs: f.mtimeMs, size: f.size, title, info });
    return info;
  }
}
