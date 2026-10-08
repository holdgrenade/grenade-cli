/** Publishing (PROTOCOL.md "Publishing"): what a link holds, the share host's API, and the publisher keeping a page up to date. */
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CanvasBoard, ShareManifest } from "@grenade/protocol";
import { listCanvas, readBoard } from "../src/canvas/canvasFolder.js";
import { boardsInScope, isAssetName, linkOf, newSecrets, referencedAssets, titleOf, tokenForLog, withExpiry, type PublishRecord } from "../src/publish/publishPlan.js";
import { assetFiles, readAsset } from "../src/publish/publishFolder.js";
import { PublishError, Publisher, PUBLISH_RETRY_MS, PUBLISH_SETTLE_MS } from "../src/publish/publisher.js";
import { ShareClient, ShareHostError, type Fetch } from "../src/publish/shareClient.js";
import { loadPublished } from "../src/publish/publishStore.js";
import { publishedLines, tokenOf } from "../src/cli/publishCommand.js";
import { createLogger } from "../src/log.js";

const board = (file: string, revision?: number, letter?: string): CanvasBoard => ({
  file,
  name: file,
  ...(revision !== undefined ? { revision } : {}),
  ...(letter ? { letter } : {}),
  width: 1280,
  height: 800,
  modified: "2026-10-05T10:00:00.000Z",
  bytes: 10,
});

describe("what a link holds", () => {
  it("newest is the highest revision's boards; all is every board; no revisions is every board", () => {
    const boards = [board("x.html"), board("R7A.html", 7, "A"), board("R8A.html", 8, "A"), board("R8B.html", 8, "B")];
    expect(boardsInScope(boards, "newest").map((b) => b.file)).toEqual(["R8A.html", "R8B.html"]);
    expect(boardsInScope(boards, "all")).toHaveLength(4);
    expect(boardsInScope([board("a.html"), board("b.html")], "newest")).toHaveLength(2);
  });

  it("only files a board names go along, never a page or a hidden file", () => {
    const html = ['<img src="grenade-mark.svg"><img src="my%20logo.png">', "url('fonts/x.woff')"];
    expect(referencedAssets(html, ["grenade-mark.svg", "my logo.png", "secret.txt", ".env", "other.html"])).toEqual(["grenade-mark.svg", "my logo.png"]);
    expect(isAssetName("R1A · Hello.html")).toBe(false);
    expect(isAssetName(".DS_Store")).toBe(false);
    expect(isAssetName("current.png")).toBe(true);
  });

  it("title, secrets, expiry, and the link a client sees", () => {
    expect(titleOf("/Users/adam/code/grenade-mac/")).toBe("grenade-mac");
    const { token, key } = newSecrets((n) => Buffer.alloc(n, 7));
    expect(token).toMatch(/^[A-Za-z0-9_-]{16}$/);
    expect(key).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const record: PublishRecord = { token, key, kind: "canvas", cwd: "/a", folder: "/a/.grenade/canvas", title: "a", scope: "newest", expiry: "never", created: "2026-10-05T00:00:00.000Z", updated: "2026-10-05T00:00:00.000Z", boards: 2, state: "live" };
    const week = withExpiry(record, "7d", new Date("2026-10-05T00:00:00.000Z"));
    expect(week.expires).toBe("2026-10-12T00:00:00.000Z");
    expect(withExpiry(week, "never", new Date()).expires).toBeUndefined();
    const link = linkOf(record, "https://share.test");
    expect(link.url).toBe(`https://share.test/c/${token}`);
    expect(JSON.stringify(link)).not.toContain(key);
    expect(tokenForLog(token)).toHaveLength(5);
  });
});

