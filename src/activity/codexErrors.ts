/**
 * Pure: whether a turn's newest activity ends on an error (PROTOCOL.md "Codex hooks"): Codex writes its `error` event
 * to the rollout (an `errored` entry) and then sends `Stop`, so the turn stopped without finishing, as a Claude Code
 * `StopFailure` says.
 */
import type { ActivityEntry } from "@grenade/protocol";

export function endsWithError(entries: readonly ActivityEntry[]): boolean {
  return entries.at(-1)?.kind === "errored";
}
