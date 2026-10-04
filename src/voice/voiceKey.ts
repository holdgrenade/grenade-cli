/** An API key as the owner pasted it: cleaned before it is kept, masked before it is shown. Pure. */
import { VOICE_KEY_MAX } from "@grenade/protocol";

/** What was pasted, trimmed, without a "Bearer " in front. Null when nothing that could be a key is left. */
export function cleanVoiceKey(pasted: string): string | null {
  let key = pasted.trim();
  if (key.toLowerCase().startsWith("bearer ")) key = key.slice("bearer ".length).trim();
  if (!key || key.toLowerCase() === "bearer" || /\s/.test(key) || key.length > VOICE_KEY_MAX) return null;
  return key;
}

/** Enough of the key to tell which one it is, never enough to use: "sk-…a1b2" (PROTOCOL.md "Voice providers"). */
export function maskVoiceKey(key: string): string {
  return key.length > 10 ? `${key.slice(0, 3)}…${key.slice(-4)}` : "…";
}

/** A provider's words with the key taken out, should they repeat it. */
export function withoutKey(words: string, key: string): string {
  return words.split(key).join("<key>");
}
