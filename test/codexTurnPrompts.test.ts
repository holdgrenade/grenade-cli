import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import type { AgentKind, KeyName, PromptClosedFrame, PromptFrame } from "@grenade/protocol";
import { silentLogger } from "../src/log.js";
import { cardPlan, codexOpenQuestionsIn, codexProposedPlanIn } from "../src/prompts/codexRollout.js";
import { codexComposerIn, codexInPlanMode, codexNotesOpenIn, codexPlanDialogIn, codexQuestionPageIn } from "../src/prompts/codexScreen.js";
import { CodexTurnPrompts, SHIFT_TAB, buildPrompt } from "../src/prompts/codexTurnPrompts.js";
import { PromptStore } from "../src/prompts/promptStore.js";

/** As Codex 0.160 drew them, 2026-11-09. */
const footer = "  GPT-6-Luna medium · ~/code/api … Plan mode    ⚠ 1 warning · f2 to view";
const page1 = [
  "› Plan a tiny README for this folder.",
  "  Question 1/2 (2 unanswered)",
  "  What tone should the tiny README use?",
  "  › 1. Plain (Recommended)  Direct, neutral wording with no extra personality.",
  "    2. Friendly             Warm and conversational while staying concise.",
  "    3. Playful              Light and a little whimsical.",
  "    4. None of the above    Optionally, add details in notes (tab)",
  "  tab to add notes | enter to submit answer | ←/→ to navigate questions | esc to interrupt",
];
const page1Notes = [
  "  Question 1/2 (2 unanswered)",
  "  What tone should the tiny README use?",
  "    1. Plain (Recommended)  Direct, neutral wording with no extra personality.",
  "  › 4. None of the above    Optionally, add details in notes (tab)",
  "  › Add notes",
  "  tab or esc to clear notes | enter to submit answer",
];
const page2 = [
  "  Question 2/2 (1 unanswered)",
  "  How long should the README be?",
  "  › 1. One sentence (Recommended)  A single-line description of this folder.",
  "    2. Short paragraph             Two or three brief sentences with a little context.",
  "    3. None of the above           Optionally, add details in notes (tab)",
  "  tab to add notes | enter to submit all | ←/→ to navigate questions | esc to interrupt",
];
const planDialog = [
  "• Proposed Plan",
  "  # Add a README",
  "  1. Create README.md in the folder root.",
  "  2. Keep it short.",
  "  Worked for 36s • 2:07 PM",
  "  Implement this plan?",
  "› 1. Yes, implement this plan          Switch to Default and start coding",
  "  2. Yes, clear context and implement  Start a fresh thread (current context: 2% used)",
  "  3. No, stay in Plan mode             Continue planning with the model",
  "  enter select · esc back",
];
const composerPlan = ["  Worked for 36s • 2:07 PM", "› Ask Codex to do anything", footer];
const composerDefault = ["› Ask Codex to do anything", "  GPT-6-Luna default · ~/code/api  ⚠ 1 warning · f2 to view"];
const working = ["• Working (6s • esc to interrupt)", "› Ask Codex to do anything", footer];

const questionsCall = {
  type: "response_item",
  payload: {
    type: "function_call",
    name: "request_user_input",
    call_id: "call_1",
    arguments: JSON.stringify({
      questions: [
        { header: "Tone", id: "tone", question: "What tone should the tiny README use?", options: [{ label: "Plain (Recommended)", description: "Direct, neutral wording with no extra personality." }, { label: "Friendly", description: "Warm and conversational while staying concise." }, { label: "Playful", description: "Light and a little whimsical." }] },
        { header: "Length", id: "length", question: "How long should the README be?", options: [{ label: "One sentence (Recommended)", description: "A single-line description of this folder." }, { label: "Short paragraph", description: "Two or three brief sentences with a little context." }] },
      ],
    }),
  },
};
const questionsOutput = { type: "response_item", payload: { type: "function_call_output", call_id: "call_1", output: "{}" } };
const planMessage = { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "<proposed_plan>\n# Add a README\n\n## Changes\n\n- Create `README.md`.\n</proposed_plan>" }] } };
const jsonl = (...lines: unknown[]) => lines.map((l) => JSON.stringify(l)).join("\n");

