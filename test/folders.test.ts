import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { expandHome, listFolders, shownFolders } from "../src/folders/listFolders.js";

describe("expandHome", () => {
  it("expands ~ and ~/ only", () => {
    expect(expandHome("~", "/Users/a")).toBe("/Users/a");
    expect(expandHome("~/code", "/Users/a")).toBe("/Users/a/code");
    expect(expandHome("/tmp", "/Users/a")).toBe("/tmp");
    expect(expandHome("~bob", "/Users/a")).toBe("~bob");
  });
});

describe("shownFolders", () => {
  it("drops hidden names, sorts like Finder and caps", () => {
    expect(shownFolders(["b", ".git", "A", "app10", "app9"]).folders).toEqual(["A", "app9", "app10", "b"]);
    expect(shownFolders(["a", "b", "c"], 2)).toEqual({ folders: ["a", "b"], truncated: true });
  });
});

describe("listFolders", () => {
  const home = mkdtempSync(join(tmpdir(), "grenade-folders-"));
  mkdirSync(join(home, "code", "app"), { recursive: true });
  mkdirSync(join(home, "code", ".hidden"));
  writeFileSync(join(home, "code", "notes.txt"), "x");
  symlinkSync(join(home, "code", "app"), join(home, "code", "linked"));
  symlinkSync(join(home, "code", "notes.txt"), join(home, "code", "file-link"));

  it("lists folders and links to folders, never files", async () => {
    expect(await listFolders("~/code", home)).toEqual({ type: "folders", path: "~/code", folders: ["app", "linked"] });
  });
  it("says missing for a file or a folder that is not there", async () => {
    expect(await listFolders("~/code/notes.txt", home)).toMatchObject({ folders: [], missing: true });
    expect(await listFolders("~/nope", home)).toMatchObject({ path: "~/nope", folders: [], missing: true });
  });
});