describe("grenade publish", () => {
  it("lists links, and finds a token in an address", () => {
    expect(tokenOf("https://share.holdgrenade.com/c/k7Fq2xN9pWm4Lq0Z/R8A")).toBe("k7Fq2xN9pWm4Lq0Z");
    expect(tokenOf("k7Fq2xN9pWm4Lq0Z")).toBe("k7Fq2xN9pWm4Lq0Z");
    expect(publishedLines([], new Date())[0]).toMatch(/Nothing is published/);
    const lines = publishedLines([{ token: "k7Fq2xN9pWm4Lq0Z", kind: "canvas", cwd: "/a", folder: "/a/.grenade/canvas", title: "a", url: "https://s/c/k7Fq2xN9pWm4Lq0Z", scope: "all", expiry: "7d", expires: "2026-10-12T00:00:00.000Z", boards: 3, created: "2026-10-05T00:00:00.000Z", updated: "2026-10-05T00:00:00.000Z", state: "live" }], new Date("2026-10-05T00:00:00.000Z"));
    expect(lines[1]).toBe("  live · 3 boards · all revisions, expires in 7 days");
  });
});

/** A share host in memory that speaks PROTOCOL.md "Share host" closely enough to drive the publisher. */
class FakeHost {
  links = new Map<string, { keyHash: string; manifest?: ShareManifest; files: Map<string, string> }>();
  requests: string[] = [];
  down = false;
  fetch: Fetch = async (url, init) => {
    const path = decodeURIComponent(new URL(url).pathname);
    this.requests.push(`${init.method} ${path}`);
    if (this.down) throw new Error("offline");
    const key = init.headers["Authorization"]!.replace("Bearer ", "");
    const keyHash = createHash("sha256").update(key).digest("hex");
    const reply = (status: number, body: unknown = {}) => ({ status, ok: status < 300, json: async () => body, text: async () => JSON.stringify(body) });
    const m = /^\/v1\/c\/([^/]+)(?:\/f\/(.+))?$/.exec(path)!;
    const token = m[1]!;
    const link = this.links.get(token);
    if (link && link.keyHash !== keyHash) return reply(401, { error: "unauthorized", message: "This link belongs to another computer." });
    if (init.method === "DELETE") {
      if (!link) return reply(404, { error: "not_found", message: "no" });
      this.links.delete(token);
      return reply(204);
    }
    if (!m[2]) {
      const manifest = JSON.parse(init.body as string) as ShareManifest;
      const entry = link ?? { keyHash, files: new Map() };
      entry.manifest = manifest;
      this.links.set(token, entry);
      const sha = (f: string) => (entry.files.has(f) ? createHash("sha256").update(entry.files.get(f)!).digest("hex") : "");
      return reply(200, { missing: [...manifest.boards, ...manifest.assets].filter((f) => sha(f.file) !== f.sha256).map((f) => f.file) });
    }
    link!.files.set(m[2], Buffer.from(init.body as Uint8Array).toString("utf8"));
    return reply(204);
  };
}

