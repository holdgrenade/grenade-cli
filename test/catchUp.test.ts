import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CatchUp } from "../src/activity/catchUp.js";

describe("CatchUp", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("reads again at each delay until the reply is there", async () => {
    const answers = [false, false, true];
    const reads: number[] = [];
    const catchUp = new CatchUp(
      async () => {
        reads.push(Date.now());
        return answers.shift() ?? true;
      },
      [100, 200, 400, 800],
    );
    const t0 = Date.now();
    catchUp.start("gr-a", "/t.jsonl");
    await vi.advanceTimersByTimeAsync(2000);
    expect(reads.map((t) => t - t0)).toEqual([100, 300, 700]);
  });

  it("gives up after the last delay", async () => {
    let reads = 0;
    const catchUp = new CatchUp(
      async () => {
        reads++;
        return false;
      },
      [10, 10],
    );
    catchUp.start("gr-a", "/t.jsonl");
    await vi.advanceTimersByTimeAsync(1000);
    expect(reads).toBe(2);
  });

  it("keeps reading after a failed read", async () => {
    let reads = 0;
    const catchUp = new CatchUp(async () => {
      reads++;
      if (reads === 1) throw new Error("gone");
      return true;
    }, [10, 10, 10]);
    catchUp.start("gr-a", "/t.jsonl");
    await vi.advanceTimersByTimeAsync(100);
    expect(reads).toBe(2);
  });

  it("is cancelled by a hook of the session and by stop", async () => {
    const reads: string[] = [];
    const catchUp = new CatchUp(async (id) => {
      reads.push(id);
      return false;
    }, [10, 10]);
    catchUp.start("gr-a", "/a.jsonl");
    catchUp.start("gr-b", "/b.jsonl");
    catchUp.cancel("gr-a");
    await vi.advanceTimersByTimeAsync(10);
    expect(reads).toEqual(["gr-b"]);
    catchUp.stop();
    await vi.advanceTimersByTimeAsync(100);
    expect(reads).toEqual(["gr-b"]);
  });

  it("starting again replaces the catch-up already running", async () => {
    const reads: string[] = [];
    const catchUp = new CatchUp(async (_, path) => {
      reads.push(path);
      return false;
    }, [10, 10]);
    catchUp.start("gr-a", "/old.jsonl");
    catchUp.start("gr-a", "/new.jsonl");
    await vi.advanceTimersByTimeAsync(100);
    expect(reads).toEqual(["/new.jsonl", "/new.jsonl"]);
  });
});
