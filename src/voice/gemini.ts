/**
 * Google's Gemini, for Talk: an ephemeral token of the Live API (ai.google.dev "Ephemeral tokens"), which the client
 * sends as `Authorization: Token` to the `BidiGenerateContentConstrained` socket. One session per token. Written from
 * the docs (2026-10-04); not yet tried against the API.
 */
import { VOICE_USE_TALK } from "@grenade/protocol";
import { field, type VoiceProvider } from "./voiceProvider.js";

/** How long the token can open its session, and how long that session may speak (Talk opens a new one before then). */
export const GEMINI_START_SECONDS = 60;
export const GEMINI_SESSION_SECONDS = 30 * 60;

export const gemini: VoiceProvider = {
  id: "gemini",
  name: "Google",
  uses: [VOICE_USE_TALK],
  tokenRequest(key, ask) {
    return {
      url: "https://generativelanguage.googleapis.com/v1beta/auth_tokens",
      // In a header, never in the URL, which is what ends up in logs.
      headers: { "x-goog-api-key": key },
      body: {
        uses: 1,
        newSessionExpireTime: new Date(ask.now.getTime() + GEMINI_START_SECONDS * 1000).toISOString(),
        expireTime: new Date(ask.now.getTime() + GEMINI_SESSION_SECONDS * 1000).toISOString(),
      },
    };
  },
  readToken(body, ask) {
    const token = field(body, "name");
    if (typeof token !== "string" || !token) return null;
    return { token, expiresAt: new Date(ask.now.getTime() + GEMINI_START_SECONDS * 1000), once: true };
  },
};
