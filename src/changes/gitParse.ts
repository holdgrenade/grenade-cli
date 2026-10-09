/**
 * Pure: what git's output means for PROTOCOL.md "Changes". `git status --porcelain=v2 --branch -z`, `git diff
 * --numstat -z`, `git log` with a record format and `--shortstat`, `git show --name-status -z`, a unified diff, and
 * the words of a failed `git push`. No I/O; `git.ts` runs git and hands the text here.
 */
import {
  DIFF_LINE_TEXT_MAX,
  DIFF_LINES_MAX,
  COMMIT_SUBJECT_MAX,
  type ChangeStatus,
  type ChangedFile,
  type DiffLine,
  type PushFailure,
} from "@grenade/protocol";

/** What `git status --porcelain=v2 --branch -z` says about the branch, and the files it lists. */
export interface StatusReport {
  /** Absent on a detached HEAD. */
  branch: string | undefined;
  /** The commit checked out; absent in a repository with no commit yet. */
  head: string | undefined;
  upstream: string | undefined;
  ahead: number;
  behind: number;
  files: { path: string; status: ChangeStatus; from?: string }[];
}

/** Reads `git status --porcelain=v2 --branch -z --untracked-files=all`. Ignored (`!`) entries are left out. */
export function parseStatusV2(out: string): StatusReport {
  const report: StatusReport = { branch: undefined, head: undefined, upstream: undefined, ahead: 0, behind: 0, files: [] };
  const parts = out.split("\0");
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i] ?? "";
    if (p.startsWith("# branch.oid ")) {
      const oid = p.slice("# branch.oid ".length);
      if (oid !== "(initial)") report.head = oid;
    } else if (p.startsWith("# branch.head ")) {
      const head = p.slice("# branch.head ".length);
      if (head !== "(detached)") report.branch = head;
    } else if (p.startsWith("# branch.upstream ")) {
      report.upstream = p.slice("# branch.upstream ".length);
    } else if (p.startsWith("# branch.ab ")) {
      const m = /^\+(\d+) -(\d+)$/.exec(p.slice("# branch.ab ".length));
      if (m) {
        report.ahead = Number(m[1]);
        report.behind = Number(m[2]);
      }
    } else if (p.startsWith("1 ")) {
      // 1 XY sub mH mI mW hH hI path
      const fields = p.split(" ");
      const path = fields.slice(8).join(" ");
      report.files.push({ path, status: statusOfXY(fields[1] ?? "..") });
    } else if (p.startsWith("2 ")) {
      // 2 XY sub mH mI mW hH hI Xscore path, then the original path as the next part
      const fields = p.split(" ");
      const path = fields.slice(9).join(" ");
      const from = parts[++i] ?? "";
      const xy = fields[1] ?? "..";
      report.files.push(xy.includes("R") ? { path, status: "renamed", from } : { path, status: "added" });
    } else if (p.startsWith("u ")) {
      // u XY sub m1 m2 m3 mW h1 h2 h3 path: a merge conflict, still a change to the file
      report.files.push({ path: p.split(" ").slice(10).join(" "), status: "modified" });
    } else if (p.startsWith("? ")) {
      report.files.push({ path: p.slice(2), status: "untracked" });
    }
  }
  return report;
}

/** A tracked file's two status letters (index, work tree) as one word. */
function statusOfXY(xy: string): ChangeStatus {
  if (xy.includes("D")) return "deleted";
  if (xy[0] === "A") return "added";
  return "modified";
}

/** Lines added and taken out per path, from `git diff --numstat -z -M`; binary files have neither. */
export function parseNumstat(out: string): Map<string, { added?: number; removed?: number }> {
  const map = new Map<string, { added?: number; removed?: number }>();
  const parts = out.split("\0");
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i] ?? "";
    const m = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(p);
    if (!m) continue;
    let path = m[3] ?? "";
    // A rename is `added\tremoved\t` then the old path and the new one as their own parts.
    if (path === "") {
      i++;
      path = parts[++i] ?? "";
    }
    map.set(path, m[1] === "-" ? {} : { added: Number(m[1]), removed: Number(m[2]) });
  }
  return map;
}

/** The status's files with their counts, in git's order, untracked files' counts from `untrackedLines`. */
export function filesWithCounts(
  files: StatusReport["files"],
  numstat: Map<string, { added?: number; removed?: number }>,
  untrackedLines: Map<string, number | null>,
): ChangedFile[] {
  return files.map((f) => {
    const base: ChangedFile = { path: f.path, status: f.status, ...(f.from !== undefined ? { from: f.from } : {}) };
    if (f.status === "untracked") {
      const n = untrackedLines.get(f.path);
      return n === null || n === undefined ? base : { ...base, added: n, removed: 0 };
    }
    const c = numstat.get(f.path);
    return c?.added !== undefined ? { ...base, added: c.added, removed: c.removed ?? 0 } : c ? base : { ...base, added: 0, removed: 0 };
  });
}

/** How many lines a text file has, or null for a binary one (a NUL byte in what was read). */
export function linesIn(bytes: Buffer): number | null {
  if (bytes.includes(0)) return null;
  if (bytes.length === 0) return 0;
  let n = 0;
  for (const b of bytes) if (b === 10) n++;
  return bytes[bytes.length - 1] === 10 ? n : n + 1;
}

/** The format `git log` is run with: a record separator, then hash, commit time and subject. `--shortstat` follows. */
export const LOG_FORMAT = "--format=%x1e%H%x1f%cI%x1f%s";

export interface LoggedCommit {
  hash: string;
  at: string;
  subject: string;
  added: number;
  removed: number;
}

