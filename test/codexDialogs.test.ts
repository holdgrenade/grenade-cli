import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import type { KeyName } from "@grenade/protocol";
import { silentLogger } from "../src/log.js";
import { codexDialogIn } from "../src/prompts/codexDialogs.js";
import { PromptStore } from "../src/prompts/promptStore.js";
import { ScreenPrompts } from "../src/prompts/screenPrompts.js";
import { initialStatus, reduceStatus } from "../src/sessions/status.js";

/** As Codex 0.160 drew them, 2026-10-02. */
const hooksScreen = [
  "",
  "  Hooks need review",
  "  7 hooks are new or changed.",
  "  Hooks can run outside the sandbox after you trust them.",
  "",
  "› 1. Review hooks",
  "  2. Trust all and continue",
  "  3. Continue without trusting (hooks won't run)",
  "",
  "  enter confirm · esc skip",
];
const folderScreen = [
  "  Folder access",
  "  /Users/me/code/api",
  "  Trust this folder? Codex can read, edit, and run files here, subject to your permission settings. Folder settings can run code",
  "  automatically, even without a model request. Continue only if you trust these files. Your trust decision will be saved.",
  "› 1. Trust and continue",
  "  2. Back to Agent Command Center",
  "  enter continue · esc back",
];
const promptScreen = ["  >_ OpenAI Codex (v0.160.0)", "", "› Ask Codex to do anything", "  GPT-6-Luna default · ~/code/api"];

describe("codexDialogIn", () => {
  it("reads the hooks review as a question whose Trust picks Trust all and continue", () => {
    const d = codexDialogIn(hooksScreen)!;
    expect(d.id).toBe("hooks");
    expect(d.choices.map((c) => [c.label, c.keys])).toEqual([["Trust", ["down", "enter"]], ["Skip", ["down", "down", "enter"]]]);
    expect(d.body.questions?.[0]?.question).toMatch(/^7 hooks are new or changed\. Codex runs hooks only once you trust them/);
  });
  it("reads the folder trust, with the folder, whose Trust is Enter", () => {
    const d = codexDialogIn(folderScreen)!;
    expect(d.id).toBe("folder");
    expect(d.body.questions?.[0]?.question).toBe("Trust this folder? /Users/me/code/api");
    expect(d.choices.map((c) => c.keys)).toEqual([["enter"]]);
  });
  it("counts from where the selection is", () => {
    const moved = hooksScreen.map((l) => l.replace("› 1.", "  1.").replace("  3. Continue", "› 3. Continue"));
    expect(codexDialogIn(moved)!.choices.map((c) => c.keys)).toEqual([["up", "enter"], ["enter"]]);
  });
  it("finds nothing on Codex's prompt, and nothing in a menu it cannot read", () => {
    expect(codexDialogIn(promptScreen)).toBeNull();
    expect(codexDialogIn(hooksScreen.filter((l) => !l.includes("›")))).toBeNull();
  });
});

describe("ScreenPrompts", () => {
  const setup = () => {
    const registry = Object.assign(new EventEmitter(), { asked: [] as string[], keys: [] as KeyName[], asks(id: string) { this.asked.push(id); }, async sendKey(_id: string, k: KeyName) { this.keys.push(k); } });
    const prompts = new PromptStore({ newId: (() => { let n = 0; return () => `p-${++n}`; })() });
    const events: string[] = [];
    prompts.on("opened", (f) => events.push(`opened ${f.promptId}`));
    prompts.on("closed", (f) => events.push(`closed ${f.promptId} ${f.reason}`));
    new ScreenPrompts(registry, prompts, silentLogger);
    return { registry, prompts, events, show: (lines: string[], agent = "codex") => registry.emit("captured", "gr-c", agent, lines) };
  };
  it("opens one card per dialog, makes the session wait, and types the answer", async () => {
    const { registry, prompts, events, show } = setup();
    show(hooksScreen);
    show(hooksScreen);
    expect(events).toEqual(["opened p-1"]);
    expect(registry.asked).toEqual(["gr-c"]);
    expect(prompts.answer("gr-c", "p-1", { allow: true, answers: [["Trust"]] })).toBe("answered");
    await new Promise((r) => setImmediate(r));
    expect(registry.keys).toEqual(["down", "enter"]);
    show(promptScreen);
    expect(events).toEqual(["opened p-1", "closed p-1 answered"]);
  });
  it("closes the card when the dialog is answered on the Mac, and opens the next dialog's", () => {
    const { events, show } = setup();
    show(folderScreen);
    show(hooksScreen);
    show(promptScreen);
    expect(events).toEqual(["opened p-1", "closed p-1 elsewhere", "opened p-2", "closed p-2 elsewhere"]);
  });
  it("refuses a typed answer, leaves a dismissed dialog to the terminal, and reads only Codex's screens", () => {
    const { registry, prompts, events, show } = setup();
    show(hooksScreen, "claude");
    expect(events).toEqual([]);
    show(hooksScreen);
    expect(prompts.answer("gr-c", "p-1", { allow: true, answers: [["yes please"]] })).toEqual({ error: "pick one of: Trust, Skip" });
    expect(prompts.answer("gr-c", "p-1", { allow: false })).toBe("answered");
    expect(registry.keys).toEqual([]);
  });
});

describe("the asks status event", () => {
  it("waits for an answer without making the session hook-driven, and does not raise one already seen", () => {
    const waiting = reduceStatus(initialStatus(0), { kind: "asks", at: 1 });
    expect(waiting).toMatchObject({ status: "waiting", waitingFor: "answer", hookDriven: false });
    const seen = reduceStatus(waiting, { kind: "seen", at: 2 });
    expect(reduceStatus(seen, { kind: "asks", at: 3 })).toBe(seen);
    expect(reduceStatus(seen, { kind: "output", changed: true, at: 4 }).status).toBe("working");
  });
});
