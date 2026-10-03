/**
 * Background tasks read off the screen, for Codex (PROTOCOL.md "Background tasks"): every changed capture of a Codex
 * session says how many background terminals run (`codexBackgroundIn`), and the registry holds the session `working`
 * while any does and lets it finish when the line is gone.
 */
import type { AgentKind, ReportedBackgroundTask } from "@grenade/protocol";
import { codexBackgroundIn } from "./codexBackground.js";
import { countedTasks } from "./heldTasks.js";

export interface ScreenBackgroundPort {
  on(event: "captured", cb: (id: string, agent: AgentKind, lines: string[]) => void): unknown;
  screenBackground(id: string, tasks: ReportedBackgroundTask[]): void;
}

export function watchScreenBackground(registry: ScreenBackgroundPort): void {
  registry.on("captured", (id, agent, lines) => {
    if (agent === "codex") registry.screenBackground(id, countedTasks(codexBackgroundIn(lines)));
  });
}
