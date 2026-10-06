/** A turn's rules: its credentials, and that a prompt goes only where routing matched it for a prompt in that turn. */
import { describe, expect, it } from "vitest";
import { STARTS_PER_TURN, isTurnCall, maySend, mayStart, newTurn, noteConfirmation, noteRoute } from "../src/talk/talkGuard.js";

describe("talkGuard", () => {
  it("accepts a call of the running turn only, with its secret", () => {
    const turn = newTurn("t1", "s3cret");
    expect(isTurnCall(turn, "t1", "s3cret")).toBe(true);
    expect(isTurnCall(turn, "t1", "s3cre")).toBe(false);
    expect(isTurnCall(turn, "t2", "s3cret")).toBe(false);
    expect(isTurnCall(turn, "t1", undefined)).toBe(false);
    expect(isTurnCall(null, "t1", "s3cret")).toBe(false);
  });

  it("makes a fresh id and secret for each turn", () => {
    const a = newTurn();
    const b = newTurn();
    expect(a.id).not.toBe(b.id);
    expect(a.secret).not.toBe(b.secret);
    expect(a.secret.length).toBeGreaterThanOrEqual(32);
  });

  it("lets a prompt go only to a session routed for a prompt in the turn", () => {
    const turn = newTurn("t1", "s");
    expect(maySend(turn, "gr-api")).toBe(false);
    noteRoute(turn, "gr-api", "read");
    expect(maySend(turn, "gr-api")).toBe(false);
    noteRoute(turn, "gr-api", "prompt");
    expect(maySend(turn, "gr-api")).toBe(true);
    expect(maySend(turn, "gr-web")).toBe(false);
    // The next turn starts with nothing routed.
    expect(maySend(newTurn("t2", "s"), "gr-api")).toBe(false);
  });

  it("keeps the last confirmation's choices and counts starts", () => {
    const turn = newTurn("t1", "s");
    noteConfirmation(turn, [{ session: "gr-a", title: "A" }]);
    noteConfirmation(turn, [{ session: "gr-b", title: "B", status: "idle" }]);
    expect(turn.choices).toEqual([{ session: "gr-b", title: "B", status: "idle" }]);
    for (let i = 0; i < STARTS_PER_TURN; i++) {
      expect(mayStart(turn)).toBe(true);
      turn.started++;
    }
    expect(mayStart(turn)).toBe(false);
  });
});
