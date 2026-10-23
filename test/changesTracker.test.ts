import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ActivityEntry, SessionChanges } from "@grenade/protocol";
import { ChangesError, ChangesTracker } from "../src/changes/changesTracker.js";
import { workOfHook } from "../src/changes/sessionWork.js";
import { silentLogger } from "../src/log.js";

/** A real repository cloned from a bare one, so pushes are real; git runs with a fixed author. */
function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@example.com", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
}

let root: string;
let remote: string;
let work: string;
let other: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "grenade-changes-"));
  remote = join(root, "remote.git");
  work = join(root, "work");
  other = join(root, "other");
  git(root, "init", "-q", "--bare", "-b", "main", remote);
  git(root, "clone", "-q", remote, work);
  git(work, "checkout", "-q", "-b", "main");
  writeFileSync(join(work, "a.txt"), "one\ntwo\n");
  git(work, "add", "a.txt");
  git(work, "commit", "-q", "-m", "First");
  git(work, "push", "-q", "-u", "origin", "main");
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

/** A tracker for sessions that all work in `work` (gr-x unless more are named). */
function setup(ids: string[] = ["gr-x"]) {
  const shown: (SessionChanges | undefined)[] = [];
  const pushes: ActivityEntry[] = [];
  const pushesOf = new Map<string, ActivityEntry[]>(ids.map((id) => [id, []]));
  const bases = new Map<string, string>();
  const tracker = new ChangesTracker({
    registry: {
      liveIds: () => ids,
      get: (id) => (ids.includes(id) ? { cwd: work } : undefined),
      setChanges: (id, c) => {
        if (id === ids[0]) shown.push(c);
      },
      gitBaseOf: (id) => bases.get(id),
      setGitBase: (id, h) => bases.set(id, h),
    },
    activity: {
      notePush: (id, e) => {
        if (id === ids[0]) pushes.push(e);
        pushesOf.get(id)?.push(e);
      },
    },
    log: silentLogger,
    now: () => Date.parse("2026-10-09T10:00:00Z"),
  });
  /** The session's agent writes a file in `work`, through its `Write` tool, as its hook reports it. */
  const wrote = (file: string, content: string, id = ids[0]!) => {
    writeFileSync(join(work, file), content);
    tracker.noteHook(id, workOfHook("PostToolUse", "Write", { file_path: join(work, file), content }, undefined, work));
  };
  return { tracker, shown, pushes, pushesOf, wrote, last: () => shown.at(-1), base: () => bases.get(ids[0]!) };
}

