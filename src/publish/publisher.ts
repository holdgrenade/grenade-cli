/**
 * Publishes canvases to secret links and keeps each page up to date (PROTOCOL.md "Publishing"). Each link watches its
 * canvas folder (the canvas's own `CanvasWatcher`, every 400 ms) and, once a change has held for 1.5 s, sends the host
 * a new manifest and the files it lacks. A link that failed tries again a minute later; one that ran out stops.
 * Links outlive the daemon: published.json holds them, and `start` picks every one up again.
 */
import { createHash, randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { basename, dirname, join } from "node:path";
import { PUBLISHED_LINKS_MAX, SHARE_PLAN_FILE, type CanvasBoard, type PublishedLink, type PublishExpiry, type PublishScope, type ShareManifest } from "@grenade/protocol";
import type { CanvasListing } from "../canvas/canvasFolder.js";
import type { CanvasPick } from "../canvas/canvasService.js";
import type { Logger } from "../log.js";
import { boardsInScope, isExpired, linksOf, newSecrets, planTitleOf, referencedAssets, titleOf, tokenForLog, withExpiry, type PublishRecord } from "./publishPlan.js";
import type { AssetFile } from "./publishFolder.js";
import { loadPublished, savePublished } from "./publishStore.js";
import type { ShareClient } from "./shareClient.js";

/** Why a link could not be made, changed or taken down; `message` is a sentence for the user. */
export class PublishError extends Error {}

/** How long a canvas must stay put before it goes up, so a board being written goes up once. */
export const PUBLISH_SETTLE_MS = 1500;
/** How long a failed link waits before it tries again. */
export const PUBLISH_RETRY_MS = 60_000;

export interface PublisherDeps {
  /** published.json. */
  path: string;
  client: ShareClient;
  /** The canvas folder a pick names; throws (a `CanvasError`) for one that is not served. */
  folderOf(pick: CanvasPick): string;
  /** What a group's canvas is called now (`canvasNameOf`), for a link's title. */
  nameOf(folder: string, canvas: string): Promise<string>;
  listCanvas(folder: string): Promise<CanvasListing>;
  watchCanvas(folder: string, current: CanvasListing, onChange: () => void): () => void;
  readBoard(folder: string, file: string): Promise<{ html: string }>;
  assetFiles(folder: string): Promise<AssetFile[]>;
  readAsset(folder: string, name: string): Promise<Buffer | null>;
  /** A session's plan file and its folder (PROTOCOL.md "Plans"), or undefined when it has none or its agent has no plans. */
  planOf?(sessionId: string): { path: string; cwd: string } | undefined;
  /** A plan file's text, or null when it is not a regular file. */
  readPlan?(path: string): Promise<Buffer | null>;
  /** Tells `onChange` whenever the file at `path` is saved. Returns how to stop. */
  watchPlan?(path: string, onChange: () => void): () => void;
  log: Logger;
  now?: () => Date;
  random?: (n: number) => Buffer;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
}

interface Live {
  stopWatch?: () => void;
  timer?: unknown;
  /** The upload under way, if any. */
  running?: Promise<void>;
  again: boolean;
  /** Each file read, with its SHA-256, by its name, save time and size, so an unchanged file is not read again. */
  cache: Map<string, { bytes: Buffer; sha256: string }>;
  /** The bytes of every file of the last manifest, by name: what goes up when the host asks for one. */
  files: Map<string, Buffer>;
}

const sha256 = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");
const boardKey = (b: CanvasBoard) => `${b.file}\n${b.modified}\n${b.bytes}`;

export class Publisher extends EventEmitter {
  private records: PublishRecord[];
  private readonly live = new Map<string, Live>();
  private readonly now: () => Date;
  private readonly random: (n: number) => Buffer;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (t: unknown) => void;
  private stopped = false;

  constructor(private readonly d: PublisherDeps) {
    super();
    this.records = loadPublished(d.path);
    this.now = d.now ?? (() => new Date());
    this.random = d.random ?? randomBytes;
    this.setTimer = d.setTimer ?? ((fn, ms) => {
      const t = setTimeout(fn, ms);
      t.unref?.();
      return t;
    });
    this.clearTimer = d.clearTimer ?? ((t) => clearTimeout(t as NodeJS.Timeout));
  }

  get host(): string {
    return this.d.client.host;
  }

  /** Every link, newest first, as a client sees them. */
  list(): PublishedLink[] {
    return linksOf(this.records, this.host);
  }

  /** Starts keeping every stored link up to date. */
  async start(): Promise<void> {
    for (const r of this.records) await this.follow(r.token);
  }

  /**
   * Publishes a canvas, or changes its link's scope or expiry; `newLink` gives it a new address; `token` points that
   * link at this canvas instead of its own (a canvas moved to another group keeps its address).
   */
  async publishCanvas(pick: CanvasPick, scope: PublishScope, expiry?: PublishExpiry, newLink?: boolean, moveToken?: string): Promise<PublishedLink[]> {
    let folder: string;
    try {
      folder = this.d.folderOf(pick);
    } catch (e) {
      throw new PublishError(e instanceof Error ? e.message : String(e));
    }
    const { cwd } = pick;
    const which = pick.group !== undefined && pick.canvas !== undefined ? { group: pick.group, canvas: pick.canvas } : {};
    const title = pick.canvas !== undefined ? await this.d.nameOf(folder, pick.canvas) : titleOf(cwd);
    const now = this.now();
    if (moveToken !== undefined) return this.repoint(moveToken, { cwd, folder, title, ...which }, scope, expiry, newLink === true, now);
    const existing = this.records.find((r) => r.folder === folder);
    if (existing && !newLink) {
      let next: PublishRecord = { ...existing, scope };
      if (expiry !== undefined && (expiry !== existing.expiry || isExpired(existing, now))) next = withExpiry(next, expiry, now);
      if (next.state === "expired" && !isExpired(next, now)) next = { ...next, state: "uploading" };
      this.replace(next);
      this.save();
      await this.follow(next.token);
      this.schedule(next.token, 0);
      this.changed();
      return this.list();
    }
    if (!existing && this.records.length >= PUBLISHED_LINKS_MAX) throw new PublishError(`A computer keeps at most ${PUBLISHED_LINKS_MAX} links. Unpublish one first.`);
    if (existing) await this.takeDown(existing);
    const { token, key } = newSecrets(this.random);
    const at = now.toISOString();
    const record = withExpiry(
      { token, key, kind: "canvas", cwd, folder, ...which, title, scope, expiry: "never", created: at, updated: at, boards: 0, state: "uploading" },
      expiry ?? existing?.expiry ?? "never",
      now,
    );
    this.records.push(record);
    this.save();
    this.d.log.info("Published a canvas", { folder, link: tokenForLog(token), scope });
    await this.follow(token);
    this.schedule(token, 0);
    this.changed();
    return this.list();
  }

  /**
   * Publishes a session's plan, always its newest version (PROTOCOL.md "Plans"), or changes its link's expiry;
   * `newLink` gives it a new address.
   */
  async publishPlan(sessionId: string, expiry?: PublishExpiry, newLink?: boolean): Promise<PublishedLink[]> {
    const plan = this.d.planOf?.(sessionId);
    if (!plan) throw new PublishError("This session has no plan to publish yet.");
    const now = this.now();
    const existing = this.records.find((r) => r.kind === "plan" && r.sessionId === sessionId);
    if (existing && !newLink) {
      let next: PublishRecord = { ...existing, folder: dirname(plan.path), file: basename(plan.path) };
      if (expiry !== undefined && (expiry !== existing.expiry || isExpired(existing, now))) next = withExpiry(next, expiry, now);
      if (next.state === "expired" && !isExpired(next, now)) next = { ...next, state: "uploading" };
      const moved = next.file !== existing.file || next.folder !== existing.folder;
      this.replace(next);
      this.save();
      if (moved) this.unfollow(next.token);
      await this.follow(next.token);
      this.schedule(next.token, 0);
      this.changed();
      return this.list();
    }
    if (!existing && this.records.length >= PUBLISHED_LINKS_MAX) throw new PublishError(`A computer keeps at most ${PUBLISHED_LINKS_MAX} links. Unpublish one first.`);
    if (existing) await this.takeDown(existing);
    const { token, key } = newSecrets(this.random);
    const at = now.toISOString();
    const text = (await this.d.readPlan?.(plan.path))?.toString("utf8") ?? "";
    const record = withExpiry(
      { token, key, kind: "plan", cwd: plan.cwd, folder: dirname(plan.path), sessionId, file: basename(plan.path),
        title: planTitleOf(text, basename(plan.path)), scope: "newest", expiry: "never", created: at, updated: at, boards: 0, state: "uploading" },
      expiry ?? existing?.expiry ?? "never",
      now,
    );
    this.records.push(record);
    this.save();
    this.d.log.info("Published a plan", { session: sessionId, link: tokenForLog(token) });
    await this.follow(token);
    this.schedule(token, 0);
    this.changed();
    return this.list();
  }

  /** Points the link `token` at another canvas (one that moved), keeping its address; uploads from there at once. */
  private async repoint(
    token: string,
    to: { cwd: string; folder: string; title: string; group?: string; canvas?: string },
    scope: PublishScope,
    expiry: PublishExpiry | undefined,
    newLink: boolean,
    now: Date,
  ): Promise<PublishedLink[]> {
    if (newLink) throw new PublishError("A link is either moved or made new, not both.");
    const record = this.records.find((r) => r.token === token);
    if (!record) throw new PublishError("That link is not one of this computer's.");
    if (this.records.some((r) => r.token !== token && r.folder === to.folder)) throw new PublishError("That canvas has a link of its own already.");
    const { group: _g, canvas: _c, ...rest } = record;
    let next: PublishRecord = { ...rest, ...to, scope };
    if (expiry !== undefined && (expiry !== record.expiry || isExpired(record, now))) next = withExpiry(next, expiry, now);
    if (next.state === "expired" && !isExpired(next, now)) next = { ...next, state: "uploading" };
    this.unfollow(token);
    this.replace(next);
    this.save();
    this.d.log.info("Moved a published canvas", { folder: to.folder, link: tokenForLog(token) });
    await this.follow(token);
    this.schedule(token, 0);
    this.changed();
    return this.list();
  }

  /** Takes a link down at the host, then forgets it. */
  async remove(token: string): Promise<PublishedLink[]> {
    const record = this.records.find((r) => r.token === token);
    if (!record) throw new PublishError("That link is not one of this computer's.");
    await this.takeDown(record);
    this.d.log.info("Unpublished a canvas", { folder: record.folder, link: tokenForLog(token) });
    this.changed();
    return this.list();
  }

  /** Stops watching (the daemon is stopping); the links stay up. */
  stop(): void {
    this.stopped = true;
    for (const token of [...this.live.keys()]) this.unfollow(token);
  }

  private async takeDown(record: PublishRecord): Promise<void> {
    try {
      await this.d.client.remove(record.token, record.key);
    } catch (e) {
      throw new PublishError(`Could not take the link down, so it still works: ${e instanceof Error ? e.message : String(e)}`);
    }
    this.unfollow(record.token);
    this.records = this.records.filter((r) => r.token !== record.token);
    this.save();
  }

  private replace(record: PublishRecord): void {
    this.records = this.records.map((r) => (r.token === record.token ? record : r));
  }

  private save(): void {
    try {
      savePublished(this.d.path, this.records);
    } catch (e) {
      this.d.log.error("Could not save the published links", { error: e instanceof Error ? e.message : String(e) });
    }
  }

  private changed(): void {
    this.emit("changed", this.list());
  }

  /** Watches a link's folder, once. */
  private async follow(token: string): Promise<void> {
    if (this.stopped || this.live.has(token)) return;
    const record = this.records.find((r) => r.token === token);
    if (!record) return;
    const live: Live = { again: false, cache: new Map(), files: new Map() };
    this.live.set(token, live);
    if (isExpired(record, this.now())) return;
    if (record.kind === "plan") {
      const stop = this.d.watchPlan?.(planPathOf(record), () => this.schedule(token, PUBLISH_SETTLE_MS));
      if (stop) live.stopWatch = stop;
      this.schedule(token, 0);
      return;
    }
    try {
      const listing = await this.d.listCanvas(record.folder);
      if (this.live.get(token) !== live) return;
      live.stopWatch = this.d.watchCanvas(record.folder, listing, () => this.schedule(token, PUBLISH_SETTLE_MS));
    } catch (e) {
      this.d.log.debug("Could not watch a published canvas", { folder: record.folder, error: e instanceof Error ? e.message : String(e) });
    }
    this.schedule(token, 0);
  }

  private unfollow(token: string): void {
    const live = this.live.get(token);
    if (!live) return;
    live.stopWatch?.();
    if (live.timer !== undefined) this.clearTimer(live.timer);
    this.live.delete(token);
  }

  private schedule(token: string, ms: number): void {
    const live = this.live.get(token);
    if (!live || this.stopped) return;
    if (live.timer !== undefined) this.clearTimer(live.timer);
    live.timer = this.setTimer(() => {
      live.timer = undefined;
      void this.sync(token);
    }, ms);
  }

  /** Brings one link's page up to date with its folder; one upload at a time per link, and once more if asked meanwhile. */
  sync(token: string): Promise<void> {
    const live = this.live.get(token);
    if (!live) return Promise.resolve();
    if (live.running) {
      live.again = true;
      return live.running;
    }
    live.running = (async () => {
      try {
        await this.upload(token, live);
      } finally {
        delete live.running;
        if (live.again && this.live.get(token) === live) {
          live.again = false;
          this.schedule(token, 0);
        }
      }
    })();
    return live.running;
  }

  /** Resolves once no upload is under way (tests). */
  async idle(): Promise<void> {
    for (;;) {
      const running = [...this.live.values()].map((l) => l.running).filter((r): r is Promise<void> => r !== undefined);
      if (running.length === 0) return;
      await Promise.all(running);
    }
  }

  private update(token: string, change: Partial<PublishRecord>, drop: (keyof PublishRecord)[] = []): PublishRecord | undefined {
    const record = this.records.find((r) => r.token === token);
    if (!record) return undefined;
    const next = { ...record, ...change };
    for (const k of drop) delete next[k];
    const moved = JSON.stringify(next) !== JSON.stringify(record);
    this.replace(next);
    if (moved) {
      this.save();
      this.changed();
    }
    return next;
  }

  private async upload(token: string, live: Live): Promise<void> {
    const record = this.records.find((r) => r.token === token);
    if (!record) return;
    const now = this.now();
    if (isExpired(record, now)) {
      live.stopWatch?.();
      delete live.stopWatch;
      this.update(token, { state: "expired" }, ["error"]);
      return;
    }
    try {
      const manifest = await this.manifestOf(record, live);
      const manifestSha = sha256(JSON.stringify(manifest));
      if (manifestSha === record.manifestSha && record.state === "live") return;
      if (record.state !== "uploading") this.update(token, { state: "uploading" }, ["error"]);
      const missing = await this.d.client.putManifest(record.token, record.key, manifest);
      for (const file of missing) {
        const bytes = live.files.get(file);
        if (!bytes) throw new PublishError(`"${file}" changed while it went up.`);
        await this.d.client.putFile(record.token, record.key, file, bytes);
      }
      if (!this.live.has(token)) return;
      this.update(token, {
        state: "live",
        boards: manifest.boards.length,
        manifestSha,
        ...(manifestSha !== record.manifestSha ? { updated: this.now().toISOString() } : {}),
      }, ["error"]);
    } catch (e) {
      if (!this.live.has(token)) return;
      const message = e instanceof Error ? e.message : String(e);
      this.d.log.info("Could not update a published canvas", { folder: record.folder, link: tokenForLog(token), error: message });
      this.update(token, { state: "failed", error: `${message} Trying again in a minute.` });
      this.schedule(token, PUBLISH_RETRY_MS);
    }
  }

  /** What a plan's page shows now: its file's text, as `plan.md`, under its first heading. */
  private async planManifestOf(record: PublishRecord, live: Live): Promise<ShareManifest> {
    const bytes = await this.d.readPlan?.(planPathOf(record));
    if (!bytes) throw new PublishError("The plan file is not there any more.");
    const title = planTitleOf(bytes.toString("utf8"), record.file ?? SHARE_PLAN_FILE);
    if (title !== record.title) this.update(record.token, { title });
    live.files = new Map([[SHARE_PLAN_FILE, bytes]]);
    return {
      kind: "plan",
      title,
      scope: "newest",
      ...(record.expires ? { expires: record.expires } : {}),
      boards: [],
      assets: [{ file: SHARE_PLAN_FILE, bytes: bytes.length, sha256: sha256(bytes) }],
    };
  }

  /** What the page should show now: the boards of the scope, read, and the files they name. */
  private async manifestOf(record: PublishRecord, live: Live): Promise<ShareManifest> {
    if (record.kind === "plan") return this.planManifestOf(record, live);
    const cache = new Map<string, { bytes: Buffer; sha256: string }>();
    const files = new Map<string, Buffer>();
    const readOnce = async (key: string, read: () => Promise<Buffer | null>) => {
      let entry = live.cache.get(key) ?? cache.get(key);
      if (!entry) {
        const bytes = await read();
        if (!bytes) return null;
        entry = { bytes, sha256: sha256(bytes) };
      }
      cache.set(key, entry);
      return entry;
    };

    const listing = await this.d.listCanvas(record.folder);
    const boards: ShareManifest["boards"] = [];
    const htmls: string[] = [];
    for (const b of boardsInScope(listing.boards, record.scope)) {
      const entry = await readOnce(`b\n${boardKey(b)}`, async () => Buffer.from((await this.d.readBoard(record.folder, b.file)).html, "utf8"));
      if (!entry) continue;
      files.set(b.file, entry.bytes);
      htmls.push(entry.bytes.toString("utf8"));
      boards.push({
        file: b.file,
        name: b.name,
        ...(b.revision !== undefined ? { revision: b.revision } : {}),
        ...(b.letter !== undefined ? { letter: b.letter } : {}),
        width: b.width,
        height: b.height,
        bytes: entry.bytes.length,
        sha256: entry.sha256,
      });
    }

    const found = await this.d.assetFiles(record.folder);
    const named = new Set(referencedAssets(htmls, found.map((f) => f.name)));
    const assets: ShareManifest["assets"] = [];
    for (const f of found) {
      if (!named.has(f.name)) continue;
      const entry = await readOnce(`a\n${f.name}\n${f.mtimeMs}\n${f.bytes}`, () => this.d.readAsset(record.folder, f.name));
      if (!entry) continue;
      files.set(f.name, entry.bytes);
      assets.push({ file: f.name, bytes: entry.bytes.length, sha256: entry.sha256 });
    }

    // Only what this manifest uses stays cached.
    live.cache = cache;
    live.files = files;
    return { title: record.title, scope: record.scope, ...(record.expires ? { expires: record.expires } : {}), boards, assets };
  }
}

/** Where a plan link's file lies. */
function planPathOf(record: PublishRecord): string {
  return join(record.folder, record.file ?? SHARE_PLAN_FILE);
}
