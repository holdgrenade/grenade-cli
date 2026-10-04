/** Asks a provider for a short-lived token with the owner's key. The one place a key leaves this computer, to its provider only. */
import { withoutKey } from "./voiceKey.js";
import { refusalWords, VoiceError, type MintedToken, type TokenAsk, type VoiceProvider } from "./voiceProvider.js";

/** How long a provider gets to answer (PROTOCOL.md "Voice providers"). */
export const MINT_TIMEOUT_MS = 10_000;

export type Fetch = typeof fetch;

export async function mintToken(provider: VoiceProvider, key: string, ask: TokenAsk, io: { fetch?: Fetch; timeoutMs?: number } = {}): Promise<MintedToken> {
  const request = provider.tokenRequest(key, ask);
  let status: number;
  let body: unknown;
  try {
    const res = await (io.fetch ?? fetch)(request.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...request.headers },
      body: JSON.stringify(request.body),
      signal: AbortSignal.timeout(io.timeoutMs ?? MINT_TIMEOUT_MS),
    });
    status = res.status;
    body = await res.json().catch(() => null);
  } catch {
    // Never the error's own text: a failed request can name its headers.
    throw new VoiceError("provider_failed", `${provider.name} did not answer.`);
  }
  if (status < 200 || status >= 300) throw new VoiceError("provider_failed", withoutKey(refusalWords(body) ?? `${provider.name} answered ${status}.`, key));
  const minted = provider.readToken(body, ask);
  if (!minted) throw new VoiceError("provider_failed", `${provider.name} sent no token.`);
  return minted;
}
