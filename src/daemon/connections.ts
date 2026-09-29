/**
 * The connections that have said `hello`, by token: what `grenade devices` shows as connected, and what an unpair
 * closes. Holds no sockets, only the `Connection`s the server built.
 */
import type { Route } from "./devices.js";

/** The slice of `Connection` this needs. */
export interface LiveConnection {
  readonly route: Route;
  revoked(message: string): void;
}

export class LiveConnections {
  private readonly byToken = new Map<string, Set<LiveConnection>>();

  add(token: string, connection: LiveConnection): void {
    const set = this.byToken.get(token) ?? new Set();
    set.add(connection);
    this.byToken.set(token, set);
  }

  remove(token: string, connection: LiveConnection): void {
    const set = this.byToken.get(token);
    if (!set) return;
    set.delete(connection);
    if (set.size === 0) this.byToken.delete(token);
  }

  routesOf(token: string): Route[] {
    return [...(this.byToken.get(token) ?? [])].map((c) => c.route);
  }

  /** Tells every connection of that token that its pairing ended. Returns how many there were. */
  revoke(token: string, message: string): number {
    const set = [...(this.byToken.get(token) ?? [])];
    this.byToken.delete(token);
    for (const c of set) c.revoked(message);
    return set.length;
  }
}
