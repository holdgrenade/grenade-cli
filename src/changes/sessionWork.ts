/**
 * Whose work a pushed commit carries (PROTOCOL.md "The push card"): several sessions can share one folder and branch,
 * so a push of it is a session's only when the commits hold that session's own work. A session's work is what its
 * agent's hooks say it wrote (the lines of a `Write`, `Edit`, `MultiEdit` or `NotebookEdit`, a Codex `apply_patch`)
 * and the commits it made itself (the `[branch abc1234]` line `git commit` prints). Pure: `changesTracker.ts` reads
 * the commits from git and keeps one `SessionWork` per session.
 */
import { posix } from "node:path";

/** What one hook says the agent did: files it wrote, each with the lines it added, and commits it made. */
export interface HookWork {
  /** Absolute paths; `lines` empty when the edit added no line telling it apart (a deletion, braces). */
  files: { path: string; lines: string[] }[];
  /** Hashes as `git commit` printed them (short). */
  commits: string[];
}

/** A commit as the tracker reads it: its full hash, and the lines it added per file as git shows them (paths relative to the top). */
export interface CommitContent {
  hash: string;
  files: Map<string, string[]>;
}

/** How many lines a session keeps per file; past it the oldest go. */
const LINES_PER_FILE_MAX = 4000;

/**
 * A line that tells one piece of work from another: trimmed, at least 4 characters and a letter or digit among them.
 * `}`, `);` or a blank line are in every file and would make any commit anyone's.
 */
export function workLine(line: string): string | null {
  const t = line.trim();
  return t.length >= 4 && /[A-Za-z0-9]/.test(t) ? t : null;
}

function workLines(text: string): string[] {
  return text.split("\n").flatMap((l) => {
    const w = workLine(l);
    return w ? [w] : [];
  });
}

/** The lines of `after` that `before` lacks: an edit's `new_string` repeats the lines around the change. */
function newLines(before: string, after: string): string {
  const had = new Map<string, number>();
  for (const l of before.split("\n")) had.set(l, (had.get(l) ?? 0) + 1);
  return after
    .split("\n")
    .filter((l) => {
      const n = had.get(l) ?? 0;
      if (n > 0) had.set(l, n - 1);
      return n === 0;
    })
    .join("\n");
}

/**
 * The lines Claude Code says its tool added, from the `structuredPatch` of its `tool_response` (`+` lines of each
 * hunk); null when the response has none (an older Claude Code, a new file).
 */
export function patchedLinesIn(toolResponse: unknown): string | null {
  const patch = (toolResponse as { structuredPatch?: unknown } | null)?.structuredPatch;
  if (!Array.isArray(patch) || patch.length === 0) return null;
  const added: string[] = [];
  for (const hunk of patch) {
    const lines = (hunk as { lines?: unknown } | null)?.lines;
    if (Array.isArray(lines)) for (const l of lines) if (typeof l === "string" && l.startsWith("+")) added.push(l.slice(1));
  }
  return added.join("\n");
}

/** The work a hook reports: only a `PostToolUse`. */
export function workOfHook(event: unknown, toolName: unknown, toolInput: unknown, toolResponse: unknown, cwd: string | undefined): HookWork {
  const work: HookWork = { files: [], commits: [] };
  if (event !== "PostToolUse" || typeof toolName !== "string" || typeof toolInput !== "object" || toolInput === null) return work;
  const input = toolInput as Record<string, unknown>;
  const absolute = (p: string) => (p.startsWith("/") ? posix.normalize(p) : cwd?.startsWith("/") ? posix.resolve(cwd, p) : null);
  const add = (p: unknown, text: string) => {
    const path = typeof p === "string" && p.trim() ? absolute(p.trim()) : null;
    if (path) work.files.push({ path, lines: workLines(text) });
  };
  const patched = typeof toolResponse === "object" ? patchedLinesIn(toolResponse) : null;
  switch (toolName) {
    case "Write":
      add(input.file_path, patched ?? str(input.content));
      break;
    case "Edit":
      add(input.file_path, patched ?? newLines(str(input.old_string), str(input.new_string)));
      break;
    case "MultiEdit": {
      const edits = (Array.isArray(input.edits) ? input.edits : []) as (Record<string, unknown> | null)[];
      add(input.file_path, patched ?? edits.map((e) => newLines(str(e?.old_string), str(e?.new_string))).join("\n"));
      break;
    }
    case "NotebookEdit":
      add(input.notebook_path, str(input.new_source));
      break;
    case "apply_patch":
      for (const f of patchWorkOf(text(input.input) ?? text(input.patch) ?? text(input.command) ?? "")) add(f.path, f.added);
      break;
  }
  if (JSON.stringify(toolInput).includes("commit")) work.commits = committedIn(toolResponse);
  return work;
}

