import { describe, expect, it } from "vitest";
import type { KeyName } from "@grenade/protocol";
import { codexModelName, codexModelsIn, modelChoices, type CodexModel } from "../src/models/codexModels.js";
import { codexComposerText, codexEffortMenuIn, codexModelMenuIn, codexSwitchedIn, effortOfLabel } from "../src/models/codexModelPicker.js";
import { effortFor, switchCodexModel } from "../src/models/codexModelSwitch.js";
import { ModelSwitchError } from "../src/models/claudeModelSwitch.js";
import { codexTurnIn } from "../src/prompts/codexRollout.js";

const cache = {
  models: [
    { slug: "gpt-reserve", display_name: "GPT-Reserve", visibility: "hide", priority: 1, supported_reasoning_levels: [{ effort: "low" }] },
    { slug: "gpt-5.6-terra", display_name: "GPT-5.6-Terra", visibility: "list", priority: 8, default_reasoning_level: "medium", supported_reasoning_levels: ["low", "medium", "high", "xhigh", "max", "ultra"].map((effort) => ({ effort, description: "" })) },
    { slug: "gpt-6-luna", display_name: "GPT-6-Luna", visibility: "list", priority: 4, default_reasoning_level: "medium", supported_reasoning_levels: ["low", "medium", "high", "xhigh", "max"].map((effort) => ({ effort })) },
  ],
};

describe("codexModelsIn", () => {
  it("lists what the picker lists, in its order, named as it names them", () => {
    const models = codexModelsIn(cache);
    expect(models.map((m) => [m.slug, m.name, m.defaultEffort])).toEqual([["gpt-6-luna", "GPT-6-Luna", "medium"], ["gpt-5.6-terra", "GPT-5.6-Terra", "medium"]]);
    expect(modelChoices(models)).toEqual([
      { name: "GPT-6-Luna", efforts: ["low", "medium", "high", "xhigh", "max"] },
      { name: "GPT-5.6-Terra", efforts: ["low", "medium", "high", "xhigh", "max", "ultra"] },
    ]);
    expect(codexModelName(models, "gpt-5.6-terra")).toBe("GPT-5.6-Terra");
    expect(codexModelName(models, "gpt-unknown")).toBe("gpt-unknown");
    expect(codexModelsIn(null)).toEqual([]);
  });
});

describe("codexTurnIn", () => {
  it("reads the newest turn's model, effort and mode", () => {
    const jsonl = [
      { timestamp: "2026-11-09T19:00:00.000Z", type: "turn_context", payload: { model: "gpt-6-luna", effort: "medium", collaboration_mode: { mode: "default" } } },
      { timestamp: "2026-11-09T19:05:00.000Z", type: "turn_context", payload: { model: "gpt-5.6-terra", effort: "high", collaboration_mode: { mode: "plan" } } },
      { type: "event_msg", payload: { type: "token_count" } },
    ].map((l) => JSON.stringify(l)).join("\n");
    expect(codexTurnIn(jsonl)).toEqual({ model: "gpt-5.6-terra", effort: "high", mode: "plan", at: "2026-11-09T19:05:00.000Z" });
    expect(codexTurnIn("")).toBeNull();
  });
});

describe("effortFor", () => {
  const terra = codexModelsIn(cache)[1]!;
  it("takes the level asked for, else the session's where the model has it, else its default", () => {
    expect(effortFor(terra, "ultra", "low")).toBe("ultra");
    expect(effortFor(terra, undefined, "high")).toBe("high");
    expect(effortFor({ ...terra, efforts: ["low", "medium"] }, undefined, "high")).toBe("medium");
  });
});

