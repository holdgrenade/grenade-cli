import { describe, expect, it } from "vitest";
import { commitPageOf, filesWithCounts, linesIn, parseLog, parseNameStatus, parseNumstat, parseStatusV2, parseUnifiedDiff, pushFailureOf, pushRemoteOf, pushText, remoteOfRef } from "../src/changes/gitParse.js";

describe("parseStatusV2", () => {
  it("reads the branch, its upstream and the files", () => {
    const out = [
      "# branch.oid 1111111111111111111111111111111111111111",
      "# branch.head main",
      "# branch.upstream origin/main",
      "# branch.ab +2 -1",
      "1 .M N... 100644 100644 100644 aaa bbb src/a file.ts",
      "1 A. N... 000000 100644 100644 000 ccc src/new.ts",
      "1 .D N... 100644 100644 000000 aaa aaa src/gone.ts",
      "2 R. N... 100644 100644 100644 aaa aaa R100 src/b.ts",
      "src/old-b.ts",
      "? notes.md",
      "! build/out.js",
      "",
    ].join("\0");
    expect(parseStatusV2(out)).toEqual({
      branch: "main",
      head: "1111111111111111111111111111111111111111",
      upstream: "origin/main",
      ahead: 2,
      behind: 1,
      files: [
        { path: "src/a file.ts", status: "modified" },
        { path: "src/new.ts", status: "added" },
        { path: "src/gone.ts", status: "deleted" },
        { path: "src/b.ts", status: "renamed", from: "src/old-b.ts" },
        { path: "notes.md", status: "untracked" },
      ],
    });
  });

  it("says nothing of a branch on a detached HEAD or in a new repository", () => {
    const r = parseStatusV2(["# branch.oid (initial)", "# branch.head (detached)", ""].join("\0"));
    expect(r.branch).toBeUndefined();
    expect(r.head).toBeUndefined();
    expect(r.upstream).toBeUndefined();
  });
});

describe("parseNumstat and filesWithCounts", () => {
  it("counts lines, leaves binary files without, and reads renames", () => {
    const out = ["6\t1\tsrc/a file.ts", "-\t-\timg.png", "3\t3\t", "src/old-b.ts", "src/b.ts", ""].join("\0");
    const map = parseNumstat(out);
    expect(map.get("src/a file.ts")).toEqual({ added: 6, removed: 1 });
    expect(map.get("img.png")).toEqual({});
    expect(map.get("src/b.ts")).toEqual({ added: 3, removed: 3 });
    const files = filesWithCounts(
      [
        { path: "src/a file.ts", status: "modified" },
        { path: "img.png", status: "added" },
        { path: "src/b.ts", status: "renamed", from: "src/old-b.ts" },
        { path: "notes.md", status: "untracked" },
        { path: "blob.bin", status: "untracked" },
      ],
      map,
      new Map([["notes.md", 4], ["blob.bin", null]]),
    );
    expect(files).toEqual([
      { path: "src/a file.ts", status: "modified", added: 6, removed: 1 },
      { path: "img.png", status: "added" },
      { path: "src/b.ts", status: "renamed", from: "src/old-b.ts", added: 3, removed: 3 },
      { path: "notes.md", status: "untracked", added: 4, removed: 0 },
      { path: "blob.bin", status: "untracked" },
    ]);
  });
});

describe("linesIn", () => {
  it("counts lines with or without a last newline, and knows a binary file", () => {
    expect(linesIn(Buffer.from("a\nb\n"))).toBe(2);
    expect(linesIn(Buffer.from("a\nb"))).toBe(2);
    expect(linesIn(Buffer.from(""))).toBe(0);
    expect(linesIn(Buffer.from([1, 0, 2]))).toBeNull();
  });
});

describe("parseLog", () => {
  it("reads hashes, times, subjects and line counts", () => {
    const h1 = "a".repeat(40);
    const h2 = "b".repeat(40);
    const out = `\x1e${h1}\x1f2026-10-09T11:12:00+02:00\x1fChanges view\n\n 4 files changed, 230 insertions(+), 12 deletions(-)\n\x1e${h2}\x1f2026-10-09T09:04:00Z\x1fOne line\n\n 1 file changed, 1 insertion(+)\n`;
    expect(parseLog(out)).toEqual([
      { hash: h1, at: "2026-10-09T09:12:00.000Z", subject: "Changes view", added: 230, removed: 12 },
      { hash: h2, at: "2026-10-09T09:04:00.000Z", subject: "One line", added: 1, removed: 0 },
    ]);
  });
});

describe("parseNameStatus", () => {
  it("reads a commit's files with their counts", () => {
    const out = ["M", "src/a.ts", "A", "src/new.ts", "R087", "src/old.ts", "src/moved.ts", "D", "gone.txt", ""].join("\0");
    const counts = new Map([["src/a.ts", { added: 2, removed: 1 }], ["src/new.ts", { added: 9, removed: 0 }], ["src/moved.ts", { added: 1, removed: 1 }]]);
    expect(parseNameStatus(out, counts)).toEqual([
      { path: "src/a.ts", status: "modified", added: 2, removed: 1 },
      { path: "src/new.ts", status: "added", added: 9, removed: 0 },
      { path: "src/moved.ts", status: "renamed", from: "src/old.ts", added: 1, removed: 1 },
      { path: "gone.txt", status: "deleted" },
    ]);
  });
});

