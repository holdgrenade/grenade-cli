/** voice-keys.json: the owner's API key per voice provider, readable by this user only. `{ "openai": "sk-…" }`. */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type VoiceKeys = Record<string, string>;

export function loadVoiceKeys(path: string): VoiceKeys {
  if (!existsSync(path)) return {};
  try {
    const j: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof j !== "object" || j === null) return {};
    return Object.fromEntries(Object.entries(j).filter((e): e is [string, string] => typeof e[1] === "string" && e[1] !== ""));
  } catch {
    return {};
  }
}

export function saveVoiceKeys(path: string, keys: VoiceKeys): void {
  mkdirSync(dirname(path), { recursive: true });
  // The mode below counts only when the file is made, so one from before is closed to others before a key goes in.
  if (existsSync(path)) chmodSync(path, 0o600);
  writeFileSync(path, JSON.stringify(keys, null, 2) + "\n", { mode: 0o600 });
}
