import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import type { KeyName } from "@grenade/protocol";
import { silentLogger } from "../src/log.js";
import { sessionModelIn } from "../src/models/claudeModelPicker.js";
import { claudeDialogIn } from "../src/prompts/claudeDialogs.js";
import { PromptStore } from "../src/prompts/promptStore.js";
import { ScreenPrompts } from "../src/prompts/screenPrompts.js";
import { reduceStatus, shownStoppedBecause, type StatusState } from "../src/sessions/status.js";
import { pickerScreen } from "./claudeModelPicker.test.js";

/** As Claude Code 2.1.289 drew it, 2026-10-04: `s` in the `/model` picker of a conversation that has a message. */
export function switchScreen(model = "Opus 5.5", cursor: 1 | 2 = 1): string[] {
  return [
    "⏺ hi",
    "",
    "✻ Worked for 1s · done 1:45 PM",
    "",
    "❯ /model",
    "",
    "────────────────────────────────────────────────────────────────────────────────────────────────────",
    "  Switch model?",
    "  Your next response will be slower and use more tokens",
    "",
    `  This conversation is cached for the current model. Switching to ${model} means the full history`,
    "  gets re-read on your next message.",
    "",
    `  ${cursor === 1 ? "❯" : " "} 1. Yes, switch to ${model}`,
    `  ${cursor === 2 ? "❯" : " "} 2. No, go back`,
    "",
  ];
}
/** After "Yes". */
const switchedScreen = ["❯ /model", "  ⎿  Kept model as Haiku 4.5", "", "❯ /model", "  ⎿  Set model to Opus 5.5 for this session only with high effort", "", "────", "❯ ", "────"];
const promptScreen = ["⏺ hi", "", "────", "❯ ", "────", "  ⏸ manual mode on · ? for shortcuts"];

describe("claudeDialogIn", () => {
  it("reads \"Switch model?\" as one question, in Claude Code's own words, with the keys of each answer", () => {
    const d = claudeDialogIn(switchScreen())!;
    expect(d.id).toBe("switch-model:Opus 5.5");
    expect(d.body).toEqual({
      kind: "question",
      questions: [
        {
          header: "Model",
          question:
            "Switch to Opus 5.5? Your next response will be slower and use more tokens. This conversation is cached for the current model. Switching to Opus 5.5 means the full history gets re-read on your next message.",
          options: [
            { label: "Switch", description: "Yes, switch to Opus 5.5." },
            { label: "Don't switch", description: "Keep the model this session has." },
          ],
          multiSelect: false,
        },
      ],
    });
    expect(d.choices.map((c) => c.keys)).toEqual([["enter"], ["down", "enter"]]);
    expect(d.dismiss).toBe(d.choices[1]);
  });
  it("steers from the row the cursor is on, and names the model the dialog names", () => {
    const d = claudeDialogIn(switchScreen("Sonnet 5.5", 2))!;
    expect(d.id).toBe("switch-model:Sonnet 5.5");
    expect(d.choices.map((c) => c.keys)).toEqual([["up", "enter"], ["enter"]]);
  });
  it("closes the picker that \"No, go back\" leads to, and nothing else", () => {
    const then = claudeDialogIn(switchScreen())!.choices[1]!.then!;
    expect(then.key).toBe("escape");
    expect(then.when(pickerScreen(3))).toBe(true);
    expect(then.when(promptScreen)).toBe(false);
  });
  it("says which model the session was switched to once the dialog is gone, only when it is the one it asked about", () => {
    const d = claudeDialogIn(switchScreen())!;
    expect(d.chose!(switchedScreen)).toEqual({ model: "Opus 5.5", effort: "high" });
    expect(d.chose!(pickerScreen(3))).toBeNull();
    expect(claudeDialogIn(switchScreen("Sonnet 5.5"))!.chose!(switchedScreen)).toBeNull();
  });
  it("is null for any other screen, and for a dialog whose menu cannot be read", () => {
    expect(claudeDialogIn(promptScreen)).toBeNull();
    expect(claudeDialogIn(pickerScreen(2))).toBeNull();
    expect(claudeDialogIn(switchScreen().filter((l) => !l.includes("❯ 1.")))).toBeNull();
    expect(claudeDialogIn(switchScreen().filter((l) => !l.includes("No, go back")))).toBeNull();
  });
});