describe("the publisher", () => {
  let dir: string;
  let cwd: string;
  let folder: string;
  /** A group's canvas, `canvas-2` (a canvas moved to that group). */
  let moved: string;
  let host: FakeHost;
  let timers: { fn: () => void; ms: number }[];
  let watchers: (() => void)[];
  const log = createLogger({ level: "error" });

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "grenade-publish-"));
    cwd = join(dir, "project");
    folder = join(cwd, ".grenade", "canvas");
    moved = join(folder, "g-9f3c", "canvas-2");
    await mkdir(moved, { recursive: true });
    await writeFile(join(moved, "R1A · Welcome.html"), "<title>Onboarding flow</title><h1>Welcome</h1>");
    await writeFile(join(folder, "R1A · Hello.html"), '<meta name="board" content="800x600"><img src="logo.svg">');
    await writeFile(join(folder, "R2A · Cards.html"), "<h1>Cards</h1>");
    await writeFile(join(folder, "R2B · Table.html"), "<h1>Table</h1>");
    await writeFile(join(folder, "logo.svg"), "<svg/>");
    await writeFile(join(folder, "notes.txt"), "private");
    host = new FakeHost();
    timers = [];
    watchers = [];
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  const make = (allowed = true) =>
    new Publisher({
      path: join(dir, "published.json"),
      client: new ShareClient("https://share.test", host.fetch),
      folderOf: ({ cwd: c, canvas }) => {
        if (!allowed || c !== cwd) throw new Error(`No session works in ${c}.`);
        return canvas === "canvas-2" ? moved : folder;
      },
      nameOf: async (_f, canvas) => (canvas === "canvas-2" ? "Onboarding flow" : canvas),
      listCanvas: (f) => listCanvas(f),
      watchCanvas: (_f, _current, onChange) => {
        watchers.push(onChange);
        return () => {};
      },
      readBoard: (f, file) => readBoard(f, file),
      assetFiles,
      readAsset,
      log,
      now: () => new Date("2026-10-05T12:00:00.000Z"),
      setTimer: (fn, ms) => {
        const t = { fn, ms };
        timers.push(t);
        return t;
      },
      clearTimer: (t) => {
        timers = timers.filter((x) => x !== t);
      },
    });

  /** Runs every timer due, as many rounds as they make, each sync to its end. */
  async function settle(p: Publisher, maxMs = PUBLISH_SETTLE_MS) {
    for (let round = 0; round < 10; round++) {
      const due = timers.filter((t) => t.ms <= maxMs);
      if (due.length === 0) return;
      timers = timers.filter((t) => !due.includes(t));
      for (const t of due) t.fn();
      await p.idle();
    }
  }

  it("publishes the newest revision with the files its boards name, and keeps the key to itself", async () => {
    const p = make();
    const links = await p.publishCanvas({ cwd: cwd }, "newest");
    expect(links[0]!.state).toBe("uploading");
    await settle(p);
    const link = p.list()[0]!;
    expect(link).toMatchObject({ state: "live", boards: 2, scope: "newest", title: "project" });
    const hosted = host.links.get(link.token)!;
    expect(hosted.manifest!.boards.map((b) => b.file)).toEqual(["R2A · Cards.html", "R2B · Table.html"]);
    expect(hosted.manifest!.assets).toEqual([]);
    expect([...hosted.files.keys()].sort()).toEqual(["R2A · Cards.html", "R2B · Table.html"]);
    const stored = JSON.parse(await readFile(join(dir, "published.json"), "utf8"));
    expect(stored[0].key).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(((await stat(join(dir, "published.json"))).mode & 0o777).toString(8)).toBe("600");
  });

  it("all revisions carry a picture a board names, never a file none names", async () => {
    const p = make();
    await p.publishCanvas({ cwd: cwd }, "all");
    await settle(p);
    const hosted = host.links.get(p.list()[0]!.token)!;
    expect(hosted.manifest!.boards).toHaveLength(3);
    expect(hosted.manifest!.assets.map((a) => a.file)).toEqual(["logo.svg"]);
    expect(hosted.files.has("notes.txt")).toBe(false);
  });

  it("a saved board goes up alone, once the folder has held still", async () => {
    const p = make();
    await p.publishCanvas({ cwd: cwd }, "newest");
    await settle(p);
    host.requests = [];
    await writeFile(join(folder, "R2A · Cards.html"), "<h1>Cards, again</h1>");
    await utimes(join(folder, "R2A · Cards.html"), new Date(), new Date(Date.now() + 5000));
    watchers.forEach((w) => w());
    expect(timers.map((t) => t.ms)).toContain(PUBLISH_SETTLE_MS);
    await settle(p);
    expect(host.requests).toEqual([`PUT /v1/c/${p.list()[0]!.token}`, `PUT /v1/c/${p.list()[0]!.token}/f/R2A · Cards.html`]);
  });

  it("a new revision moves a newest link on to it", async () => {
    const p = make();
    await p.publishCanvas({ cwd: cwd }, "newest");
    await settle(p);
    await writeFile(join(folder, "R3A · Next.html"), "<h1>Next</h1>");
    watchers.forEach((w) => w());
    await settle(p);
    expect(host.links.get(p.list()[0]!.token)!.manifest!.boards.map((b) => b.file)).toEqual(["R3A · Next.html"]);
    expect(p.list()[0]!.boards).toBe(1);
  });

  it("an unchanged canvas sends nothing", async () => {
    const p = make();
    await p.publishCanvas({ cwd: cwd }, "newest");
    await settle(p);
    host.requests = [];
    watchers.forEach((w) => w());
    await settle(p);
    expect(host.requests).toEqual([]);
  });

  it("publishing again changes the scope of the same link; a new link changes its address", async () => {
    const p = make();
    await p.publishCanvas({ cwd: cwd }, "newest");
    await settle(p);
    const first = p.list()[0]!.token;
    await p.publishCanvas({ cwd: cwd }, "all", "7d");
    await settle(p);
    expect(p.list()).toHaveLength(1);
    expect(p.list()[0]).toMatchObject({ token: first, scope: "all", expiry: "7d", expires: "2026-10-12T12:00:00.000Z", boards: 3 });
    await p.publishCanvas({ cwd: cwd }, "all", undefined, true);
    await settle(p);
    expect(p.list()[0]!.token).not.toBe(first);
    expect(p.list()[0]!.expiry).toBe("7d");
    expect(host.links.has(first)).toBe(false);
  });

  it("publishes a group's canvas under its name, and moves a link to a canvas that moved, keeping its address", async () => {
    const p = make();
    await p.publishCanvas({ cwd }, "newest");
    await settle(p);
    const token = p.list()[0]!.token;
    await p.publishCanvas({ cwd, group: "g-9f3c", canvas: "canvas-2" }, "all", undefined, false, token);
    await settle(p);
    expect(p.list()).toHaveLength(1);
    expect(p.list()[0]).toMatchObject({ token, folder: moved, group: "g-9f3c", canvas: "canvas-2", title: "Onboarding flow", scope: "all", boards: 1 });
    expect(host.links.get(token)!.manifest!.boards.map((b) => b.file)).toEqual(["R1A · Welcome.html"]);
    expect(loadPublished(join(dir, "published.json"))[0]).toMatchObject({ group: "g-9f3c", canvas: "canvas-2" });
    await expect(p.publishCanvas({ cwd }, "all", undefined, false, "nope0000nope0000")).rejects.toThrow(/not one of this computer's/);
    await expect(p.publishCanvas({ cwd }, "all", undefined, true, token)).rejects.toThrow(PublishError);
  });

  it("refuses a folder no session works in", async () => {
    await expect(make(false).publishCanvas({ cwd: "/etc" }, "all")).rejects.toThrow(PublishError);
  });

  it("unpublishing takes the page down and forgets the link; a host that cannot be reached keeps it", async () => {
    const p = make();
    await p.publishCanvas({ cwd: cwd }, "newest");
    await settle(p);
    const token = p.list()[0]!.token;
    host.down = true;
    await expect(p.remove(token)).rejects.toThrow(/still works/);
    expect(p.list()).toHaveLength(1);
    host.down = false;
    expect(await p.remove(token)).toEqual([]);
    expect(host.links.size).toBe(0);
    expect(loadPublished(join(dir, "published.json"))).toEqual([]);
  });

  it("a host that does not answer fails the link and tries again a minute later", async () => {
    const p = make();
    host.down = true;
    await p.publishCanvas({ cwd: cwd }, "newest");
    await settle(p);
    expect(p.list()[0]).toMatchObject({ state: "failed", error: "The share host did not answer. Trying again in a minute." });
    expect(timers.map((t) => t.ms)).toContain(PUBLISH_RETRY_MS);
    host.down = false;
    await settle(p, PUBLISH_RETRY_MS);
    expect(p.list()[0]!.state).toBe("live");
    expect(p.list()[0]!.error).toBeUndefined();
  });

  it("tells listeners of every change", async () => {
    const p = make();
    const seen: string[] = [];
    p.on("changed", (links: { state: string }[]) => seen.push(links[0]?.state ?? "none"));
    await p.publishCanvas({ cwd: cwd }, "newest");
    await settle(p);
    expect(seen).toEqual(["uploading", "live"]);
  });

  it("picks its links up again after a restart", async () => {
    const p = make();
    await p.publishCanvas({ cwd: cwd }, "newest");
    await settle(p);
    p.stop();
    const again = make();
    expect(again.list()).toHaveLength(1);
    await again.start();
    expect(watchers.length).toBe(2);
  });

  it("never reads a picture through a symbolic link", async () => {
    await writeFile(join(dir, "outside.png"), "secret");
    await symlink(join(dir, "outside.png"), join(folder, "linked.png"));
    expect((await assetFiles(folder)).map((f) => f.name)).not.toContain("linked.png");
    expect(await readAsset(folder, "linked.png")).toBeNull();
  });
});