describe("codexScreen", () => {
  it("reads a question page and its menu below the heading only", () => {
    expect(codexQuestionPageIn(page1)).toMatchObject({ page: 1, of: 2 });
    expect(codexQuestionPageIn(page1)!.menu.map((r) => r.selected)).toEqual([true, false, false, false]);
    expect(codexQuestionPageIn(page2)).toMatchObject({ page: 2, of: 2 });
    expect(codexQuestionPageIn(composerPlan)).toBeNull();
    expect(codexNotesOpenIn(page1Notes)).toBe(true);
    expect(codexNotesOpenIn(page1)).toBe(false);
  });

  it("reads the plan dialog's menu, not the numbered plan above it", () => {
    const d = codexPlanDialogIn(planDialog)!;
    expect(d.menu.map((r) => r.text.split("  ")[0])).toEqual(["Yes, implement this plan", "Yes, clear context and implement", "No, stay in Plan mode"]);
    expect(codexPlanDialogIn(composerPlan)).toBeNull();
  });

  it("tells the composer from a menu, and Plan mode from Default", () => {
    expect(codexComposerIn(composerPlan)).toBe(true);
    expect(codexComposerIn(composerDefault)).toBe(true);
    expect(codexComposerIn(page1)).toBe(false);
    expect(codexComposerIn(planDialog)).toBe(false);
    expect(codexInPlanMode(composerPlan)).toBe(true);
    expect(codexInPlanMode(composerDefault)).toBe(false);
  });
});

describe("codexRollout", () => {
  it("finds the request_user_input call still waiting, and none once answered", () => {
    const open = codexOpenQuestionsIn(jsonl({ type: "session_meta" }, questionsCall))!;
    expect(open.callId).toBe("call_1");
    expect(open.questions.map((q) => [q.id, q.header, q.options.length])).toEqual([["tone", "Tone", 3], ["length", "Length", 2]]);
    expect(codexOpenQuestionsIn(jsonl(questionsCall, questionsOutput))).toBeNull();
    expect(codexOpenQuestionsIn("not json\n")).toBeNull();
  });

  it("reads the newest proposed plan without its tags", () => {
    expect(codexProposedPlanIn(jsonl(planMessage))).toBe("# Add a README\n\n## Changes\n\n- Create `README.md`.");
    expect(codexProposedPlanIn(jsonl(questionsCall))).toBeNull();
    expect(cardPlan("x".repeat(30_000)).length).toBe(20_000);
  });
});

class FakeRegistry extends EventEmitter {
  screens = new Map<string, string[]>();
  sent: string[] = [];
  states: string[] = [];
  transcript = "/rollout.jsonl";
  screenOf(id: string) {
    const lines = this.screens.get(id);
    return lines ? { lines } : undefined;
  }
  transcriptOf() {
    return this.transcript;
  }
  asks() {
    this.states.push("asks");
  }
  asked() {
    this.states.push("asked");
  }
  async sendKey(_id: string, key: KeyName) {
    this.sent.push(key);
  }
  async sendText(_id: string, text: string, submit: boolean) {
    this.sent.push(`prompt:${text}${submit ? "⏎" : ""}`);
  }
  applyHook(_id: string, status: string) {
    this.states.push(status);
    return true;
  }
  show(id: string, lines: string[]) {
    this.screens.set(id, lines);
    this.emit("captured", id, "codex" as AgentKind, lines);
  }
}

const flush = () => new Promise((r) => setTimeout(r, 0));

function setup(rollout: string, editedPlan?: string) {
  const registry = new FakeRegistry();
  const prompts = new PromptStore();
  const opened: PromptFrame[] = [];
  const closed: PromptClosedFrame[] = [];
  prompts.on("opened", (f) => opened.push(f));
  prompts.on("closed", (f) => closed.push(f));
  const turn = new CodexTurnPrompts(registry, prompts, silentLogger, {
    read: async () => rollout,
    type: async (_id, text) => void registry.sent.push(`type:${text === SHIFT_TAB ? "⇧⇥" : text}`),
    wait: async () => {},
    ...(editedPlan ? { editedPlan: () => editedPlan } : {}),
  });
  return { registry, prompts, turn, opened, closed };
}

