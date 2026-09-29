/**
 * Drives the registry from tmux on a timer:
 * - every 200 ms: capture every subscribed session (live screen on the phone)
 * - every 1 s: list tmux sessions to detect gone ones, and capture unsubscribed sessions
 *   so lastLine and the status heuristics stay fresh.
 */
import type { Logger } from "../log.js";
import { isGrenadeSession } from "../tmux/parse.js";
import type { Tmux } from "../tmux/tmux.js";
import type { SessionRegistry } from "./registry.js";

export const FAST_INTERVAL_MS = 200;
export const SLOW_EVERY_TICKS = 5;

export interface Poller {
  stop(): void;
  /** Run one tick now (used by tests and by subscribe to refresh promptly). */
  tick(): Promise<void>;
}

export function startPoller(deps: { tmux: Tmux; registry: SessionRegistry; log: Logger; intervalMs?: number }): Poller {
  const { tmux, registry, log } = deps;
  let ticks = 0;
  let busy = false;

  const captureAll = async (ids: string[]) => {
    await Promise.all(
      ids.map(async (id) => {
        try {
          registry.updateScreen(id, await tmux.capture(id));
        } catch (e) {
          log.debug("Screen capture failed", { session: id, error: e });
        }
      }),
    );
  };

  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      ticks++;
      const subscribed = new Set(registry.subscribedIds());
      if (ticks % SLOW_EVERY_TICKS === 0) {
        const live = new Set((await tmux.listSessions()).filter(isGrenadeSession));
        for (const id of registry.liveIds()) if (!live.has(id)) registry.markGone(id);
        await captureAll(registry.liveIds());
      } else {
        await captureAll([...subscribed].filter((id) => registry.get(id)?.status !== "gone"));
      }
    } catch (e) {
      log.warn("Could not check on sessions", { error: e });
    } finally {
      busy = false;
    }
  };

  const timer = setInterval(() => void tick(), deps.intervalMs ?? FAST_INTERVAL_MS);
  timer.unref();
  return { stop: () => clearInterval(timer), tick };
}
