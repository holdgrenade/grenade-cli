import { describe, expect, it } from "vitest";
import { ContextBreakdown, CONTEXT_PROBE_TTL_MS } from "../src/usage/contextBreakdown.js";
import { probeAnswerOf, withParts, type ContextProbeAnswer } from "../src/usage/contextProbe.js";
import { silentLogger } from "../src/log.js";

// The shape of Claude Code's get_context_usage answer (summary), trimmed: a promptless claude in a project folder.
const answer = {
  categories: [
    { id: "system_prompt", name: "System prompt", tokens: 2439, color: "promptBorder", kind: "used" },
    { id: "system_tools", name: "System tools", tokens: 9368, color: "inactive", kind: "used" },
    { id: "system_tools_deferred", name: "System tools (deferred)", tokens: 23281, color: "inactive", isDeferred: true, kind: "deferred" },
    { id: "memory_files", name: "Memory files", tokens: 10212, color: "claude", kind: "used" },
    { id: "skills", name: "Skills", tokens: 5752, color: "warning", kind: "used" },
    { id: "messages", name: "Messages", tokens: 86, color: "purple", kind: "used" },
    { id: "custom_agents", name: "Custom agents", tokens: 0, color: "permission", kind: "used" },
    { id: "autocompact_buffer", name: "Autocompact buffer", tokens: 33000, color: "inactive", kind: "buffer" },
    { id: "free_space", name: "Free space", tokens: 939229, color: "promptBorder", kind: "free" },
  ],
  totalTokens: 27771,
  maxTokens: 1000000,
  rawMaxTokens: 1000000,
  percentage: 3,
  model: "claude-opus-5-5",
  memoryFiles: [{ path: "/w/grenade/CLAUDE.md", type: "Project", tokens: 2904 }],
  mcpTools: [],
  autoCompactThreshold: 967000,
  isAutoCompactEnabled: true,
};

describe("probeAnswerOf", () => {
  it("keeps the window's parts that are not the conversation, the buffer, the threshold and the memory files", () => {
    const a = probeAnswerOf(answer)!;
    expect(a.fixed.map((p) => p.id)).toEqual(["system_prompt", "system_tools", "memory_files", "skills"]);
    expect(a.fixed.reduce((s, p) => s + p.tokens, 0)).toBe(27771);
    expect(a).toMatchObject({ window: 1000000, threshold: 967000, buffer: 33000, compacts: true, memoryFiles: ["/w/grenade/CLAUDE.md"] });
  });

  it("names a category with no id after its name, and reads nothing it cannot", () => {
    const a = probeAnswerOf({ ...answer, categories: [{ name: "MCP tools", tokens: 900, kind: "used" }] })!;
    expect(a.fixed).toEqual([{ id: "mcp_tools", name: "MCP tools", tokens: 900 }]);
    expect(probeAnswerOf({ categories: "x" })).toBeUndefined();
    expect(probeAnswerOf(undefined)).toBeUndefined();
  });
});

describe("withParts", () => {
  const a = probeAnswerOf(answer)!;

  it("makes the conversation the rest of what is used, and compacts where it was measured on the same window", () => {
    const c = withParts({ used: 127771, size: 1000000 }, a);
    expect(c.parts?.at(-1)).toEqual({ id: "messages", name: "Messages", tokens: 100000 });
    expect(c.parts?.reduce((s, p) => s + p.tokens, 0)).toBe(127771);
    expect(c.compactsAt).toBe(967000);
  });

  it("compacts at the window less the buffer on another window, and not at all with auto-compact off", () => {
    expect(withParts({ used: 124000, size: 200000 }, a).compactsAt).toBe(167000);
    expect(withParts({ used: 124000, size: 200000 }, { ...a, compacts: false }).compactsAt).toBeUndefined();
  });

  it("never has a conversation below 0, and is the plain context with no measure", () => {
    expect(withParts({ used: 1000, size: 200000 }, a).parts?.at(-1)?.tokens).toBe(0);
    expect(withParts({ used: 1000, size: 200000 }, undefined)).toEqual({ used: 1000, size: 200000 });
  });
});

describe("ContextBreakdown", () => {
  const measured: ContextProbeAnswer = probeAnswerOf(answer)!;

  it("measures a folder once, one at a time, sends again once measured, and again after the TTL", async () => {
    let now = 0;
    const asked: string[] = [];
    const told: string[] = [];
    let release: (() => void) | undefined;
    const b = new ContextBreakdown({
      probe: (cwd) => {
        asked.push(cwd);
        return new Promise((resolve) => {
          release = () => resolve(measured);
        });
      },
      onMeasured: (cwd) => told.push(cwd),
      log: silentLogger,
      now: () => now,
      mtimeOf: async () => 1,
    });
    expect(b.of("/w/a", { used: 50000, size: 200000 }).parts).toBeUndefined();
    b.of("/w/a", { used: 50000, size: 200000 });
    b.of("/w/b", { used: 50000, size: 200000 });
    expect(asked).toEqual(["/w/a"]);
    release!();
    await new Promise((r) => setTimeout(r, 0));
    expect(told).toEqual(["/w/a"]);
    expect(asked).toEqual(["/w/a", "/w/b"]);
    expect(b.of("/w/a", { used: 50000, size: 200000 }).parts?.at(-1)?.tokens).toBe(50000 - 27771);
    now = CONTEXT_PROBE_TTL_MS;
    release!();
    await new Promise((r) => setTimeout(r, 0));
    b.of("/w/a", { used: 50000, size: 200000 });
    expect(asked.filter((c) => c === "/w/a")).toHaveLength(2);
  });

  it("measures again when a memory file changed", async () => {
    let now = 0;
    let mtime = 1;
    let asked = 0;
    const b = new ContextBreakdown({
      probe: async () => {
        asked++;
        return measured;
      },
      onMeasured: () => {},
      log: silentLogger,
      now: () => now,
      mtimeOf: async () => mtime,
    });
    b.of("/w/a", { used: 1, size: 200000 });
    await new Promise((r) => setTimeout(r, 0));
    now = 61_000;
    mtime = 2;
    b.of("/w/a", { used: 1, size: 200000 });
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(asked).toBe(2);
  });
});
