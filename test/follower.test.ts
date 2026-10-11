import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TranscriptFollower, type FollowPorts } from "../src/activity/follower.js";

/** A transcript whose size the test sets, and a session whose status it sets. */
function fake() {
  const state = { size: 100, working: true, reads: [] as number[] };
  const ports: FollowPorts = {
    read: async () => {
      state.reads.push(state.size);
    },
    size: async () => state.size,
    isWorking: () => state.working,
  };
  return { state, ports };
}

describe("TranscriptFollower", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("reads only when the transcript grew", async () => {
    const { state, ports } = fake();
    const follower = new TranscriptFollower(ports, 100, 1000);
    follower.follow("gr-a", "/t.jsonl");
    await vi.advanceTimersByTimeAsync(100);
    expect(state.reads).toEqual([100]);
    await vi.advanceTimersByTimeAsync(300);
    expect(state.reads).toEqual([100]);
    state.size = 180;
    await vi.advanceTimersByTimeAsync(100);
    expect(state.reads).toEqual([100, 180]);
    follower.stop();
  });

  it("takes the reply written after the turn ended, then stops after the tail", async () => {
    const { state, ports } = fake();
    const follower = new TranscriptFollower(ports, 100, 1000);
    follower.follow("gr-a", "/t.jsonl");
    await vi.advanceTimersByTimeAsync(100);
    // Stop ran; Claude Code writes the reply a moment later.
    state.working = false;
    await vi.advanceTimersByTimeAsync(200);
    state.size = 250;
    await vi.advanceTimersByTimeAsync(100);
    expect(state.reads).toEqual([100, 250]);
    expect(follower.isFollowing("gr-a")).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(follower.isFollowing("gr-a")).toBe(false);
  });

  it("a new hook restarts the tail", async () => {
    const { state, ports } = fake();
    const follower = new TranscriptFollower(ports, 100, 500);
    state.working = false;
    follower.follow("gr-a", "/t.jsonl");
    await vi.advanceTimersByTimeAsync(400);
    follower.follow("gr-a", "/t.jsonl");
    await vi.advanceTimersByTimeAsync(400);
    expect(follower.isFollowing("gr-a")).toBe(true);
    await vi.advanceTimersByTimeAsync(300);
    expect(follower.isFollowing("gr-a")).toBe(false);
  });

  it("keeps going after a failed read, and forgets a session that is gone", async () => {
    const { state, ports } = fake();
    let fail = true;
    const follower = new TranscriptFollower(
      {
        ...ports,
        size: async () => {
          if (fail) throw new Error("not yet");
          return state.size;
        },
      },
      100,
      1000,
    );
    follower.follow("gr-a", "/t.jsonl");
    await vi.advanceTimersByTimeAsync(100);
    fail = false;
    await vi.advanceTimersByTimeAsync(100);
    expect(state.reads).toEqual([100]);
    follower.forget("gr-a");
    state.size = 300;
    await vi.advanceTimersByTimeAsync(500);
    expect(state.reads).toEqual([100]);
  });
});