describe("the share client", () => {
  it("reads the host's sentence from a refusal", async () => {
    const fetcher: Fetch = async () => ({ status: 401, ok: false, json: async () => ({ error: "unauthorized", message: "This link belongs to another computer." }), text: async () => "" });
    const client = new ShareClient("https://share.test/", fetcher);
    await expect(client.putManifest("k7Fq2xN9pWm4Lq0Z", "a".repeat(43), { title: "a", scope: "all", boards: [], assets: [] })).rejects.toThrow(new ShareHostError("This link belongs to another computer.", 401));
  });

  it("a link the host no longer has is down already", async () => {
    const fetcher: Fetch = async () => ({ status: 404, ok: false, json: async () => ({}), text: async () => "" });
    await expect(new ShareClient("https://share.test", fetcher).remove("k7Fq2xN9pWm4Lq0Z", "a".repeat(43))).resolves.toBeUndefined();
  });
});

describe("publishing a plan", () => {
  it("goes up as plan.md at /p/, named by its heading, and follows each save", async () => {
    const dir = await mkdtemp(join(tmpdir(), "grenade-publish-plan-"));
    const planPath = join(dir, "velvety-knitting-shell.md");
    await writeFile(planPath, "# Plan: Ship the plan tab\n\n- One\n");
    const host = new FakeHost();
    let timers: { fn: () => void; ms: number }[] = [];
    let saved: (() => void) | undefined;
    const p = new Publisher({
      path: join(dir, "published.json"),
      client: new ShareClient("https://share.test", host.fetch),
      folderOf: () => { throw new Error("no canvas"); },
      nameOf: async () => "",
      listCanvas: (f) => listCanvas(f),
      watchCanvas: () => () => {},
      readBoard: (f, file) => readBoard(f, file),
      assetFiles,
      readAsset,
      planOf: (id) => (id === "gr-a" ? { path: planPath, cwd: "/w" } : undefined),
      readPlan: async (path) => readFile(path).catch(() => null),
      watchPlan: (_path, onChange) => {
        saved = onChange;
        return () => {};
      },
      log: createLogger({ level: "error" }),
      now: () => new Date("2026-10-08T12:00:00.000Z"),
      setTimer: (fn, ms) => {
        const t = { fn, ms };
        timers.push(t);
        return t;
      },
      clearTimer: (t) => {
        timers = timers.filter((x) => x !== t);
      },
    });
    const settle = async () => {
      for (let round = 0; round < 10; round++) {
        const due = timers.filter((t) => t.ms <= PUBLISH_SETTLE_MS);
        if (due.length === 0) return;
        timers = timers.filter((t) => !due.includes(t));
        for (const t of due) t.fn();
        await p.idle();
      }
    };
    await expect(p.publishPlan("gr-b")).rejects.toThrow("no plan to publish");
    await p.publishPlan("gr-a", "7d");
    await settle();
    const link = p.list()[0]!;
    expect(link).toMatchObject({ kind: "plan", sessionId: "gr-a", file: "velvety-knitting-shell.md", title: "Ship the plan tab", state: "live", boards: 0, expiry: "7d" });
    expect(link.url).toBe(`https://share.test/p/${link.token}`);
    const hosted = host.links.get(link.token)!;
    expect(hosted.manifest).toMatchObject({ kind: "plan", boards: [], assets: [{ file: "plan.md" }] });
    expect(hosted.files.get("plan.md")).toBe("# Plan: Ship the plan tab\n\n- One\n");
    await writeFile(planPath, "# Ship the plan tab, with Publish\n\n- One\n- Two\n");
    saved!();
    await settle();
    expect(host.links.get(link.token)!.files.get("plan.md")).toContain("- Two");
    expect(p.list()[0]!.title).toBe("Ship the plan tab, with Publish");
    // Published again, it keeps its link.
    await p.publishPlan("gr-a");
    expect(p.list()).toHaveLength(1);
    await rm(dir, { recursive: true, force: true });
  });
});
