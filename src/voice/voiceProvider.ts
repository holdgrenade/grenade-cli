/**
 * What the daemon needs to know of a voice provider (PROTOCOL.md "Voice providers"): its name, what it is used for,
 * and how a short-lived token is asked of it with the owner's key. One file per provider implements this, each pure:
 * it builds the request and reads the answer, and `mintToken.ts` does the talking. Adding a provider is one more file
 * and one more line in `voiceCatalog.ts`.
 */

/** What a token is asked for. */
export interface TokenAsk {
  /** `talk` or `dictation`: one of the provider's `uses`. */
  use: string;
  /** The provider's own id for the model the connection will use, when the client named one. */
  model?: string | undefined;
  /** This daemon's id, for a provider that wants to know whose token it is. */
  daemonId: string;
  now: Date;
}

/** A `POST` with a JSON body. */
export interface TokenRequest {
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

export interface MintedToken {
  token: string;
  /** When it can no longer open a connection. */
  expiresAt: Date;
  /** It opens one connection. */
  once: boolean;
}

export interface VoiceProvider {
  id: string;
  /** The company, as a client says it. */
  name: string;
  uses: string[];
  tokenRequest(key: string, ask: TokenAsk): TokenRequest;
  /** Reads the provider's answer to a request it took. Null when it holds no token. */
  readToken(body: unknown, ask: TokenAsk): MintedToken | null;
}

/** Why a key was not kept or a token not made, in words for the owner. `code` is the `error` frame's. */
export class VoiceError extends Error {
  constructor(
    readonly code: "bad_frame" | "provider_failed",
    message: string,
  ) {
    super(message);
  }
}

/** The provider's own words in an answer that refused: `{error: {message}}`, or `error`, `message` or `detail` as text. */
export function refusalWords(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const b = body as Record<string, unknown>;
  const error = b["error"];
  if (typeof error === "object" && error !== null && typeof (error as Record<string, unknown>)["message"] === "string") return (error as { message: string }).message;
  for (const field of [error, b["message"], b["detail"]]) if (typeof field === "string" && field) return field;
  return undefined;
}

export function field(body: unknown, name: string): unknown {
  return typeof body === "object" && body !== null ? (body as Record<string, unknown>)[name] : undefined;
}
