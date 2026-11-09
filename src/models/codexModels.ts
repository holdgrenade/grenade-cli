/**
 * The models a Codex session can be switched to (PROTOCOL.md "Models"), from Codex's own `models_cache.json` in
 * `CODEX_HOME`: the ones it lists in its `/model` picker (`visibility: "list"`), in the picker's order (`priority`),
 * named as the picker names them (`display_name`), each with its effort levels. A Codex that has written no cache
 * yet has no models to offer, and its sessions show the model's name only.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ModelChoice } from "@grenade/protocol";

export interface CodexModel {
  /** What hooks and rollouts call it (`gpt-6-luna`). */
  slug: string;
  /** What the picker and a client call it (`GPT-6-Luna`). */
  name: string;
  efforts: string[];
  defaultEffort?: string;
}

/** Pure: the listed models in a `models_cache.json`, in the picker's order. */
export function codexModelsIn(cache: unknown): CodexModel[] {
  const models = (cache as { models?: unknown } | null)?.models;
  if (!Array.isArray(models)) return [];
  const listed = models.flatMap((m) => {
    const { slug, display_name, visibility, priority, supported_reasoning_levels, default_reasoning_level } = (m ?? {}) as Record<string, unknown>;
    if (typeof slug !== "string" || !slug || visibility !== "list") return [];
    const efforts = Array.isArray(supported_reasoning_levels)
      ? supported_reasoning_levels.flatMap((l) => {
          const effort = typeof l === "string" ? l : (l as { effort?: unknown } | null)?.effort;
          return typeof effort === "string" && /^[a-z]{1,16}$/.test(effort) ? [effort] : [];
        })
      : [];
    const model: CodexModel = { slug, name: typeof display_name === "string" && display_name ? display_name.slice(0, 60) : slug, efforts };
    if (typeof default_reasoning_level === "string" && efforts.includes(default_reasoning_level)) model.defaultEffort = default_reasoning_level;
    return [{ model, priority: typeof priority === "number" ? priority : Number.MAX_SAFE_INTEGER }];
  });
  return listed.sort((a, b) => a.priority - b.priority).map((l) => l.model);
}

/** Codex's listed models on this computer; none when it has no cache yet. */
export function readCodexModels(codexDir: string): CodexModel[] {
  try {
    return codexModelsIn(JSON.parse(readFileSync(join(codexDir, "models_cache.json"), "utf8")));
  } catch {
    return [];
  }
}

/** Pure: the models as `AgentInfo.models` carries them (at most 20, each with at most 8 efforts). */
export function modelChoices(models: readonly CodexModel[]): ModelChoice[] {
  return models.slice(0, 20).map((m) => (m.efforts.length > 0 ? { name: m.name, efforts: m.efforts.slice(0, 8) } : { name: m.name }));
}

/** Pure: a slug as a client names it, the picker's name when the model is listed. */
export function codexModelName(models: readonly CodexModel[], slug: string): string {
  return models.find((m) => m.slug === slug)?.name ?? slug;
}