describe("CodexTurnPrompts: questions", () => {
  it("opens a question card from the rollout once the screen shows a page, and the session waits", async () => {
    const { registry, opened, closed } = setup(jsonl(questionsCall));
    registry.show("gr-a", page1);
    await flush();
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatchObject({ kind: "question" });
    expect(opened[0]!.questions!.map((q) => [q.header, q.options.map((o) => o.label), q.multiSelect])).toEqual([
      ["Tone", ["Plain (Recommended)", "Friendly", "Playful"], false],
      ["Length", ["One sentence (Recommended)", "Short paragraph"], false],
    ]);
    expect(registry.states).toEqual(["asks"]);
    registry.show("gr-a", page2);
    await flush();
    expect(opened).toHaveLength(1);
    registry.show("gr-a", working);
    expect(closed.map((c) => c.reason)).toEqual(["elsewhere"]);
    expect(registry.states).toEqual(["asks", "asked"]);
  });

  it("answers each page in turn, a typed answer as None of the above with a note", async () => {
    const { registry, prompts, opened } = setup(jsonl(questionsCall));
    registry.show("gr-a", page1);
    await flush();
    expect(prompts.answer("gr-a", opened[0]!.promptId, { allow: true, answers: [["Like a pirate"], ["Short paragraph"]] })).toBe("answered");
    await flush();
    expect(registry.sent).toEqual(["down", "down", "down", "tab"]);
    registry.show("gr-a", page1Notes);
    await flush();
    expect(registry.sent.slice(4)).toEqual(["type:Like a pirate", "enter"]);
    registry.show("gr-a", page2);
    await flush();
    expect(registry.sent.slice(6)).toEqual(["down", "enter"]);
    expect(registry.states).toContain("working");
  });

  it("refuses answers that do not cover every question", async () => {
    const { registry, prompts, opened } = setup(jsonl(questionsCall));
    registry.show("gr-a", page1);
    await flush();
    expect(prompts.answer("gr-a", opened[0]!.promptId, { allow: true, answers: [["Friendly"]] })).toEqual({ error: "answer all 2 questions" });
  });

  it("dismisses with Escape and sends what to do instead once Codex waits", async () => {
    const { registry, prompts, opened } = setup(jsonl(questionsCall));
    registry.show("gr-a", page1);
    await flush();
    prompts.answer("gr-a", opened[0]!.promptId, { allow: false, feedback: "Skip the questions." });
    await flush();
    expect(registry.sent).toEqual(["escape"]);
    registry.show("gr-a", composerPlan);
    await flush();
    expect(registry.sent).toEqual(["escape", "prompt:Skip the questions.⏎"]);
  });

  it("opens no card when the rollout has no open question", async () => {
    const { registry, opened } = setup(jsonl(questionsCall, questionsOutput));
    registry.show("gr-a", page1);
    await flush();
    expect(opened).toEqual([]);
    registry.show("gr-a", working);
    expect(registry.states).toEqual([]);
  });
});

describe("CodexTurnPrompts: plans", () => {
  it("opens a plan card with the proposed plan, and approving picks Yes, implement this plan", async () => {
    const { registry, prompts, opened } = setup(jsonl(planMessage));
    registry.show("gr-a", planDialog);
    await flush();
    expect(opened[0]).toMatchObject({ kind: "plan", plan: "# Add a README\n\n## Changes\n\n- Create `README.md`." });
    prompts.answer("gr-a", opened[0]!.promptId, { allow: true });
    await flush();
    expect(registry.sent).toEqual(["enter"]);
  });

  it("keeps planning with No, stay in Plan mode and sends the feedback", async () => {
    const { registry, prompts, opened } = setup(jsonl(planMessage));
    registry.show("gr-a", planDialog);
    await flush();
    prompts.answer("gr-a", opened[0]!.promptId, { allow: false, feedback: "Add a license section." });
    await flush();
    expect(registry.sent).toEqual(["down", "down", "enter"]);
    registry.show("gr-a", composerPlan);
    await flush();
    expect(registry.sent.at(-1)).toBe("prompt:Add a license section.⏎");
  });

  it("builds the plan with a note by leaving Plan mode and sending the plan as the prompt", async () => {
    const { registry, prompts, opened } = setup(jsonl(planMessage));
    registry.show("gr-a", planDialog);
    await flush();
    prompts.answer("gr-a", opened[0]!.promptId, { allow: true, note: "Design it on the canvas first." });
    await flush();
    expect(registry.sent).toEqual(["escape"]);
    registry.show("gr-a", composerPlan);
    await flush();
    expect(registry.sent).toEqual(["escape", "type:⇧⇥"]);
    registry.show("gr-a", composerDefault);
    await flush();
    expect(registry.sent.at(-1)).toBe(`prompt:${buildPrompt("# Add a README\n\n## Changes\n\n- Create `README.md`.", "Design it on the canvas first.")}⏎`);
  });

  it("builds the person's edited plan, not the one Codex wrote", async () => {
    const { registry, prompts, opened } = setup(jsonl(planMessage), "# My own plan");
    registry.show("gr-a", planDialog);
    await flush();
    prompts.answer("gr-a", opened[0]!.promptId, { allow: true });
    registry.show("gr-a", composerPlan);
    await flush();
    registry.show("gr-a", composerDefault);
    await flush();
    expect(registry.sent.at(-1)).toBe("prompt:Implement this plan:\n\n# My own plan⏎");
  });
});
