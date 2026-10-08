import { describe, expect, it } from "vitest";
import type { PlanFrame, SessionPlan } from "@grenade/protocol";
import { PlanTracker, PlanWriteError, type Every, type PlanFiles } from "../src/plans/planTracker.js";

const home = "/Users/adam";
const plan = `${home}/.claude/plans/velvety-knitting-shell.md`;

/** A file system of one folder, and a clock for each save. */
function memoryFiles(): PlanFiles & { files: Map<string, string>; saves: number } {
  const files = new Map<string, string>();
  const fs = {
    files,
    saves: 0,
    async read(path: string) {
      const text = files.get(path);
      return text === undefined ? null : { text, modified: new Date(Date.UTC(2026, 9, 8, 16, 0, fs.saves)), bytes: text.length };
    },
    async write(path: string, text: string) {
      if (!files.has(path)) throw new Error("not a regular file");
      files.set(path, text);
      fs.saves += 1;
    },
  };
  return fs;
}

/** Ticks by hand. */
function manualEvery(): Every & { tick(): void } {
  const fns = new Set<() => void>();
  const every = ((fn: () => void) => {
    fns.add(fn);
    return () => fns.delete(fn);
  }) as Every & { tick(): void };
  every.tick = () => fns.forEach((fn) => fn());
  return every;
}

const flush = () => new Promise((r) => setTimeout(r, 0));

function tracker() {
  const files = memoryFiles();
  const every = manualEvery();
  const t = new PlanTracker(files, `${home}/.claude`, home, every);
  const plans: [string, SessionPlan | undefined][] = [];
  t.on("plan", (id, p) => plans.push([id, p]));
  return { t, files, every, plans };
}

const hook = (event: string, extra: Record<string, unknown> = {}) => ({ hook_event_name: event, permission_mode: "plan", ...extra });
const write = (event: "PreToolUse" | "PostToolUse", file = plan) => hook(event, { tool_name: "Write", tool_input: { file_path: file, content: "# Plan" } });

describe("PlanTracker", () => {
  it("leaves a session that never planned alone", () => {
    const { t, plans } = tracker();
    t.hook("gr-a", { hook_event_name: "UserPromptSubmit", permission_mode: "default" });
    expect(t.planOf("gr-a")).toBeUndefined();
    expect(plans).toEqual([]);
  });

  it("follows plan mode, finds the file, and locks it from the agent's write until the turn ends", () => {
    const { t, plans } = tracker();
    t.hook("gr-a", hook("UserPromptSubmit"));
    expect(t.planOf("gr-a")).toEqual({ planning: true, writing: false });
    t.hook("gr-a", write("PreToolUse"));
    expect(t.planOf("gr-a")).toEqual({ file: "velvety-knitting-shell.md", planning: true, writing: true });
    t.hook("gr-a", write("PostToolUse"));
    expect(t.planOf("gr-a")?.writing).toBe(true);
    t.hook("gr-a", hook("Stop"));
    expect(t.planOf("gr-a")).toEqual({ file: "velvety-knitting-shell.md", planning: true, writing: false });
    expect(plans.map(([, p]) => p?.writing)).toEqual([false, true, false]);
  });

  it("unlocks when the agent asks for approval, and takes the plan file from it", () => {
    const { t } = tracker();
    t.hook("gr-a", write("PreToolUse"));
    const other = `${home}/.claude/plans/other.md`;
    t.hook("gr-a", hook("PermissionRequest", { tool_name: "ExitPlanMode", tool_input: { plan: "# P", planFilePath: other } }));
    expect(t.planOf("gr-a")).toEqual({ file: "other.md", planning: true, writing: false });
  });

  it("is not fooled by a write outside the plans folder", () => {
    const { t } = tracker();
    t.hook("gr-a", write("PreToolUse", `${home}/code/app/plan.md`));
    t.hook("gr-a", write("PreToolUse", `${home}/.claude/plans/../settings.md`));
    expect(t.planOf("gr-a")).toEqual({ planning: true, writing: false });
  });

  it("follows the mode out of plan mode", () => {
    const { t } = tracker();
    t.hook("gr-a", write("PreToolUse"));
    t.hook("gr-a", { hook_event_name: "PreToolUse", permission_mode: "acceptEdits", tool_name: "Bash", tool_input: {} });
    expect(t.planOf("gr-a")?.planning).toBe(false);
  });

  it("refuses the user's edit while the agent writes, and takes it once the turn is over", async () => {
    const { t, files } = tracker();
    files.files.set(plan, "# Plan\n");
    t.hook("gr-a", write("PreToolUse"));
    await expect(t.write("gr-a", "# Mine\n")).rejects.toBeInstanceOf(PlanWriteError);
    t.turnOver("gr-a");
    const frame = await t.write("gr-a", "# Mine\n");
    expect(frame).toMatchObject({ type: "plan", sessionId: "gr-a", file: "velvety-knitting-shell.md", folder: `${home}/.claude/plans`, text: "# Mine\n", by: "user", writing: false });
    expect(files.files.get(plan)).toBe("# Mine\n");
  });

  it("refuses an edit before there is a plan file", async () => {
    const { t } = tracker();
    t.hook("gr-a", hook("UserPromptSubmit"));
    await expect(t.write("gr-a", "x")).rejects.toThrow("no plan to edit");
  });

  it("tells the agent of the user's edit once, and not after it wrote the plan again", async () => {
    const { t, files } = tracker();
    files.files.set(plan, "# Plan\n");
    t.hook("gr-a", write("PreToolUse"));
    t.hook("gr-a", hook("Stop"));
    expect(t.takeEditedNote("gr-a")).toBeUndefined();
    await t.write("gr-a", "# Mine\n");
    expect(t.takeEditedNote("gr-a")).toBe("(I edited the plan in ~/.claude/plans/velvety-knitting-shell.md myself: read it again before you go on, and keep my changes.)");
    expect(t.takeEditedNote("gr-a")).toBeUndefined();
    await t.write("gr-a", "# Mine again\n");
    t.hook("gr-a", hook("UserPromptSubmit"));
    t.hook("gr-a", write("PreToolUse"));
    expect(t.takeEditedPath("gr-a")).toBeUndefined();
  });

  it("hands a follower the plan at once, again on a change, and the lock lifting", async () => {
    const { t, files, every } = tracker();
    files.files.set(plan, "# Plan\n");
    t.hook("gr-a", write("PreToolUse"));
    const got: PlanFrame[] = [];
    const stop = t.follow("gr-a", (f) => got.push(f));
    await flush();
    expect(got.map((f) => [f.text, f.writing, f.by])).toEqual([["# Plan\n", true, "agent"]]);
    every.tick();
    await flush();
    expect(got).toHaveLength(1);
    files.files.set(plan, "# Plan\n\n- One\n");
    files.saves += 1;
    every.tick();
    await flush();
    t.hook("gr-a", hook("Stop"));
    await flush();
    expect(got.map((f) => [f.text, f.writing])).toEqual([
      ["# Plan\n", true],
      ["# Plan\n\n- One\n", true],
      ["# Plan\n\n- One\n", false],
    ]);
    stop();
    files.files.set(plan, "# Gone\n");
    files.saves += 1;
    every.tick();
    await flush();
    expect(got).toHaveLength(3);
  });

  it("brings back a saved plan file after a restart", () => {
    const { t } = tracker();
    t.restore("gr-a", plan);
    expect(t.planOf("gr-a")).toEqual({ file: "velvety-knitting-shell.md", planning: false, writing: false });
    t.restore("gr-b", "/etc/passwd");
    expect(t.planOf("gr-b")).toBeUndefined();
  });
});
