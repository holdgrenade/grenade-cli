import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { moveToLinuxTrash, trashDir, trashInfo, trashName } from "../src/conversations/linuxTrash.js";

describe("the Trash's layout", () => {
  it("is in the data home, XDG's when it is set", () => {
    expect(trashDir({}, "/home/adam")).toBe("/home/adam/.local/share/Trash");
    expect(trashDir({ XDG_DATA_HOME: "/data" }, "/home/adam")).toBe("/data/Trash");
    expect(trashDir({ XDG_DATA_HOME: "relative" }, "/home/adam")).toBe("/home/adam/.local/share/Trash");
  });

  it("writes where a file came from, escaped, and when it went, in local time", () => {
    const at = new Date(2026, 9, 3, 14, 5, 9);
    expect(trashInfo("/home/adam/.claude/projects/my app/a b.jsonl", at)).toBe(
      "[Trash Info]\nPath=/home/adam/.claude/projects/my%20app/a%20b.jsonl\nDeletionDate=2026-10-03T14:05:09\n",
    );
  });

  it("names a second file of the same name apart", () => {
    expect(trashName("/x/abc.jsonl", 1)).toBe("abc.jsonl");
    expect(trashName("/x/abc.jsonl", 2)).toBe("abc.jsonl.2");
  });
});

describe("moveToLinuxTrash", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "grenade-trash-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("moves a file and a folder, each with its info", () => {
    const file = join(dir, "abc.jsonl");
    const folder = join(dir, "abc");
    writeFileSync(file, "transcript");
    mkdirSync(folder);
    writeFileSync(join(folder, "inside"), "x");
    const trash = join(dir, "Trash");

    moveToLinuxTrash([file, folder], trash, () => new Date(2026, 9, 3, 14, 5, 9));

    expect(existsSync(file)).toBe(false);
    expect(existsSync(folder)).toBe(false);
    expect(readFileSync(join(trash, "files", "abc.jsonl"), "utf8")).toBe("transcript");
    expect(readFileSync(join(trash, "files", "abc", "inside"), "utf8")).toBe("x");
    expect(readFileSync(join(trash, "info", "abc.jsonl.trashinfo"), "utf8")).toContain(`Path=${file}\n`);
    expect(existsSync(join(trash, "info", "abc.trashinfo"))).toBe(true);
  });

  it("never overwrites what the Trash already holds", () => {
    const trash = join(dir, "Trash");
    for (const text of ["first", "second"]) {
      writeFileSync(join(dir, "abc.jsonl"), text);
      moveToLinuxTrash([join(dir, "abc.jsonl")], trash);
    }
    expect(readFileSync(join(trash, "files", "abc.jsonl"), "utf8")).toBe("first");
    expect(readFileSync(join(trash, "files", "abc.jsonl.2"), "utf8")).toBe("second");
    expect(existsSync(join(trash, "info", "abc.jsonl.2.trashinfo"))).toBe(true);
  });

  it("leaves no info behind for a file that could not be moved", () => {
    const trash = join(dir, "Trash");
    expect(() => moveToLinuxTrash([join(dir, "missing.jsonl")], trash)).toThrow();
    expect(existsSync(join(trash, "info", "missing.jsonl.trashinfo"))).toBe(false);
  });
});