/** Reads `git log` run with `LOG_FORMAT` and `--shortstat`, newest first. */
export function parseLog(out: string): LoggedCommit[] {
  const commits: LoggedCommit[] = [];
  for (const record of out.split("\x1e")) {
    if (!record.trim()) continue;
    const [head = "", ...rest] = record.split("\n");
    const [hash = "", at = "", subject = ""] = head.split("\x1f");
    if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(hash)) continue;
    const stat = rest.join("\n");
    const added = Number(/(\d+) insertions?\(\+\)/.exec(stat)?.[1] ?? 0);
    const removed = Number(/(\d+) deletions?\(-\)/.exec(stat)?.[1] ?? 0);
    commits.push({ hash, at: new Date(at).toISOString(), subject: clip(subject, COMMIT_SUBJECT_MAX), added, removed });
  }
  return commits;
}

/** A commit's files from `git show --format= --name-status -z -M`, with counts from its `--numstat -z`. */
export function parseNameStatus(out: string, numstat: Map<string, { added?: number; removed?: number }>): ChangedFile[] {
  const files: ChangedFile[] = [];
  const parts = out.split("\0").filter((p, i, all) => p !== "" || i < all.length - 1);
  for (let i = 0; i < parts.length; i++) {
    const code = parts[i] ?? "";
    if (!/^[A-Z]/.test(code)) continue;
    let file: ChangedFile;
    if (code.startsWith("R") || code.startsWith("C")) {
      const from = parts[++i] ?? "";
      const path = parts[++i] ?? "";
      file = code.startsWith("R") ? { path, status: "renamed", from } : { path, status: "added" };
    } else {
      const path = parts[++i] ?? "";
      file = { path, status: code.startsWith("A") ? "added" : code.startsWith("D") ? "deleted" : "modified" };
    }
    const c = numstat.get(file.path);
    files.push(c?.added !== undefined ? { ...file, added: c.added, removed: c.removed ?? 0 } : file);
  }
  return files;
}

/** A unified diff as lines; or `binary` / `tooLong` with none. */
export function parseUnifiedDiff(out: string): { lines: DiffLine[]; binary?: true; tooLong?: true } {
  const lines: DiffLine[] = [];
  let oldNo = 0;
  let newNo = 0;
  let inHunk = false;
  for (const raw of out.split("\n")) {
    if (!inHunk && /^Binary files .* differ$/.test(raw)) return { lines: [], binary: true };
    if (raw.startsWith("@@")) {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
      if (!m) continue;
      oldNo = Number(m[1]);
      newNo = Number(m[2]);
      inHunk = true;
      lines.push({ kind: "hunk", text: clip(raw, DIFF_LINE_TEXT_MAX) });
    } else if (!inHunk) {
      continue;
    } else if (raw.startsWith("+")) {
      lines.push({ kind: "added", text: clip(raw.slice(1), DIFF_LINE_TEXT_MAX), new: newNo++ });
    } else if (raw.startsWith("-")) {
      lines.push({ kind: "removed", text: clip(raw.slice(1), DIFF_LINE_TEXT_MAX), old: oldNo++ });
    } else if (raw.startsWith(" ")) {
      lines.push({ kind: "context", text: clip(raw.slice(1), DIFF_LINE_TEXT_MAX), old: oldNo++, new: newNo++ });
    } else if (raw.startsWith("diff --git ")) {
      // A second file (a rename's or a type change's): its own header follows.
      inHunk = false;
    }
    // "\ No newline at end of file" and anything else is left out.
    if (lines.length > DIFF_LINES_MAX) return { lines: [], tooLong: true };
  }
  return { lines };
}

/** Why a `git push` failed, from what it wrote to stderr. */
export function pushFailureOf(stderr: string): PushFailure {
  if (/\[rejected\]|non-fast-forward|fetch first|Updates were rejected/i.test(stderr)) return "behind";
  if (/Authentication failed|could not read (Username|Password)|terminal prompts disabled|Permission denied|access denied|403|401|invalid credentials|Host key verification failed/i.test(stderr)) return "auth";
  return "other";
}

/** git's first line that says something, without `fatal:` or `error:`; for a push that failed as `other`. */
export function firstGitLine(stderr: string): string | undefined {
  for (const line of stderr.split("\n")) {
    const t = line.replace(/^(fatal|error|remote):\s*/i, "").trim();
    if (t && !t.startsWith("hint:") && !t.startsWith("To ")) return clip(t, 300);
  }
  return undefined;
}

/** The sentence of a push card (PROTOCOL.md "Changes", "The push card"). */
export function pushText(push: { upstream: string; commits: number } | { upstream: string | undefined; failed: PushFailure; detail?: string | undefined }): string {
  if (!("failed" in push)) return `Pushed ${push.commits} commit${push.commits === 1 ? "" : "s"} to ${push.upstream}`;
  const to = push.upstream ? ` to ${push.upstream}` : "";
  switch (push.failed) {
    case "behind":
      return `Push rejected: ${push.upstream ?? "the remote"} has commits this branch doesn't have. Nothing was pushed.`;
    case "auth":
      return `Push${to} failed: git couldn't sign in on this computer. Nothing was pushed.`;
    case "other":
      return `Push${to} failed${push.detail ? `: ${push.detail}` : ""}. Nothing was pushed.`;
  }
}

/** The remote a branch with no upstream would go to: `origin` when there is one, else the only remote. */
export function pushRemoteOf(remotes: readonly string[]): string | undefined {
  if (remotes.includes("origin")) return "origin";
  return remotes.length === 1 ? remotes[0] : undefined;
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max - 1) + "…";
}
