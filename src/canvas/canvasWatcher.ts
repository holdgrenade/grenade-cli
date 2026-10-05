/**
 * Watches canvas folders for clients that sent `canvas.subscribe` (PROTOCOL.md "Canvas", "Watching"): it looks at each
 * folder every 400 ms, as the Mac app does, and hands a subscriber the listing whenever it differs from the one that
 * subscriber last got. A poll, not `fs.watch`: the folder may not exist yet, may be replaced by a save that renames,
 * and FSEvents and inotify report those differently; a look is one `readdir` and a `lstat` per board. One poll per
 * folder however many subscribe, none once nobody does.
 */
import { listingKey } from "./boardListing.js";
import { listCanvas, type CanvasListing, type HeadCache } from "./canvasFolder.js";

export const CANVAS_POLL_MS = 400;

/** Runs `fn` every `ms` until the returned function is called. Tests pass one they tick by hand. */
export type Every = (fn: () => void, ms: number) => () => void;

const realEvery: Every = (fn, ms) => {
  const timer = setInterval(fn, ms);
  timer.unref?.();
  return () => clearInterval(timer);
};

interface Subscriber {
  lastKey: string;
  onChange(listing: CanvasListing): void;
}

interface Watched {
  subscribers: Set<Subscriber>;
  heads: HeadCache;
  stop: () => void;
  busy: boolean;
}

export class CanvasWatcher {
  private readonly folders = new Map<string, Watched>();

  constructor(
    private readonly every: Every = realEvery,
    private readonly list: (folder: string, heads: HeadCache) => Promise<CanvasListing> = listCanvas,
    private readonly onError: (folder: string, error: unknown) => void = () => {},
  ) {}

  /** Starts telling `onChange` of every change to `folder` after `current`, the listing the subscriber has. Returns how to stop. */
  watch(folder: string, current: CanvasListing, onChange: (listing: CanvasListing) => void): () => void {
    let watched = this.folders.get(folder);
    if (!watched) {
      const created: Watched = { subscribers: new Set(), heads: new Map(), busy: false, stop: () => {} };
      created.stop = this.every(() => void this.look(folder, created), CANVAS_POLL_MS);
      this.folders.set(folder, created);
      watched = created;
    }
    const subscriber: Subscriber = { lastKey: listingKey(current), onChange };
    watched.subscribers.add(subscriber);
    const w = watched;
    return () => {
      w.subscribers.delete(subscriber);
      if (w.subscribers.size === 0 && this.folders.get(folder) === w) {
        w.stop();
        this.folders.delete(folder);
      }
    };
  }

  /** How many folders are being polled. */
  get size(): number {
    return this.folders.size;
  }

  /** Looks at one folder now; a look still running makes this one a no-op. */
  async look(folder: string, watched = this.folders.get(folder)): Promise<void> {
    if (!watched || watched.busy) return;
    watched.busy = true;
    try {
      const listing = await this.list(folder, watched.heads);
      const key = listingKey(listing);
      for (const s of watched.subscribers) {
        if (s.lastKey === key) continue;
        s.lastKey = key;
        s.onChange(listing);
      }
    } catch (e) {
      this.onError(folder, e);
    } finally {
      watched.busy = false;
    }
  }

  /** Stops every poll (the daemon is stopping). */
  stopAll(): void {
    for (const w of this.folders.values()) w.stop();
    this.folders.clear();
  }
}
