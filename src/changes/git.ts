/**
 * Runs git in a session's folder for PROTOCOL.md "Changes": its summary, files, commits, a file's diff, and a push.
 * Every call is `execFile` with a timeout, never a shell, and a path from a client reaches git after `--`.
 * What the output means is `gitParse.ts`.
 */
import { execFile } from "node:child_process";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { CHANGES_COMMITS_MAX, CHANGES_FILES_MAX, type ChangeCommit, type ChangedFile, type DiffLine, type PushFailure, type SessionChanges } from "@grenade/protocol";
import {
  commitPageOf,
  filesWithCounts,
  firstGitLine,
  LOG_FORMAT,
  linesIn,
  parseLog,
  parseNameStatus,
  parseNumstat,
  parseStatusV2,
  parseUnifiedDiff,
  pushFailureOf,
  pushRemoteOf,
  remoteOfRef,
  type LoggedCommit,
} from "./gitParse.js";

/** How long a read may take. */
const READ_TIMEOUT_MS = 5000;
/** How long a push may take. */
export const PUSH_TIMEOUT_MS = 60_000;
/** git's empty tree, for a repository with no commit yet. */
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
/** How much of an untracked file is read to count its lines. */
const UNTRACKED_READ_BYTES = 1024 * 1024;

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs one git command; never throws for a non-zero exit (that is `code`), only for git missing or a timeout. */
export function runGit(cwd: string, args: string[], timeout = READ_TIMEOUT_MS): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      // No pager, no colors, no prompt for a password; LC_ALL=C so the words git writes are the ones parsed.
      { cwd, timeout, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_PAGER: "cat", LC_ALL: "C", GIT_OPTIONAL_LOCKS: "0" } },
      (err, stdout, stderr) => {
        if (err && typeof (err as { code?: unknown }).code !== "number") return reject(err);
        resolve({ code: err ? Number((err as { code: number }).code) : 0, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}

/** The repository's top folder, or undefined when `cwd` is in none (or is gone). */
export async function topOf(cwd: string): Promise<string | undefined> {
  try {
    const r = await runGit(cwd, ["rev-parse", "--show-toplevel"]);
    return r.code === 0 ? r.stdout.trim() || undefined : undefined;
  } catch {
    return undefined;
  }
}

/** What a session's folder holds in git now: the summary, and the commits waiting for its upstream (hash → subject). */
export interface GitSnapshot {
  top: string;
  head: string | undefined;
  changes: SessionChanges;
  /** The commits not on an upstream yet, newest first: with an upstream those it lacks, without one the session's since `base`. */
  waiting: { hash: string; subject: string }[];
}

/** Reads the summary of the repository `cwd` is in, counting the session's commits since `base`. Undefined outside git. */
export async function readSnapshot(cwd: string, base: string | undefined): Promise<GitSnapshot | undefined> {
  const top = await topOf(cwd);
  if (!top) return undefined;
  const [status, remotes] = await Promise.all([
    runGit(top, ["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"]),
    runGit(top, ["remote"]),
  ]);
  if (status.code !== 0) return undefined;
  const report = parseStatusV2(status.stdout);
  const files = await countedFiles(top, report.head, report.files);
  const remote = pushRemoteOf(remotes.stdout.split("\n").map((l) => l.trim()).filter(Boolean));
  const waiting = report.head ? await waitingCommits(top, base, report.upstream !== undefined) : [];
  const commits = report.head && base ? await sessionWaitingCount(top, base, report.upstream !== undefined) : report.upstream ? 0 : waiting.length;
  const changes: SessionChanges = {
    ...(report.branch ? { branch: report.branch } : {}),
    ...(report.upstream ? { upstream: report.upstream } : {}),
    ...(remote ? { remote } : {}),
    ahead: report.upstream ? report.ahead : 0,
    behind: report.upstream ? report.behind : 0,
    commits,
    files: files.length,
    added: files.reduce((n, f) => n + (f.added ?? 0), 0),
    removed: files.reduce((n, f) => n + (f.removed ?? 0), 0),
  };
  return { top, head: report.head, changes, waiting };
}

/** The commit checked out in `cwd`'s repository, or undefined (no repository, no commit yet). */
export async function headOf(cwd: string): Promise<string | undefined> {
  try {
    const r = await runGit(cwd, ["rev-parse", "--verify", "-q", "HEAD"]);
    return r.code === 0 ? r.stdout.trim() || undefined : undefined;
  } catch {
    return undefined;
  }
}

/** The files that differ from HEAD with their line counts, at most `CHANGES_FILES_MAX` (and whether more were left out). */
export async function readFiles(cwd: string): Promise<{ top: string; files: ChangedFile[]; truncated: boolean } | undefined> {
  const top = await topOf(cwd);
  if (!top) return undefined;
  const status = await runGit(top, ["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"]);
  if (status.code !== 0) return undefined;
  const report = parseStatusV2(status.stdout);
  const files = await countedFiles(top, report.head, report.files);
  return { top, files: files.slice(0, CHANGES_FILES_MAX), truncated: files.length > CHANGES_FILES_MAX };
}

async function countedFiles(top: string, head: string | undefined, files: ReturnType<typeof parseStatusV2>["files"]): Promise<ChangedFile[]> {
  if (files.length === 0) return [];
  const numstat = await runGit(top, ["diff", head ?? EMPTY_TREE, "--numstat", "-z", "-M"]);
  const untracked = new Map<string, number | null>();
  for (const f of files.slice(0, CHANGES_FILES_MAX)) {
    if (f.status === "untracked") untracked.set(f.path, await untrackedLines(join(top, f.path)));
  }
  return filesWithCounts(files, parseNumstat(numstat.stdout), untracked);
}

async function untrackedLines(path: string): Promise<number | null> {
  try {
    const fh = await open(path, "r");
    try {
      const buf = Buffer.alloc(UNTRACKED_READ_BYTES);
      const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
      return linesIn(buf.subarray(0, bytesRead));
    } finally {
      await fh.close();
    }
  } catch {
    return null;
  }
}

/** Commits not on an upstream yet: with one, those it lacks; without, the session's since `base`. Newest first. */
async function waitingCommits(top: string, base: string | undefined, hasUpstream: boolean): Promise<{ hash: string; subject: string }[]> {
  const range = hasUpstream ? ["@{u}..HEAD"] : base ? ["HEAD", `^${base}`] : null;
  if (!range) return [];
  const r = await runGit(top, ["log", `-n${CHANGES_COMMITS_MAX}`, "--format=%H%x1f%s", ...range, "--"]);
  if (r.code !== 0) return [];
  return r.stdout
    .split("\n")
    .map((l) => l.split("\x1f"))
    .filter(([h]) => h && /^[0-9a-f]{40}/.test(h))
    .map(([hash = "", subject = ""]) => ({ hash, subject }));
}

/** How many of the session's commits (since `base`) are on no upstream. */
async function sessionWaitingCount(top: string, base: string, hasUpstream: boolean): Promise<number> {
  const r = await runGit(top, ["rev-list", "--count", "HEAD", `^${base}`, ...(hasUpstream ? ["^@{u}"] : []), "--"]);
  return r.code === 0 ? Number(r.stdout.trim()) || 0 : 0;
}

/** The session's commits for the drawer: since `base`, and those the upstream lacks; newest first, at most 50. */
export async function readCommits(top: string, base: string | undefined, upstream: string | undefined): Promise<ChangeCommit[]> {
  const logOf = async (range: string[]): Promise<LoggedCommit[]> => {
    const r = await runGit(top, ["log", `-n${CHANGES_COMMITS_MAX}`, LOG_FORMAT, "--shortstat", ...range, "--"]);
    return r.code === 0 ? parseLog(r.stdout) : [];
  };
  const [mine, unpushed] = await Promise.all([base ? logOf(["HEAD", `^${base}`]) : Promise.resolve([]), upstream ? logOf(["@{u}..HEAD"]) : Promise.resolve([])]);
  const waiting = new Set(unpushed.map((c) => c.hash));
  const all = new Map<string, LoggedCommit>();
  for (const c of [...unpushed, ...mine]) all.set(c.hash, c);
  return [...all.values()]
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, CHANGES_COMMITS_MAX)
    .map((c) => ({ ...c, pushed: upstream ? !waiting.has(c.hash) : false }));
}

/** A commit's files, or undefined when the repository has no such commit. */
export async function readCommitFiles(top: string, commit: string): Promise<ChangedFile[] | undefined> {
  const [names, numstat] = await Promise.all([
    runGit(top, ["show", "--format=", "--name-status", "-z", "-M", commit, "--"]),
    runGit(top, ["show", "--format=", "--numstat", "-z", "-M", commit, "--"]),
  ]);
  if (names.code !== 0) return undefined;
  return parseNameStatus(names.stdout, parseNumstat(numstat.stdout)).slice(0, CHANGES_FILES_MAX);
}

/** One file's diff: against HEAD (an untracked file: all of it added), or what `commit` did to it. */
export async function readDiff(top: string, path: string, commit: string | undefined): Promise<{ lines: DiffLine[]; binary?: true; tooLong?: true } | undefined> {
  if (commit) {
    const r = await runGit(top, ["show", "--format=", "-M", commit, "--", path]);
    return r.code === 0 ? parseUnifiedDiff(r.stdout) : undefined;
  }
  const head = await headOf(top);
  const tracked = await runGit(top, ["diff", head ?? EMPTY_TREE, "-M", "--", path]);
  if (tracked.code === 0 && tracked.stdout.trim()) return parseUnifiedDiff(tracked.stdout);
  const others = await runGit(top, ["ls-files", "--others", "--exclude-standard", "-z", "--", path]);
  if (others.stdout.split("\0").includes(path)) {
    // `--no-index` exits 1 when the files differ, which is always here.
    const r = await runGit(top, ["diff", "--no-index", "--", "/dev/null", path]);
    return parseUnifiedDiff(r.stdout);
  }
  return { lines: [] };
}

/** How a push went. */
export type PushOutcome = { ok: true } | { ok: false; failed: PushFailure; detail: string | undefined };

/** Pushes the branch: to its upstream, or with none to `remote`, setting it. Never forced. */
export async function pushBranch(top: string, changes: SessionChanges): Promise<PushOutcome> {
  const args = changes.upstream ? ["push"] : ["push", "-u", changes.remote ?? "origin", changes.branch ?? "HEAD"];
  try {
    const r = await runGit(top, args, PUSH_TIMEOUT_MS);
    if (r.code === 0) return { ok: true };
    const failed = pushFailureOf(r.stderr);
    return { ok: false, failed, detail: failed === "other" ? firstGitLine(r.stderr) : undefined };
  } catch (e) {
    const timedOut = (e as { killed?: boolean }).killed === true;
    return { ok: false, failed: "other", detail: timedOut ? "it took longer than a minute" : String((e as Error).message) };
  }
}

/** Whether `upstream` (a ref like `origin/main`) has the commit `hash` now. */
export async function upstreamHas(top: string, upstream: string, hash: string): Promise<boolean> {
  const r = await runGit(top, ["merge-base", "--is-ancestor", hash, upstream]);
  return r.code === 0;
}

/**
 * Each commit's page on the website of the remote `upstream` (a ref like `origin/main`) belongs to, by full hash;
 * empty when that remote is on no host whose website the daemon knows (`commitPageOf`).
 */
export async function commitPagesOf(top: string, upstream: string, hashes: readonly string[]): Promise<Map<string, string>> {
  const pages = new Map<string, string>();
  const remotes = await runGit(top, ["remote"]);
  const remote = remoteOfRef(upstream, remotes.stdout.split("\n").map((l) => l.trim()).filter(Boolean));
  if (!remote) return pages;
  const url = await runGit(top, ["remote", "get-url", "--", remote]);
  if (url.code !== 0) return pages;
  for (const hash of hashes) {
    const page = commitPageOf(url.stdout, hash);
    if (page) pages.set(hash, page);
  }
  return pages;
}
