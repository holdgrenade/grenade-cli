/** Narrowed frame types derived from the protocol unions (the protocol package exports schemas, not per-frame types). */
import type { DaemonFrame } from "@grenade/protocol";

export type ScreenFrame = Extract<DaemonFrame, { type: "screen" }>;
export type HistoryFrame = Extract<DaemonFrame, { type: "history" }>;