describe("sessionModelIn", () => {
  it("reads the newest switch for this session, with its effort level when it names one", () => {
    expect(sessionModelIn(switchedScreen)).toEqual({ model: "Opus 5.5", effort: "high" });
    expect(sessionModelIn(["  ⎿  Set model to Haiku 4.5 for this session only", "❯ "])).toEqual({ model: "Haiku 4.5", effort: undefined });
  });
  it("reads a line a narrow terminal wrapped", () => {
    expect(sessionModelIn(["  ⎿  Set model to Opus 5.5 for this", "     session only with xhigh effort", "❯ "])).toEqual({ model: "Opus 5.5", effort: "xhigh" });
  });
  it("is null when Claude Code's newest word is that it kept the model, or it said nothing", () => {
    expect(sessionModelIn([...switchedScreen.slice(3, 5), "❯ /model", "  ⎿  Kept model as Opus 5.5"])).toBeNull();
    expect(sessionModelIn(promptScreen)).toBeNull();
  });
});

describe("ScreenPrompts on a Claude Code session", () => {
  const setup = (steering = () => false) => {
    let at = 0;
    const registry = Object.assign(new EventEmitter(), {
      log: [] as string[],
      keys: [] as KeyName[],
      asks() { this.log.push("asks"); },
      asked() { this.log.push("asked"); },
      async sendKey(_id: string, k: KeyName) { this.keys.push(k); },
      chooseModel(_id: string, model: string, effort: string | undefined) { this.log.push(`chose ${model} ${effort}`); },
    });
    const prompts = new PromptStore({ newId: (() => { let n = 0; return () => `p-${++n}`; })() });
    const events: string[] = [];
    prompts.on("opened", (f) => events.push(`opened ${f.promptId}`));
    prompts.on("closed", (f) => events.push(`closed ${f.promptId} ${f.reason}`));
    const screens = new ScreenPrompts(registry, prompts, silentLogger, steering, () => at);
    const settle = () => new Promise((r) => setImmediate(r));
    return { registry, prompts, events, screens, settle, later: (ms: number) => { at += ms; }, show: (lines: string[]) => registry.emit("captured", "gr-c", "claude", lines) };
  };

  it("opens a card for \"Switch model?\", and \"Switch\" presses Yes: the session then has the model the screen says", async () => {
    const { registry, prompts, events, settle, show } = setup();
    show(switchScreen());
    expect(events).toEqual(["opened p-1"]);
    expect(prompts.answer("gr-c", "p-1", { allow: true, answers: [["Switch"]] })).toBe("answered");
    await settle();
    expect(registry.keys).toEqual(["enter"]);
    // The dialog is still on the screen while the key lands: no second card for it.
    show([...switchScreen(), ""]);
    expect(events).toEqual(["opened p-1", "closed p-1 answered"]);
    show(switchedScreen);
    expect(registry.log).toEqual(["asks", "asked", "chose Opus 5.5 high"]);
    expect(events).toEqual(["opened p-1", "closed p-1 answered"]);
  });
  it("opens no card while the daemon steers the screen itself (a switch from an app answers its own question)", () => {
    let steering = true;
    const { registry, events, show } = setup(() => steering);
    show(switchScreen());
    show(switchedScreen);
    expect(events).toEqual([]);
    expect(registry.log).toEqual([]);
    steering = false;
    show(switchScreen("Sonnet 5.5"));
    expect(events).toEqual(["opened p-1"]);
  });
  it("\"Don't switch\" presses No, then closes the picker Claude Code goes back to", async () => {
    const { registry, prompts, settle, show } = setup();
    show(switchScreen());
    expect(prompts.answer("gr-c", "p-1", { allow: true, answers: [["Don't switch"]] })).toBe("answered");
    await settle();
    expect(registry.keys).toEqual(["down", "enter"]);
    show(pickerScreen(3));
    expect(registry.keys).toEqual(["down", "enter", "escape"]);
    show(promptScreen);
    expect(registry.keys).toEqual(["down", "enter", "escape"]);
    expect(registry.log).toEqual(["asks", "asked"]);
  });
  it("a dismissed card says no too, and a picker that shows much later is left alone", async () => {
    const { registry, prompts, settle, later, show } = setup();
    show(switchScreen());
    expect(prompts.answer("gr-c", "p-1", { allow: false })).toBe("answered");
    await settle();
    expect(registry.keys).toEqual(["down", "enter"]);
    show(promptScreen);
    later(11_000);
    show(pickerScreen(3));
    expect(registry.keys).toEqual(["down", "enter"]);
  });
  it("closes the card when the question is answered in the terminal, and takes the model from the screen then too", () => {
    const { registry, events, show } = setup();
    show(switchScreen());
    show(switchedScreen);
    expect(events).toEqual(["opened p-1", "closed p-1 elsewhere"]);
    expect(registry.log).toEqual(["asks", "asked", "chose Opus 5.5 high"]);
    show(switchScreen("Sonnet 5.5"));
    show(pickerScreen(3));
    expect(events).toEqual(["opened p-1", "closed p-1 elsewhere", "opened p-2", "closed p-2 elsewhere"]);
    expect(registry.keys).toEqual([]);
  });
  it("opens the card at once for a screen handed to it, and not again when the capture shows the same", () => {
    const { events, screens, show } = setup();
    screens.saw("gr-c", "claude", switchScreen());
    show(switchScreen());
    expect(events).toEqual(["opened p-1"]);
  });
});

