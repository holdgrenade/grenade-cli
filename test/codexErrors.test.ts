import { describe, expect, it } from "vitest";
import type { ActivityEntry } from "@grenade/protocol";
import { endsWithError } from "../src/activity/codexErrors.js";

const at = "2026-11-09T19:00:00.000Z";

describe("endsWithError", () => {
  it("is a turn whose newest entry is Codex's error", () => {
    const asked: ActivityEntry = { kind: "asked", text: "Fix the build", at };
    const said: ActivityEntry = { kind: "said", text: "Done.", at };
    const errored: ActivityEntry = { kind: "errored", text: "stream disconnected before completion", at };
    expect(endsWithError([asked, errored])).toBe(true);
    expect(endsWithError([asked, errored, said])).toBe(false);
    expect(endsWithError([asked])).toBe(false);
    expect(endsWithError([])).toBe(false);
  });
});
