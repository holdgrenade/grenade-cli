/** Every voice provider this daemon can get tokens from (PROTOCOL.md "Voice providers"), in the order clients list them. */
import { gemini } from "./gemini.js";
import { openai } from "./openai.js";
import type { VoiceProvider } from "./voiceProvider.js";
import { wisprFlow } from "./wisprFlow.js";

export const VOICE_PROVIDERS: VoiceProvider[] = [openai, gemini, wisprFlow];

export function voiceProvider(id: string, providers: VoiceProvider[] = VOICE_PROVIDERS): VoiceProvider | undefined {
  return providers.find((p) => p.id === id);
}