describe("ChangesTracker", () => {
  it("follows a session's work from changed to committed to pushed, with a card", async () => {
    const { tracker, last, pushes, base, wrote } = setup();
    await tracker.refresh("gr-x");
    expect(last()).toEqual({ branch: "main", upstream: "origin/main", remote: "origin", repo: "work", worktree: realpathSync(work), ahead: 0, behind: 0, commits: 0, files: 0, added: 0, removed: 0 });
    expect(base()).toMatch(/^[0-9a-f]{40}$/);

    wrote("a.txt", "one\n2\nthree\n");
    wrote("b.txt", "new\n");
    await tracker.refresh("gr-x");
    expect(last()).toMatchObject({ files: 2, added: 3, removed: 1, ahead: 0 });

    const frame = await tracker.files("gr-x", undefined);
    expect(frame.files).toEqual([
      { path: "a.txt", status: "modified", added: 2, removed: 1 },
      { path: "b.txt", status: "untracked", added: 1, removed: 0 },
    ]);
    const diff = await tracker.diff("gr-x", "b.txt", undefined);
    expect(diff.lines).toEqual([{ kind: "hunk", text: "@@ -0,0 +1 @@" }, { kind: "added", text: "new", new: 1 }]);

    git(work, "add", ".");
    git(work, "commit", "-q", "-m", "Second");
    await tracker.refresh("gr-x");
    expect(last()).toMatchObject({ files: 0, ahead: 1, commits: 1 });
    const commits = (await tracker.files("gr-x", undefined)).commits ?? [];
    expect(commits.map((c) => [c.subject, c.pushed])).toEqual([["Second", false]]);
    const commitFiles = await tracker.files("gr-x", commits[0]!.hash);
    expect(commitFiles.files.map((f) => f.path)).toEqual(["a.txt", "b.txt"]);

    await tracker.push("gr-x");
    expect(last()).toMatchObject({ ahead: 0, commits: 0 });
    expect(pushes).toEqual([
      { kind: "push", text: "Pushed 1 commit to origin/main", at: "2026-10-09T10:00:00.000Z", upstream: "origin/main", commits: [{ hash: commits[0]!.hash.slice(0, 7), subject: "Second" }] },
    ]);
    tracker.stop();
  });

  it("shows pushing while git runs", async () => {
    const { tracker, shown } = setup();
    await tracker.refresh("gr-x");
    writeFileSync(join(work, "c.txt"), "c\n");
    git(work, "add", ".");
    git(work, "commit", "-q", "-m", "C");
    await tracker.push("gr-x");
    expect(shown.some((c) => c?.pushing === true)).toBe(true);
    expect(shown.at(-1)?.pushing).toBeUndefined();
    tracker.stop();
  });

  it("adds a card when the agent pushes by itself", async () => {
    const { tracker, pushes, wrote } = setup();
    await tracker.refresh("gr-x");
    wrote("d.txt", "d\n");
    git(work, "add", ".");
    git(work, "commit", "-q", "-m", "D");
    await tracker.refresh("gr-x");
    git(work, "push", "-q");
    await tracker.refresh("gr-x");
    expect(pushes.map((p) => p.text)).toEqual(["Pushed 1 commit to origin/main"]);
    tracker.stop();
  });

  it("records a push the remote rejects, and pushes nothing", async () => {
    const { tracker, pushes, last } = setup();
    await tracker.refresh("gr-x");
    // Someone else pushes first.
    git(root, "clone", "-q", remote, other);
    writeFileSync(join(other, "e.txt"), "e\n");
    git(other, "add", ".");
    git(other, "commit", "-q", "-m", "Theirs");
    git(other, "push", "-q");
    writeFileSync(join(work, "f.txt"), "f\n");
    git(work, "add", ".");
    git(work, "commit", "-q", "-m", "Mine");
    await tracker.push("gr-x");
    expect(pushes).toHaveLength(1);
    expect(pushes[0]).toMatchObject({ kind: "push", upstream: "origin/main", failed: "behind" });
    expect(last()).toMatchObject({ ahead: 1 });
    tracker.stop();
  });

  it("refuses a push with nothing to push, and a folder outside git", async () => {
    const { tracker } = setup();
    await expect(tracker.push("gr-x")).rejects.toBeInstanceOf(ChangesError);
    const outside = mkdtempSync(join(tmpdir(), "grenade-plain-"));
    const t2 = new ChangesTracker({
      registry: { liveIds: () => [], get: () => ({ cwd: outside }), setChanges: () => {}, gitBaseOf: () => undefined, setGitBase: () => {} },
      activity: { notePush: () => {} },
      log: silentLogger,
    });
    await expect(t2.files("gr-y", undefined)).rejects.toBeInstanceOf(ChangesError);
    rmSync(outside, { recursive: true, force: true });
    tracker.stop();
  });

  it("counts commits on a branch with no upstream, and pushes it to its remote", async () => {
    const { tracker, last, pushes, wrote } = setup();
    git(work, "checkout", "-q", "-b", "feature/x");
    await tracker.refresh("gr-x");
    wrote("g.txt", "g\n");
    git(work, "add", ".");
    git(work, "commit", "-q", "-m", "G");
    await tracker.refresh("gr-x");
    expect(last()).toEqual({ branch: "feature/x", remote: "origin", repo: "work", worktree: realpathSync(work), ahead: 0, behind: 0, commits: 1, files: 0, added: 0, removed: 0 });
    await tracker.push("gr-x");
    expect(last()).toMatchObject({ upstream: "origin/feature/x", ahead: 0 });
    expect(pushes.map((p) => p.text)).toEqual(["Pushed 1 commit to origin/feature/x"]);
    tracker.stop();
  });

  it("names the repository a linked worktree belongs to, and the worktree's own folder", async () => {
    const tree = join(root, "work-tree");
    git(work, "worktree", "add", "-q", "-b", "feature/y", tree);
    const shown: (SessionChanges | undefined)[] = [];
    const tracker = new ChangesTracker({
      registry: { liveIds: () => ["gr-w"], get: () => ({ cwd: tree }), setChanges: (_, c) => shown.push(c), gitBaseOf: () => undefined, setGitBase: () => {} },
      activity: { notePush: () => {} },
      log: silentLogger,
    });
    await tracker.refresh("gr-w");
    expect(shown.at(-1)).toMatchObject({ branch: "feature/y", repo: "work", worktree: realpathSync(tree), linked: true });
    tracker.stop();
  });

  describe("several sessions on one branch", () => {
    it("gives the push card only to the session whose work the pushed commits carry", async () => {
      const { tracker, pushesOf, wrote } = setup(["gr-x", "gr-y"]);
      await Promise.all([tracker.refresh("gr-x"), tracker.refresh("gr-y")]);
      wrote("x.txt", "export const fromX = 1;\n", "gr-x");
      wrote("y.txt", "export const fromY = 2;\n", "gr-y");
      git(work, "add", "x.txt");
      git(work, "commit", "-q", "-m", "X's work");
      await Promise.all([tracker.refresh("gr-x"), tracker.refresh("gr-y")]);
      git(work, "push", "-q");
      await Promise.all([tracker.refresh("gr-x"), tracker.refresh("gr-y")]);
      expect(pushesOf.get("gr-x")!.map((p) => p.text)).toEqual(["Pushed 1 commit to origin/main"]);
      expect(pushesOf.get("gr-y")).toEqual([]);

      // Y's work is pushed later: now it is Y's push, and X's work is not in it.
      git(work, "add", "y.txt");
      git(work, "commit", "-q", "-m", "Y's work");
      await Promise.all([tracker.refresh("gr-x"), tracker.refresh("gr-y")]);
      git(work, "push", "-q");
      await Promise.all([tracker.refresh("gr-x"), tracker.refresh("gr-y")]);
      expect(pushesOf.get("gr-x")).toHaveLength(1);
      expect(pushesOf.get("gr-y")!.map((p) => p.commits?.map((c) => c.subject))).toEqual([["Y's work"]]);
      tracker.stop();
    });

    it("gives it to both when one session commits the other's work too", async () => {
      const { tracker, pushesOf, wrote } = setup(["gr-x", "gr-y"]);
      await Promise.all([tracker.refresh("gr-x"), tracker.refresh("gr-y")]);
      wrote("x.txt", "export const fromX = 1;\n", "gr-x");
      wrote("y.txt", "export const fromY = 2;\n", "gr-y");
      git(work, "add", ".");
      git(work, "commit", "-q", "-m", "Both");
      await Promise.all([tracker.refresh("gr-x"), tracker.refresh("gr-y")]);
      await tracker.push("gr-x");
      await tracker.refresh("gr-y");
      expect(pushesOf.get("gr-x")).toHaveLength(1);
      expect(pushesOf.get("gr-y")).toHaveLength(1);
      tracker.stop();
    });

    it("tells two sessions' lines in one file apart", async () => {
      const { tracker, pushesOf, wrote } = setup(["gr-x", "gr-y"]);
      await Promise.all([tracker.refresh("gr-x"), tracker.refresh("gr-y")]);
      wrote("a.txt", "one\ntwo\nadded by x\n", "gr-x");
      git(work, "commit", "-q", "-am", "X edits a.txt");
      await Promise.all([tracker.refresh("gr-x"), tracker.refresh("gr-y")]);
      // Y edits the same file afterwards, and does not commit.
      writeFileSync(join(work, "a.txt"), "one\ntwo\nadded by x\nadded by y\n");
      tracker.noteHook("gr-y", workOfHook("PostToolUse", "Edit", { file_path: join(work, "a.txt"), old_string: "added by x", new_string: "added by x\nadded by y" }, undefined, work));
      git(work, "push", "-q");
      await Promise.all([tracker.refresh("gr-x"), tracker.refresh("gr-y")]);
      expect(pushesOf.get("gr-x")).toHaveLength(1);
      expect(pushesOf.get("gr-y")).toEqual([]);
      tracker.stop();
    });

    it("counts a commit the session's agent made, whatever wrote its files", async () => {
      const { tracker, pushesOf } = setup(["gr-x", "gr-y"]);
      await Promise.all([tracker.refresh("gr-x"), tracker.refresh("gr-y")]);
      // A script wrote the file (no Write hook); the agent's Bash ran `git commit`.
      writeFileSync(join(work, "s.txt"), "made by a script\n");
      git(work, "add", ".");
      const out = git(work, "commit", "-m", "Scripted");
      tracker.noteHook("gr-y", workOfHook("PostToolUse", "Bash", { command: "git add . && git commit -m Scripted" }, { stdout: out, stderr: "" }, work));
      await Promise.all([tracker.refresh("gr-x"), tracker.refresh("gr-y")]);
      git(work, "push", "-q");
      await Promise.all([tracker.refresh("gr-x"), tracker.refresh("gr-y")]);
      expect(pushesOf.get("gr-x")).toEqual([]);
      expect(pushesOf.get("gr-y")).toHaveLength(1);
      tracker.stop();
    });
  });
});