/** A Codex picker as 0.160 draws it, driven by keys. */
class FakeCodex {
  composer = "";
  screen: "prompt" | "models" | "levels" | "advanced" = "prompt";
  cursor = 0;
  chosen = "";
  log: string[] = [];
  planMode = false;
  constructor(
    private readonly models: CodexModel[],
    private readonly current: { slug: string; effort: string },
  ) {}
  private levels(): string[] {
    const m = this.models.find((x) => x.name === this.chosen)!;
    const main = m.efforts.filter((e) => ["low", "medium", "high", "xhigh"].includes(e));
    return m.efforts.some((e) => e === "max" || e === "ultra") ? [...main, "more"] : main;
  }
  private advanced(): string[] {
    return this.models.find((x) => x.name === this.chosen)!.efforts.filter((e) => e === "max" || e === "ultra");
  }
  private label(e: string): string {
    return { low: "Low", medium: "Medium", high: "High", xhigh: "Extra high", max: "Max", ultra: "Ultra", more: "More reasoning…" }[e] ?? e;
  }
  private rows(names: string[]): string[] {
    return names.map((n, i) => `${i === this.cursor ? "›" : " "} ${i + 1}. ${n}  Description`);
  }
  async lines(): Promise<string[]> {
    const footer = `  GPT-6-Luna default · ~/code/api${this.planMode ? " · Plan mode" : ""}`;
    if (this.screen === "models") return ["  Select Model and Effort", ...this.rows(this.models.map((m) => (m.slug === this.current.slug ? `${m.name} (current)` : m.name))), "  enter select · esc back"];
    if (this.screen === "levels") {
      const keys = this.levels()[this.cursor] === "more" ? "  enter select · esc back" : "  enter default · s session · esc back";
      return [`  Select Reasoning Level for ${this.chosen}`, ...this.rows(this.levels().map((e) => this.label(e))), keys];
    }
    if (this.screen === "advanced") return ["  Advanced Reasoning", "  ⚠ Consumes usage limits faster", ...this.rows(this.advanced().map((e) => this.label(e))), "  enter default · s session · esc back"];
    return [...this.log, `› ${this.composer || "Ask Codex to do anything"}`, footer];
  }
  async type(text: string): Promise<void> {
    if (this.screen === "prompt") this.composer += text;
    else if (text === "s" && (this.screen === "levels" || this.screen === "advanced")) {
      const list = this.screen === "levels" ? this.levels() : this.advanced();
      const slug = this.models.find((m) => m.name === this.chosen)!.slug;
      this.log.push(`• Model changed to ${slug} ${list[this.cursor]} for this session only`);
      this.screen = "prompt";
    }
  }
  async key(key: KeyName): Promise<void> {
    const size = { models: this.models.length, levels: this.screen === "levels" ? this.levels().length : 0, advanced: this.screen === "advanced" ? this.advanced().length : 0, prompt: 0 }[this.screen];
    if (key === "down") this.cursor = Math.min(this.cursor + 1, size - 1);
    else if (key === "up") this.cursor = Math.max(this.cursor - 1, 0);
    else if (key === "escape") this.screen = "prompt";
    else if (key === "backspace") this.composer = this.composer.slice(0, -1);
    else if (key === "enter") {
      if (this.screen === "prompt" && this.composer === "/model") {
        this.composer = "";
        this.screen = "models";
        this.cursor = this.models.findIndex((m) => m.slug === this.current.slug);
      } else if (this.screen === "models") {
        this.chosen = this.models[this.cursor]!.name;
        this.screen = "levels";
        this.cursor = Math.max(0, this.levels().indexOf("medium"));
      } else if (this.screen === "levels" && this.levels()[this.cursor] === "more") {
        this.screen = "advanced";
        this.cursor = 0;
      } else if (this.screen === "levels" || this.screen === "advanced") {
        throw new Error("Enter on a level saves Codex's default: never pressed");
      }
    }
  }
}

const timing = { wait: async () => {}, patienceMs: 200 };

describe("switchCodexModel", () => {
  const models = codexModelsIn(cache);

  it("moves to the model and the level and presses s, for this session only", async () => {
    const codex = new FakeCodex(models, { slug: "gpt-6-luna", effort: "medium" });
    expect(await switchCodexModel(codex, models[1]!, "high", timing)).toEqual({ effort: "high" });
    expect(codex.log.at(-1)).toBe("• Model changed to gpt-5.6-terra high for this session only");
  });

  it("goes through More reasoning… for Max and Ultra", async () => {
    const codex = new FakeCodex(models, { slug: "gpt-6-luna", effort: "medium" });
    expect(await switchCodexModel(codex, models[1]!, "ultra", timing)).toEqual({ effort: "ultra" });
    expect(codex.log.at(-1)).toBe("• Model changed to gpt-5.6-terra ultra for this session only");
  });

  it("refuses in Plan mode, with text in the prompt, or a level the model lacks, and leaves the picker closed", async () => {
    const plan = new FakeCodex(models, { slug: "gpt-6-luna", effort: "medium" });
    plan.planMode = true;
    await expect(switchCodexModel(plan, models[1]!, "high", timing)).rejects.toThrow(/Plan mode/);
    const typed = new FakeCodex(models, { slug: "gpt-6-luna", effort: "medium" });
    typed.composer = "half a prompt";
    await expect(switchCodexModel(typed, models[1]!, "high", timing)).rejects.toThrow(/not empty/);
    const lacking = new FakeCodex(models, { slug: "gpt-6-luna", effort: "medium" });
    await expect(switchCodexModel(lacking, models[0]!, "ultra", timing)).rejects.toBeInstanceOf(ModelSwitchError);
    expect(lacking.screen).toBe("prompt");
  });
});

describe("codexModelPicker", () => {
  it("reads the screens Codex drew", () => {
    const models = ["  Select Model and Effort", "› 1. GPT-6-Luna (current)  Fast and affordable model for easier tasks.", "  2. GPT-5.6-Terra         Older balanced model.", "  enter select · esc back"];
    expect(codexModelMenuIn(models)).toEqual({ rows: ["GPT-6-Luna", "GPT-5.6-Terra"], selected: 0 });
    const levels = [
      "  Select Reasoning Level for GPT-6-Luna",
      "  1. Low               Fast responses with lighter reasoning",
      "› 2. Medium (default)  Balances speed and reasoning depth for everyday tasks",
      "  4. Extra high        Extra high reasoning depth for complex problems",
      "  5. More reasoning…   Max consumes usage limits faster",
      "  enter default · s session · esc back",
    ];
    expect(codexEffortMenuIn(levels)).toEqual({ rows: ["low", "medium", "xhigh", "more"], selected: 1, advanced: false });
    expect(effortOfLabel("Extra high")).toBe("xhigh");
    expect(codexSwitchedIn(["• Model changed to gpt-6-luna max for this session only", "› Ask Codex to do anything"])).toEqual({ slug: "gpt-6-luna", effort: "max" });
    expect(codexComposerText(["› Ask Codex to do anything", "  GPT-6-Luna default"])).toBe("");
    expect(codexComposerText(["› /model", "  GPT-6-Luna default"])).toBe("/model");
  });
});