describe("parseUnifiedDiff", () => {
  it("numbers the lines of each hunk", () => {
    const out = [
      "diff --git a/x.swift b/x.swift",
      "index 1..2 100644",
      "--- a/x.swift",
      "+++ b/x.swift",
      "@@ -5,3 +5,3 @@ enum Mode",
      "     case terminal",
      "-    case old",
      "+    case changes",
      "\\ No newline at end of file",
      "",
    ].join("\n");
    expect(parseUnifiedDiff(out)).toEqual({
      lines: [
        { kind: "hunk", text: "@@ -5,3 +5,3 @@ enum Mode" },
        { kind: "context", text: "    case terminal", old: 5, new: 5 },
        { kind: "removed", text: "    case old", old: 6 },
        { kind: "added", text: "    case changes", new: 6 },
      ],
    });
  });

  it("says binary for a binary file, and too long past the limit", () => {
    expect(parseUnifiedDiff("diff --git a/i.png b/i.png\nBinary files a/i.png and b/i.png differ\n")).toEqual({ lines: [], binary: true });
    const long = ["@@ -1,0 +1,4000 @@", ...Array.from({ length: 4000 }, (_, i) => `+line ${i}`)].join("\n");
    expect(parseUnifiedDiff(long)).toEqual({ lines: [], tooLong: true });
  });
});

describe("pushes", () => {
  it("knows why a push failed", () => {
    expect(pushFailureOf(" ! [rejected]        main -> main (fetch first)\nerror: failed to push some refs")).toBe("behind");
    expect(pushFailureOf("fatal: could not read Username for 'https://github.com': terminal prompts disabled")).toBe("auth");
    expect(pushFailureOf("git@github.com: Permission denied (publickey).")).toBe("auth");
    expect(pushFailureOf("fatal: 'nowhere' does not appear to be a git repository")).toBe("other");
  });

  it("words the card", () => {
    expect(pushText({ upstream: "origin/main", commits: 1 })).toBe("Pushed 1 commit to origin/main");
    expect(pushText({ upstream: "origin/main", commits: 2 })).toBe("Pushed 2 commits to origin/main");
    expect(pushText({ upstream: "origin/main", failed: "behind" })).toBe("Push rejected: origin/main has commits this branch doesn't have. Nothing was pushed.");
    expect(pushText({ upstream: undefined, failed: "other", detail: "no route" })).toBe("Push failed: no route. Nothing was pushed.");
  });

  it("picks the remote a new branch goes to", () => {
    expect(pushRemoteOf(["upstream", "origin"])).toBe("origin");
    expect(pushRemoteOf(["fork"])).toBe("fork");
    expect(pushRemoteOf(["a", "b"])).toBeUndefined();
    expect(pushRemoteOf([])).toBeUndefined();
  });
});

describe("commitPageOf", () => {
  const h = "a1f3c9e0b2d4f6a8c0e2b4d6f8a0c2e4b6d8f0a2";
  it("reads every form of a GitHub remote", () => {
    for (const url of ["git@github.com:owner/repo.git", "https://github.com/owner/repo.git", "https://github.com/owner/repo", "ssh://git@github.com/owner/repo.git", "https://github.com/owner/repo.git/\n"]) {
      expect(commitPageOf(url, h)).toBe(`https://github.com/owner/repo/commit/${h}`);
    }
  });
  it("never keeps a user name or token", () => {
    expect(commitPageOf("https://x-access-token:ghp_secret@github.com/owner/repo.git", h)).toBe(`https://github.com/owner/repo/commit/${h}`);
  });
  it("knows GitLab, with subgroups, and Bitbucket", () => {
    expect(commitPageOf("git@gitlab.com:group/sub/repo.git", h)).toBe(`https://gitlab.com/group/sub/repo/-/commit/${h}`);
    expect(commitPageOf("https://bitbucket.org/owner/repo.git", h)).toBe(`https://bitbucket.org/owner/repo/commits/${h}`);
  });
  it("has none for another host, a local path, or an odd path", () => {
    expect(commitPageOf("git@example.com:owner/repo.git", h)).toBeUndefined();
    expect(commitPageOf("/tmp/remote.git", h)).toBeUndefined();
    expect(commitPageOf("file:///tmp/remote.git", h)).toBeUndefined();
    expect(commitPageOf("https://github.com/owner", h)).toBeUndefined();
    expect(commitPageOf("https://github.com/owner/repo%3Fx", h)).toBeUndefined();
    expect(commitPageOf("https://github.com/owner/repo.git", "not-a-hash")).toBeUndefined();
  });
});

describe("remoteOfRef", () => {
  it("takes the longest remote the ref starts with", () => {
    expect(remoteOfRef("origin/main", ["origin", "fork"])).toBe("origin");
    expect(remoteOfRef("me/fork/main", ["me", "me/fork"])).toBe("me/fork");
    expect(remoteOfRef("main", ["origin"])).toBeUndefined();
  });
});
