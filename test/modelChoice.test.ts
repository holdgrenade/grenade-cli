import { describe, expect, it } from "vitest";
import type { Session } from "@grenade/protocol";
import { agentInfo } from "../src/agents/agentCatalog.js";
import { modelChoiceProblem, switchTimingProblem } from "../src/models/modelChoice.js";

const session: Session = { id: "gr-a", name: "a", agent: "claude", cwd: "/tmp", status: "idle", statusSince: "2026-10-03T10:00:00.000Z", lastLine: "", createdAt: "2026-10-03T10:00:00.000Z" };

describe("modelChoiceProblem", () => {
  it("takes a model the agent lists, with one of its effort levels or none", () => {
    expect(modelChoiceProblem(agentInfo("claude"), "Opus 5.5", "xhigh")).toBeNull();
    expect(modelChoiceProblem(agentInfo("claude"), "Opus 5.5", undefined)).toBeNull();
    expect(modelChoiceProblem(agentInfo("claude"), "Haiku 4.5", undefined)).toBeNull();
  });
  it("says what is wrong with any other choice", () => {
    expect(modelChoiceProblem(agentInfo("claude"), "Opus 3", undefined)).toBe("Claude Code has no model named Opus 3");
    expect(modelChoiceProblem(agentInfo("claude"), "Opus 5.5", "ultra")).toBe("Opus 5.5 has no ultra effort");
    expect(modelChoiceProblem(agentInfo("claude"), "Haiku 4.5", "low")).toBe("Haiku 4.5 has no low effort");
    expect(modelChoiceProblem(agentInfo("shell"), "Opus 5.5", undefined)).toBe("this session's agent has no models to choose from");
    expect(modelChoiceProblem(undefined, "Opus 5.5", undefined)).toBe("this session's agent has no models to choose from");
  });
});

describe("switchTimingProblem", () => {
  it("lets a session switch while its agent is at its prompt", () => {
    expect(switchTimingProblem(session)).toBeNull();
    expect(switchTimingProblem({ ...session, status: "waiting", waitingFor: "done" })).toBeNull();
    expect(switchTimingProblem({ ...session, status: "waiting", waitingFor: "stopped", stoppedBecause: "quiet" })).toBeNull();
  });
  it("refuses while the agent works, asks, or is gone", () => {
    expect(switchTimingProblem({ ...session, status: "working" })).toMatch(/working/);
    expect(switchTimingProblem({ ...session, status: "waiting", waitingFor: "answer" })).toMatch(/answer/);
    expect(switchTimingProblem({ ...session, status: "gone" })).toMatch(/ended/);
  });
});
