import { describe, expect, it } from "vitest";
import { addedLinesOf } from "../src/changes/gitParse.js";
import { committedIn, patchWorkOf, SessionWork, workLine, workOfHook } from "../src/changes/sessionWork.js";

describe("workOfHook", () => {
  it("takes the lines a Write, Edit or MultiEdit added, never the ones an edit repeats around the change", () => {
    expect(workOfHook("PostToolUse", "Write", { file_path: "/r/a.ts", content: "const a = 1;\n}\n" }, undefined, "/r").files).toEqual([{ path: "/r/a.ts", lines: ["const a = 1;"] }]);
    expect(workOfHook("PostToolUse", "Edit", { file_path: "b.ts", old_string: "keep this\nold line", new_string: "keep this\nnew line" }, undefined, "/r").files).toEqual([
      { path: "/r/b.ts", lines: ["new line"] },
    ]);
    const multi = workOfHook("PostToolUse", "MultiEdit", { file_path: "/r/c.ts", edits: [{ old_string: "a1", new_string: "first new" }, { old_string: "b", new_string: "second new" }] }, undefined, "/r");
    expect(multi.files).toEqual([{ path: "/r/c.ts", lines: ["first new", "second new"] }]);
  });

  it("prefers the patch Claude Code's response carries", () => {
    const response = { structuredPatch: [{ lines: [" around", "-gone", "+really added"] }] };
    expect(workOfHook("PostToolUse", "Edit", { file_path: "/r/a.ts", old_string: "x", new_string: "around\nreally added" }, response, "/r").files).toEqual([
      { path: "/r/a.ts", lines: ["really added"] },
    ]);
  });

  it("reads a Codex patch per file", () => {
    const patch = ["*** Begin Patch", "*** Update File: src/a.ts", "@@", " context", "-old", "+the new line", "*** Add File: b.ts", "+fresh file", "*** Delete File: c.ts", "*** End Patch"].join("\n");
    expect(patchWorkOf(patch)).toEqual([
      { path: "src/a.ts", added: "the new line" },
      { path: "b.ts", added: "fresh file" },
      { path: "c.ts", added: "" },
    ]);
    expect(workOfHook("PostToolUse", "apply_patch", { input: patch }, undefined, "/r").files.map((f) => f.path)).toEqual(["/r/src/a.ts", "/r/b.ts", "/r/c.ts"]);
  });

  it("finds the commits git commit printed, only for a command that commits", () => {
    const stdout = "[main 3bf2095] Fix it\n 1 file changed\n";
    expect(workOfHook("PostToolUse", "Bash", { command: "git commit -m 'Fix it'" }, { stdout }, "/r").commits).toEqual(["3bf2095"]);
    expect(workOfHook("PostToolUse", "Bash", { command: "cat log.txt" }, { stdout }, "/r").commits).toEqual([]);
    expect(committedIn({ stdout: "[feature/x (root-commit) abcdef1] First" })).toEqual(["abcdef1"]);
    expect(committedIn({ stdout: "0\n    /// one of the tools [`ToolboxTab` abcdef1] in a doc comment" })).toEqual([]);
    expect(committedIn("[detached HEAD 967858b] Design card")).toEqual(["967858b"]);
  });

  it("ignores anything but a PostToolUse", () => {
    expect(workOfHook("PreToolUse", "Write", { file_path: "/r/a.ts", content: "something" }, undefined, "/r")).toEqual({ files: [], commits: [] });
  });

  it("keeps only lines that tell work apart", () => {
    expect([workLine("  }  "), workLine(");"), workLine(""), workLine("  return x;  ")]).toEqual([null, null, null, "return x;"]);
  });
});

describe("addedLinesOf", () => {
  it("reads each file's added lines, and a deleted file with none", () => {
    const diff = [
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1 +1,2 @@",
      "-old",
      "+new one",
      "+++ looks like a header",
      "diff --git a/gone.ts b/gone.ts",
      "--- a/gone.ts",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-bye",
    ].join("\n");
    expect(addedLinesOf(diff)).toEqual(
      new Map([
        ["src/a.ts", ["new one", "++ looks like a header"]],
        ["gone.ts", []],
      ]),
    );
  });
});

describe("SessionWork", () => {
  it("owns a commit that adds its lines, then forgets them", () => {
    const work = new SessionWork();
    work.add({ files: [{ path: "/r/a.ts", lines: ["mine here"] }], commits: [] });
    expect(work.take({ hash: "1".repeat(40), files: new Map([["a.ts", ["someone else's"]]]) })).toBe(false);
    expect(work.take({ hash: "2".repeat(40), files: new Map([["a.ts", ["  mine here"]]]) })).toBe(true);
    expect(work.take({ hash: "3".repeat(40), files: new Map([["a.ts", ["mine here"]]]) })).toBe(false);
  });

  it("owns a commit it made, and one touching a file it changed without a line to match", () => {
    const work = new SessionWork();
    work.add({ files: [{ path: "/r/b.ts", lines: [] }], commits: ["abcdef1"] });
    expect(work.take({ hash: "abcdef1" + "0".repeat(33), files: new Map() })).toBe(true);
    expect(work.take({ hash: "4".repeat(40), files: new Map([["other/b.ts", ["x"]]]) })).toBe(false);
    expect(work.take({ hash: "5".repeat(40), files: new Map([["b.ts", []]]) })).toBe(true);
  });
});
