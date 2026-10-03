/**
 * The Mac boards phones registered (PROTOCOL.md "Mac board"): `~/.grenade/push-boards.json` (mode 0600), one per
 * paired phone, keyed by its device id (`p_…`), a later `board.register` replacing it. Each keeps the board last
 * sent, so a restarted daemon neither alerts again for what the phone shows nor misses a change made meanwhile.
 * A board lives no longer than its pairing: `prune` drops the ones whose phone is gone.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { BoardState, PushEnvironment, PushProvider } from "@grenade/protocol";

export interface BoardDevice {
  /** The paired phone's device id. */
  id: string;
  provider: PushProvider;
  /** The Live Activity's push token. */
  pushToken: string;
  environment: PushEnvironment;
  topic: string;
  registeredAt: string;
  /** The board the push route last took, or the one the phone drew itself when it registered. */
  sent: BoardState | null;
}

export class BoardDevices {
  private readonly boards = new Map<string, BoardDevice>();

  constructor(private readonly path?: string) {
    this.load();
  }

  get(id: string): BoardDevice | undefined {
    return this.boards.get(id);
  }

  list(): BoardDevice[] {
    return [...this.boards.values()];
  }

  /** Replaces the phone's board. */
  set(board: BoardDevice): void {
    this.boards.set(board.id, board);
    this.save();
  }

  remove(id: string): boolean {
    if (!this.boards.delete(id)) return false;
    this.save();
    return true;
  }

  /** Drops every board whose phone is no longer paired. Returns the ids that went. */
  prune(paired: ReadonlySet<string>): string[] {
    const gone = this.list().map((b) => b.id).filter((id) => !paired.has(id));
    if (gone.length === 0) return gone;
    for (const id of gone) this.boards.delete(id);
    this.save();
    return gone;
  }

  private load(): void {
    if (!this.path || !existsSync(this.path)) return;
    try {
      for (const b of JSON.parse(readFileSync(this.path, "utf8")) as BoardDevice[]) {
        if (typeof b?.id === "string" && typeof b.pushToken === "string" && typeof b.topic === "string") this.boards.set(b.id, { ...b, sent: b.sent ?? null });
      }
    } catch {
      /* corrupt file: start empty, phones register their boards again on their next connection */
    }
  }

  private save(): void {
    if (!this.path) return;
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(this.list(), null, 2) + "\n", { mode: 0o600 });
  }
}
