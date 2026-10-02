/**
 * Grenade's own marks on Claude Code conversations, kept in ~/.grenade/conversations.json so every client sees the
 * same (PROTOCOL.md "Conversations"): which are archived, and which are copies Grenade made by resuming another.
 * Nothing here ever touches a Claude Code file.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Logger } from "../log.js";

interface Saved {
  archived?: string[];
  /** Copy id → the id of the conversation it was resumed from. */
  copies?: Record<string, string>;
}

export class ConversationMarks {
  private readonly archived = new Set<string>();
  private readonly copies = new Map<string, string>();

  /** `path` undefined keeps the marks in memory only (tests). */
  constructor(
    private readonly log: Logger,
    private readonly path?: string,
  ) {
    if (!path || !existsSync(path)) return;
    try {
      const saved = JSON.parse(readFileSync(path, "utf8")) as Saved;
      for (const id of saved.archived ?? []) this.archived.add(id);
      for (const [copy, from] of Object.entries(saved.copies ?? {})) this.copies.set(copy, from);
    } catch (e) {
      log.warn("Could not read conversations.json; archived conversations show again", { error: e });
    }
  }

  isArchived(id: string): boolean {
    return this.archived.has(id);
  }

  /** The conversation `id` is a copy of, if Grenade made it by resuming one. */
  copyOf(id: string): string | undefined {
    return this.copies.get(id);
  }

  setArchived(id: string, archived: boolean): void {
    if (archived === this.archived.has(id)) return;
    if (archived) this.archived.add(id);
    else this.archived.delete(id);
    this.save();
  }

  noteCopy(copy: string, from: string): void {
    if (this.copies.get(copy) === from) return;
    this.copies.set(copy, from);
    this.save();
  }

  private save(): void {
    if (!this.path) return;
    const saved: Saved = { archived: [...this.archived], copies: Object.fromEntries(this.copies) };
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      writeFileSync(this.path, JSON.stringify(saved, null, 2) + "\n");
    } catch (e) {
      this.log.warn("Could not save conversations.json", { error: e });
    }
  }
}
