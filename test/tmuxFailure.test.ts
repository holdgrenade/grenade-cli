import { describe, expect, it } from "vitest";
import { tmuxFailure } from "../src/tmux/tmux.js";

describe("tmuxFailure", () => {
  it("says tmux's own words, else how it failed, and never the command line with the typed text", () => {
    expect(tmuxFailure("can't find session: gr-x\n", { code: 1 })).toBe("can't find session: gr-x");
    expect(tmuxFailure("", { killed: true, signal: "SIGTERM" })).toBe("tmux did not answer in time");
    expect(tmuxFailure("", { code: 1 })).toBe("tmux exited with 1");
    expect(tmuxFailure("", { code: "ENOENT" })).toBe("tmux could not run (ENOENT)");
    expect(tmuxFailure("  ", {})).toBe("tmux failed");
  });
});
