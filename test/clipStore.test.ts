/** The clips on disk: kept by day, private, listed, read in chunks, pruned; what is refused and why. */
import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLIP_CHUNK_BYTES, Clip } from "@grenade/protocol";
import { ClipError, ClipStore } from "../src/showreel/clipStore.js";
import type { MediaTools } from "../src/showreel/media.js";
import { PNG_2x3 } from "./clipFile.test.js";

/** An encoder that writes the source's bytes as the clip and says it is 6 s at 1280×800. */
const tools: MediaTools = {
  async encode(src, dst) {
    writeFileSync(dst, readFileSync(src));
    return true;
  },
  async probe() {
    return { seconds: 6, width: 1280, height: 800 };
  },
};

function setup(toolsUsed: MediaTools = tools) {
  const root = mkdtempSync(join(tmpdir(), "clips-"));
  const dir = join(root, "clips");
  let now = new Date(2026, 9, 9, 15, 28, 40);
  let seed = 0;
  const store = new ClipStore(dir, toolsUsed, () => now, () => { const base = seed++; return new Uint8Array(8).map((_, i) => (i + base) % 32); });
  const file = (name: string, bytes: Buffer) => {
    const path = join(root, name);
    writeFileSync(path, bytes);
    return path;
  };
  return { root, dir, store, file, setNow: (d: Date) => (now = d) };
}

describe("ClipStore", () => {
  it("keeps a picture of today with its size, private, and lists it", async () => {
    const { dir, store, file } = setup();
    const clip = await store.add({ path: file("shot.png", PNG_2x3), title: "  Changes, from the phone ", line: "What a session changed.", session: "gr-cli" });
    expect(clip).toEqual({ id: "c-abcdefgh", kind: "still", title: "Changes, from the phone", line: "What a session changed.", session: "gr-cli", at: new Date(2026, 9, 9, 15, 28, 40).toISOString(), mime: "image/png", bytes: PNG_2x3.length, width: 2, height: 3 });
    expect(Clip.safeParse(clip).success).toBe(true);
    const folder = join(dir, "2026-10-09");
    expect(statSync(folder).mode & 0o777).toBe(0o700);
    expect(statSync(join(folder, "c-abcdefgh.png")).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(join(folder, "c-abcdefgh.json"), "utf8"))).toEqual(clip);
    expect(store.list("2026-10-09")).toEqual([clip]);
    expect(store.list("2026-10-08")).toEqual([]);
    expect(store.find("c-abcdefgh")).toEqual(clip);
    expect(store.dates()).toEqual(["2026-10-09"]);
  });

  it("re-encodes a recording through the tools and keeps what they said about it; before and no line stay out", async () => {
    const { store, file } = setup();
    const clip = await store.add({ path: file("drawer.mov", Buffer.from("not really a movie")), title: "Composer grows", before: true });
    expect(clip).toMatchObject({ id: "c-abcdefgh", kind: "video", mime: "video/mp4", before: true, seconds: 6, width: 1280, height: 800, bytes: 18 });
    expect(clip).not.toHaveProperty("line");
    expect(clip).not.toHaveProperty("session");
    expect(existsSync(store.fileOf(clip))).toBe(true);
  });

  it("without an encoder keeps an .mp4 as it came and refuses a .mov", async () => {
    const { store, file } = setup({ async encode() { return false; }, async probe() { return {}; } });
    const kept = await store.add({ path: file("a.mp4", Buffer.from("mp4 bytes")), title: "A" });
    expect(kept).toMatchObject({ kind: "video", bytes: 9 });
    expect(kept).not.toHaveProperty("seconds");
    await expect(store.add({ path: file("b.mov", Buffer.from("mov bytes")), title: "B" })).rejects.toThrow(/No video encoder/);
  });

  it("refuses what is not a clip, with a sentence", async () => {
    const { store, file, root } = setup();
    await expect(store.add({ path: file("notes.txt", Buffer.from("x")), title: "T" })).rejects.toBeInstanceOf(ClipError);
    await expect(store.add({ path: join(root, "missing.png"), title: "T" })).rejects.toThrow(/is not a file/);
    await expect(store.add({ path: file("empty.png", Buffer.alloc(0)), title: "T" })).rejects.toThrow(/is empty/);
    await expect(store.add({ path: file("shot.png", PNG_2x3), title: "   " })).rejects.toThrow(/needs a title/);
  });

  it("reads a clip in chunks and says when the file ends; an unknown clip or an offset past the end is null", async () => {
    const { store, file } = setup();
    const bytes = Buffer.alloc(CLIP_CHUNK_BYTES + 10, 7);
    PNG_2x3.copy(bytes);
    const clip = await store.add({ path: file("big.png", bytes), title: "Big" });
    const first = store.chunk(clip.id, 0)!;
    expect(first.data.length).toBe(CLIP_CHUNK_BYTES);
    expect(first).toMatchObject({ bytes: bytes.length, last: false });
    const second = store.chunk(clip.id, CLIP_CHUNK_BYTES)!;
    expect(second.data.length).toBe(10);
    expect(second.last).toBe(true);
    expect(Buffer.concat([first.data, second.data]).equals(bytes)).toBe(true);
    expect(store.chunk(clip.id, bytes.length)).toBeNull();
    expect(store.chunk("c-nope", 0)).toBeNull();
  });

  it("removes days older than the keep window and leaves the rest", async () => {
    const { store, file, setNow } = setup();
    await store.add({ path: file("old.png", PNG_2x3), title: "Old" });
    setNow(new Date(2026, 10, 20, 9, 0));
    await store.add({ path: file("new.png", PNG_2x3), title: "New" });
    expect(store.prune()).toEqual(["2026-10-09"]);
    expect(store.dates()).toEqual(["2026-11-20"]);
  });
});
