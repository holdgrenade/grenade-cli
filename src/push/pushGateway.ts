/** Posts one push (a sealed notification or a board push) to a relay's push route (PROTOCOL.md "Push route") and says what became of it. */
import { PushError, RELAY_PUSH_PATH, type PushRouteRequest } from "@grenade/protocol";
import type { PushGateway } from "./pushConfig.js";

export type PushOutcome =
  /** The push service took it. */
  | "sent"
  /** The device token is dead: forget the registration. */
  | "unregistered"
  /** Worth one more try: the relay or the push service could not be reached, or failed. */
  | "retry"
  /** Refused: trying again with the same request will not help. */
  | "refused";

export interface PushResult {
  outcome: PushOutcome;
  status?: number;
  /** The route's error code, or what went wrong on the way. */
  error?: string;
}

/** Pure: the route's HTTP status → what to do. */
export function outcomeOf(status: number): PushOutcome {
  if (status >= 200 && status < 300) return "sent";
  if (status === 410) return "unregistered";
  if (status === 502 || status === 503 || status === 504 || status === 408) return "retry";
  return "refused";
}

export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

export async function postPush(gateway: PushGateway, request: PushRouteRequest, fetchFn: Fetch = fetch, timeoutMs = 10_000): Promise<PushResult> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (gateway.key) headers["authorization"] = `Bearer ${gateway.key}`;
  try {
    const res = await fetchFn(gateway.url + RELAY_PUSH_PATH, { method: "POST", headers, body: JSON.stringify(request), signal: AbortSignal.timeout(timeoutMs) });
    const outcome = outcomeOf(res.status);
    if (outcome === "sent") return { outcome, status: res.status };
    const body = PushError.safeParse(await res.json().catch(() => null));
    return { outcome, status: res.status, error: body.success ? body.data.error : `http_${res.status}` };
  } catch (e) {
    return { outcome: "retry", error: e instanceof Error ? e.message : String(e) };
  }
}