describe("a dialog on a hook-driven session's screen", () => {
  const hooked = (over: Partial<StatusState>): StatusState => ({ status: "idle", since: 10, lastOutputAt: 10, hookDriven: true, ...over });

  it("waits for an answer, and is what it was before once the dialog is gone", () => {
    const idle = hooked({ waitingFor: "done" });
    const asking = reduceStatus(idle, { kind: "asks", at: 20 });
    expect(asking).toMatchObject({ status: "waiting", waitingFor: "answer", since: 20 });
    expect(reduceStatus(asking, { kind: "asked", at: 30 })).toEqual({ ...idle, beforeAsk: undefined });
  });
  it("goes back to a turn that stopped partway, with why", () => {
    const stopped = hooked({ status: "waiting", waitingFor: "stopped", stoppedBecause: "sleep" });
    const after = run(stopped, [{ kind: "asks", at: 20 }, { kind: "asked", at: 30 }]);
    expect(after).toMatchObject({ status: "waiting", waitingFor: "stopped", since: 10 });
    expect(shownStoppedBecause(after)).toBe("sleep");
  });
  it("a finished turn looked at while the dialog was up has been seen", () => {
    const done = hooked({ status: "waiting", waitingFor: "done" });
    const after = run(done, [{ kind: "asks", at: 20 }, { kind: "seen", at: 25 }, { kind: "asked", at: 30 }]);
    expect(after).toMatchObject({ status: "idle", waitingFor: "done" });
  });
  it("a hook in between knows better", () => {
    const after = run(hooked({}), [{ kind: "asks", at: 20 }, { kind: "hook", status: "working", at: 25 }, { kind: "asked", at: 30 }]);
    expect(after).toMatchObject({ status: "working", since: 25 });
    expect(after.beforeAsk).toBeUndefined();
  });
  it("changes nothing for a session whose status comes from the screen, or one that asked nothing", () => {
    const heuristic: StatusState = { status: "waiting", since: 5, lastOutputAt: 5, hookDriven: false, waitingFor: "answer" };
    expect(reduceStatus(heuristic, { kind: "asked", at: 30 })).toBe(heuristic);
    const idle = hooked({});
    expect(reduceStatus(idle, { kind: "asked", at: 30 })).toBe(idle);
  });
});

function run(start: StatusState, events: Parameters<typeof reduceStatus>[1][]): StatusState {
  return events.reduce(reduceStatus, start);
}