/** Each file a Codex patch touches, with the lines it adds (`+`), as written in it. */
export function patchWorkOf(patch: string): { path: string; added: string }[] {
  const out: { path: string; added: string[] }[] = [];
  let current: { path: string; added: string[] } | undefined;
  for (const raw of patch.split("\n")) {
    const line = raw.trimEnd();
    const m = /^\*\*\* (Add File|Update File|Delete File|Move to): (.+)$/.exec(line);
    if (m) {
      // A move names the file's new path: the lines after it are that file's.
      if (m[1] === "Move to" && current) current.path = m[2]!;
      else out.push((current = { path: m[2]!, added: [] }));
      continue;
    }
    if (current && line.startsWith("+")) current.added.push(line.slice(1));
  }
  return out.map((f) => ({ path: f.path, added: f.added.join("\n") }));
}

/** The commits `git commit` reported in a tool's output: `[main 3bf2095] Subject`, `[main (root-commit) 3bf2095] …`. */
export function committedIn(toolResponse: unknown): string[] {
  // Claude Code's `{stdout, stderr}`, or Codex's output however it nests it: git starts the line with it.
  const out = typeof toolResponse === "string" ? toolResponse : (JSON.stringify(toolResponse ?? "") ?? "").replaceAll("\\n", "\n").replaceAll('"', "\n");
  const hashes = new Set<string>();
  for (const m of out.matchAll(/^\[[^\]\n]*? ([0-9a-f]{7,40})\] /gm)) hashes.add(m[1]!);
  return [...hashes];
}

/** One session's work not pushed yet. */
export class SessionWork {
  /** Absolute path → the lines written there; an empty set means the file was touched without a line to match. */
  private readonly files = new Map<string, Set<string>>();
  private readonly commits = new Set<string>();

  add(work: HookWork): void {
    for (const f of work.files) {
      const lines = this.files.get(f.path) ?? new Set<string>();
      for (const l of f.lines) {
        lines.delete(l);
        lines.add(l);
      }
      while (lines.size > LINES_PER_FILE_MAX) lines.delete(lines.values().next().value!);
      this.files.set(f.path, lines);
    }
    for (const c of work.commits) this.commits.add(c);
  }

  /**
   * Whether `commit` carries this session's work, and if so forgets that work, so a later commit of the same file by
   * another session is not this one's. A commit is the session's when it made it, or when it adds a line the session
   * wrote to a file of the same path, or changes a file the session touched without a line to match.
   */
  take(commit: CommitContent): boolean {
    let mine = false;
    for (const short of this.commits) {
      if (commit.hash.startsWith(short)) {
        this.commits.delete(short);
        mine = true;
      }
    }
    for (const [relative, added] of commit.files) {
      for (const [path, lines] of this.files) {
        if (path !== `/${relative}` && !path.endsWith(`/${relative}`)) continue;
        if (lines.size === 0) {
          this.files.delete(path);
          mine = true;
          continue;
        }
        for (const l of added) {
          const w = workLine(l);
          if (w && lines.delete(w)) mine = true;
        }
        if (lines.size === 0) this.files.delete(path);
      }
    }
    return mine;
  }
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function text(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && value.every((v) => typeof v === "string")) return value.join("\n");
  return null;
}
