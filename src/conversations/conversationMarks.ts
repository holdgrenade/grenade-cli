/**
 * Grenade's own mark on Claude Code conversations, kept in ~/.grenade/conversations.json so every client sees the
 * same (PROTOCOL.md "Conversations"): which are copies Grenade made by resuming another. (grenade-cli 1.0.14 also kept
 * archived ids here; they are dropped on the next save.) Nothing here ever touches a Claude Code file.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Logger } from "../log.js";

interface Saved {
  /** Copy id → the id of the conversation it was resumed from. */
  copies?: Record<string, string>;
}

export class ConversationMarks {
  private readonly copies = new Map<string, string>();

  /** `path` undefined keeps the marks in memory only (tests). */
  constructor(
    private readonly log: Logger,
    private readonly path?: string,
  ) {
    if (!path || !existsSync(path)) return;
    try {
      const saved = JSON.parse(readFileSync(path, "utf8")) as Saved;
      for (const [copy, from] of Object.entries(saved.copies ?? {})) this.copies.set(copy, from);
    } catch (e) {
      log.warn("Could not read conversations.json; copies show without their original", { error: e });
    }
  }

  /** The conversation `id` is a copy of, if Grenade made it by resuming one. */
  copyOf(id: string): string | undefined {
    return this.copies.get(id);
  }

  noteCopy(copy: string, from: string): void {
    if (this.copies.get(copy) === from) return;
    this.copies.set(copy, from);
    this.save();
  }

  private save(): void {
    if (!this.path) return;
    const saved: Saved = { copies: Object.fromEntries(this.copies) };
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      writeFileSync(this.path, JSON.stringify(saved, null, 2) + "\n");
    } catch (e) {
      this.log.warn("Could not save conversations.json", { error: e });
    }
  }
}
