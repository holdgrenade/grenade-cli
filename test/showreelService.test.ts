/** The service: a cut on each clip, the model's titles once the clips held still, the end-of-day row, the frames. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaemonFrame, type ActivityEntry, type Session, type ShowreelFrame } from "@grenade/protocol";
import { silentLogger } from "../src/log.js";
import { ClipStore } from "../src/showreel/clipStore.js";
import { MODEL_SETTLE_MS, ShowreelService } from "../src/showreel/showreelService.js";
import { PNG_2x3 } from "./clipFile.test.js";

const session: Session = { id: "gr-cli", name: "cli", agent: "claude", cwd: "/p", status: "waiting", statusSince: "2026-10-09T15:00:00.000Z", lastLine: "", createdAt: "2026-10-09T09:00:00.000Z", title: "Changes view" };

function setup(opts: { run?: (input: string) => Promise<string>; hour?: number } = {}) {
  const root = mkdtempSync(join(tmpdir(), "showreel-"));
  let now = new Date(2026, 9, 9, 15, 28, 40);
  let seed = 0;
  const store = new ClipStore(join(root, "clips"), { async encode(src, dst) { writeFileSync(dst, "mp4"); return true; }, async probe() { return { seconds: 5 }; } }, () => now, () => { const base = seed++; return new Uint8Array(8).map((_, i) => (i + base) % 32); });
  const entries: ActivityEntry[] = [
    // In the computer's own time, as the clip's `at` is: the push came three minutes after the clip.
    { kind: "said", text: "Done. The drawer is in, with a push card.", at: new Date(2026, 9, 9, 15, 27).toISOString() },
    { kind: "push", text: "Pushed 2 commits to origin/main", at: new Date(2026, 9, 9, 15, 31).toISOString(), upstream: "origin/main", commits: [] },
  ];
  const announced: string[] = [];
  const inputs: string[] = [];
  const service = new ShowreelService({
    store,
    dir: join(root, "showreels"),
    settingsPath: join(root, "showreel.json"),
    registry: { list: () => [session], get: (id) => (id === session.id ? session : undefined) },
    entriesOf: (id) => (id === session.id ? entries : []),
    boardsOf: async () => [{ cwd: "/p", file: "R10C · Drawer.html", title: "Drawer", modified: "2026-10-09T09:40:00.000Z" }],
    run: opts.run ? async (input) => { inputs.push(input); return opts.run!(input); } : undefined,
    announce: (text) => announced.push(text),
    log: silentLogger,
    now: () => now,
  });
  if (opts.hour !== undefined) service.setHour(opts.hour);
  const changed: ShowreelFrame[] = [];
  service.on("changed", (f) => changed.push(f));
  const picture = (name: string) => {
    const path = join(root, name);
    writeFileSync(path, PNG_2x3);
    return path;
  };
  return { service, store, changed, announced, inputs, picture, setNow: (d: Date) => (now = d) };
}

describe("ShowreelService", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("has nothing for a day without clips, and a piece per clip title as soon as one is kept", async () => {
    const { service, changed, picture } = setup();
    expect(service.frame(undefined)).toEqual({ type: "showreel", date: "2026-10-09", version: 0, pieces: [], clips: [] });
    const clip = await service.addClip({ path: picture("a.png"), title: "Changes, from the phone", line: "See what changed.", session: "gr-cli" });
    const frame = service.frame("2026-10-09");
    expect(DaemonFrame.safeParse(frame).success).toBe(true);
    expect(frame).toMatchObject({ version: 1, opening: "Shipped today: Changes, from the phone.", pieces: [{ title: "Changes, from the phone", line: "See what changed.", parts: [{ clips: [clip.id], done: { kind: "push", text: "Pushed 2 commits to origin/main" } }] }], clips: [clip] });
    expect(changed).toHaveLength(1);
    expect(service.clips(undefined).clips).toEqual([clip]);
    expect(service.chunk(clip.id, 0)).toMatchObject({ type: "clip.chunk", id: clip.id, from: 0, bytes: PNG_2x3.length, last: true });
    expect(service.chunk("c-nope", 0)).toBeNull();
  });

  it("asks the model once the clips held still, cuts again with its titles and board, and tells who watches", async () => {
    const run = vi.fn(async () => JSON.stringify({ opening: "Changes, from the phone.", pieces: [{ title: "Changes, from the phone", line: "What a session changed, and Push.", parts: [{ board: "R10C · Drawer.html", clips: ["c-abcdefgh"] }] }] }));
    const { service, changed, inputs, picture } = setup({ run });
    await service.addClip({ path: picture("a.png"), title: "changes drawer", session: "gr-cli" });
    expect(run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(MODEL_SETTLE_MS + 1);
    expect(run).toHaveBeenCalledTimes(1);
    expect(inputs[0]).toContain("The drawer is in, with a push card.");
    expect(inputs[0]).toContain("R10C · Drawer.html");
    const frame = service.frame(undefined);
    expect(frame.version).toBe(2);
    expect(frame.opening).toBe("Changes, from the phone.");
    expect(frame.pieces[0]).toMatchObject({ title: "Changes, from the phone", line: "What a session changed, and Push.", parts: [{ board: { cwd: "/p", file: "R10C · Drawer.html" }, clips: ["c-abcdefgh"] }] });
    expect(changed.at(-1)).toEqual(frame);
    // A reply that is not pieces leaves the cut as it was.
    run.mockResolvedValueOnce("I would rather not.");
    expect((await service.make(undefined)).version).toBe(2);
  });

  it("announces the day's reel once at the end-of-day hour, titled first, and not on a day with nothing", async () => {
    const run = vi.fn(async () => JSON.stringify({ pieces: [{ title: "The drawer", parts: [{ clips: ["c-abcdefgh"] }] }] }));
    const { service, announced, picture, setNow } = setup({ run, hour: 18 });
    await service.checkHour();
    expect(announced).toEqual([]);
    await service.addClip({ path: picture("a.png"), title: "drawer", session: "gr-cli" });
    await service.checkHour();
    expect(announced).toEqual([]);
    setNow(new Date(2026, 9, 9, 18, 0, 30));
    await service.checkHour();
    expect(run).toHaveBeenCalledTimes(1);
    expect(announced).toEqual(["The drawer"]);
    await service.checkHour();
    expect(announced).toEqual(["The drawer"]);
  });

  it("keeps the hour in its file and reads it back", () => {
    const { service } = setup();
    expect(service.hour()).toBe(18);
    service.setHour(20);
    expect(service.hour()).toBe(20);
  });
});
