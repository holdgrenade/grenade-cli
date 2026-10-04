/**
 * OpenAI, for Talk: a Realtime client secret (`ek_…`) that stands in for the key on the Realtime WebSocket. It opens
 * one connection, and one made for a model opens that model only (tried against the API, 2026-10-04).
 */
import { VOICE_USE_TALK } from "@grenade/protocol";
import { field, type VoiceProvider } from "./voiceProvider.js";

/** How long the token can open its connection. */
export const OPENAI_TOKEN_SECONDS = 60;

export const openai: VoiceProvider = {
  id: "openai",
  name: "OpenAI",
  uses: [VOICE_USE_TALK],
  tokenRequest(key, ask) {
    return {
      url: "https://api.openai.com/v1/realtime/client_secrets",
      headers: { Authorization: `Bearer ${key}` },
      body: {
        expires_after: { anchor: "created_at", seconds: OPENAI_TOKEN_SECONDS },
        ...(ask.model ? { session: { type: "realtime", model: ask.model } } : {}),
      },
    };
  },
  readToken(body, ask) {
    const token = field(body, "value");
    const expires = field(body, "expires_at");
    if (typeof token !== "string" || !token) return null;
    const expiresAt = typeof expires === "number" ? new Date(expires * 1000) : new Date(ask.now.getTime() + OPENAI_TOKEN_SECONDS * 1000);
    return { token, expiresAt, once: true };
  },
};
