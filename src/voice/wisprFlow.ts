/**
 * Wispr Flow, for dictation: a client access token (api-docs.wisprflow.ai "Generate Access Token"), which the client
 * sends to the `client_ws` socket. It can open sockets until it expires. Written from the docs (2026-10-04); not yet
 * tried against the API.
 */
import { VOICE_USE_DICTATION } from "@grenade/protocol";
import { field, type VoiceProvider } from "./voiceProvider.js";

/** How long a token lasts. The mic is used often, so a client keeps one in memory for this long. */
export const WISPR_TOKEN_SECONDS = 15 * 60;

export const wisprFlow: VoiceProvider = {
  id: "wispr-flow",
  name: "Wispr Flow",
  uses: [VOICE_USE_DICTATION],
  tokenRequest(key, ask) {
    return {
      url: "https://platform-api.wisprflow.ai/api/v1/dash/generate_access_token",
      headers: { Authorization: `Bearer ${key}` },
      // Wispr Flow wants the same client id for every token of one user: this computer's owner.
      body: { client_id: ask.daemonId, duration_secs: WISPR_TOKEN_SECONDS },
    };
  },
  readToken(body, ask) {
    const token = field(body, "access_token");
    const seconds = field(body, "expires_in");
    if (typeof token !== "string" || !token) return null;
    const lasts = typeof seconds === "number" && seconds > 0 ? seconds : WISPR_TOKEN_SECONDS;
    return { token, expiresAt: new Date(ask.now.getTime() + lasts * 1000), once: false };
  },
};
