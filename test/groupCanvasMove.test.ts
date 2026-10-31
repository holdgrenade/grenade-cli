import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { GroupsFrame, KeptGroup, Session } from "@grenade/protocol";
import { CanvasMoveError, moveGroupCanvases } from "../src/canvas/canvasMove.js";
import { GroupCanvasMover } from "../src/canvas/groupCanvasMover.js";
import { movedRecord, type PublishRecord } from "../src/publish/publishPlan.js";
import { silentLogger } from "../src/log.js";
import { UnknownGroupError } from "../src/sessions/registry.js";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "grenade-canvas-move-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function project(name: string): Promise<string> {
  const path = join(root, name);
  await mkdir(path, { recursive: true });
  return path;
}

async function board(cwd: string, group: string, canvas: string, file: string): Promise<void> {
  const folder = join(cwd, ".grenade/canvas", group, canvas);
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, file), "<title>Board</title>");
}

describe("moveGroupCanvases", () => {
  it("moves the group's folder with every canvas, and leaves the shared boards", async () => {
    const from = await project("a");
    const to = await project("b");
    await board(from, "g-1", "canvas-1", "R1A · One.html");
    await board(from, "g-1", "canvas-2", "R1A · Two.html");
    await writeFile(join(from, ".grenade/canvas/Shared.html"), "<title>Shared</title>");
    expect(await moveGroupCanvases(from, to, "g-1")).toBe(true);
    expect((await readdir(join(to, ".grenade/canvas/g-1"))).sort()).toEqual(["canvas-1", "canvas-2"]);
    expect(await readFile(join(to, ".grenade/canvas/g-1/canvas-2/R1A · Two.html"), "utf8")).toContain("Board");
    expect(await readdir(join(from, ".grenade/canvas"))).toEqual(["Shared.html"]);
  });

  it("moves nothing for a group with no folder yet", async () => {
    const from = await project("a");
    const to = await project("b");
    expect(await moveGroupCanvases(from, to, "g-1")).toBe(false);
    expect(await readdir(to)).toEqual([]);
  });

  it("never moves over a folder of the group's that is there already", async () => {
    const from = await project("a");
    const to = await project("b");
    await board(from, "g-1", "canvas-1", "R1A.html");
    await board(to, "g-1", "canvas-1", "R9A.html");
    await expect(moveGroupCanvases(from, to, "g-1")).rejects.toBeInstanceOf(CanvasMoveError);
    expect(await readdir(join(from, ".grenade/canvas/g-1"))).toEqual(["canvas-1"]);
    expect(await readdir(join(to, ".grenade/canvas/g-1/canvas-1"))).toEqual(["R9A.html"]);
  });

  it("refuses a folder that is not there, and links at either end", async () => {
    const from = await project("a");
    await board(from, "g-1", "canvas-1", "R1A.html");
    await expect(moveGroupCanvases(from, join(root, "nowhere"), "g-1")).rejects.toThrow(/not a folder/);
    const elsewhere = await project("elsewhere");
    const to = await project("b");
    await symlink(elsewhere, join(to, ".grenade"));
    await expect(moveGroupCanvases(from, to, "g-1")).rejects.toBeInstanceOf(CanvasMoveError);
    const linked = await project("c");
    await mkdir(join(linked, ".grenade/canvas"), { recursive: true });
    await symlink(join(from, ".grenade/canvas/g-1"), join(linked, ".grenade/canvas/g-2"));
    await expect(moveGroupCanvases(linked, await project("d"), "g-2")).rejects.toBeInstanceOf(CanvasMoveError);
  });
});

describe("movedRecord", () => {
  const record: PublishRecord = {
    token: "t", key: "k", kind: "canvas", cwd: "/a", folder: "/a/.grenade/canvas/g-1/canvas-2", group: "g-1", canvas: "canvas-2",
    title: "T", scope: "all", expiry: "never", created: "", updated: "", boards: 1, state: "live",
  };

  it("points a link of the group's canvas at its new place", () => {
    expect(movedRecord(record, "/a/.grenade/canvas/g-1", "/b/.grenade/canvas/g-1", "/b")).toMatchObject({
      cwd: "/b", folder: "/b/.grenade/canvas/g-1/canvas-2", token: "t",
    });
  });

  it("leaves other links, a group whose id starts the same and plans alone", () => {
    expect(movedRecord({ ...record, folder: "/a/.grenade/canvas/g-10/canvas-2" }, "/a/.grenade/canvas/g-1", "/b/.grenade/canvas/g-1", "/b")).toBeNull();
    expect(movedRecord({ ...record, folder: "/a/.grenade/canvas" }, "/a/.grenade/canvas/g-1", "/b/.grenade/canvas/g-1", "/b")).toBeNull();
    expect(movedRecord({ ...record, kind: "plan" }, "/a/.grenade/canvas/g-1", "/b/.grenade/canvas/g-1", "/b")).toBeNull();
  });
});

describe("GroupCanvasMover", () => {
  const member = (id: string, canvasCwd?: string): Session => ({
    id, name: id, agent: "shell", cwd: "/a/src", status: "idle", statusSince: "", lastLine: "", createdAt: "2026-10-31T00:00:00Z", group: "g-1", order: 0,
    ...(canvasCwd ? { canvasCwd } : {}),
  });

  function make(sessions: Session[], kept?: KeptGroup) {
    const calls: string[] = [];
    const frame: GroupsFrame = { type: "groups", order: ["g-1"], kept: kept ? [kept] : [] };
    const mover = new GroupCanvasMover({
      registry: {
        list: () => sessions,
        setGroupCanvasCwd: (group, cwd) => {
          calls.push(`set ${group} ${cwd}`);
          return { session: sessions[0]!, changed: true };
        },
      },
      groups: { keptGroup: (g) => (g === kept?.group ? kept : undefined), setCwd: (g, cwd) => (calls.push(`kept ${g} ${cwd}`), true), frame: () => frame },
      publish: { followMove: async (from, to, cwd) => (calls.push(`links ${from} ${to} ${cwd}`), 1) },
      home: "/home/u",
      log: silentLogger,
      move: async (from, to, group) => (calls.push(`move ${from} ${to} ${group}`), true),
    });
    return { mover, calls, frame };
  }

  it("moves the folder, the links, then every member's canvasCwd", async () => {
    const { mover, calls } = make([member("s1", "/a")]);
    expect(await mover.move("g-1", "~/web/.grenade/canvas")).toBeUndefined();
    expect(calls).toEqual([
      "move /a /home/u/web g-1",
      "links /a/.grenade/canvas/g-1 /home/u/web/.grenade/canvas/g-1 /home/u/web",
      "set g-1 /home/u/web",
    ]);
  });

  it("answers with the first member when the group is there already", async () => {
    const { mover, calls } = make([member("s1", "/a")]);
    expect(await mover.move("g-1", "/a/")).toMatchObject({ id: "s1" });
    expect(calls).toEqual([]);
  });

  it("moves a kept group's folder and its cwd", async () => {
    const { mover, calls } = make([], { group: "g-1", cwd: "/a" });
    expect(await mover.move("g-1", "/b")).toBeUndefined();
    expect(calls.at(-1)).toBe("kept g-1 /b");
  });

  it("refuses a group it does not know", async () => {
    const { mover } = make([]);
    await expect(mover.move("g-1", "/b")).rejects.toBeInstanceOf(UnknownGroupError);
  });
});
