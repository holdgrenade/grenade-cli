/**
 * What a published canvas holds (PROTOCOL.md "Publishing"): the boards of its scope, the other files of the folder
 * they name, a link's address, title and expiry, and the link as a client sees it. Pure: `publisher.ts` reads the
 * folder and talks to the host.
 */
import { basename } from "node:path";
import { expiresAt, shareUrlFor, type CanvasBoard, type PublishedLink, type PublishExpiry, type PublishScope, type PublishState } from "@grenade/protocol";

/** One link as the daemon keeps it in published.json: the protocol's link, its key, and what the host has. */
export interface PublishRecord {
  token: string;
  key: string;
  kind: "canvas";
  cwd: string;
  folder: string;
  title: string;
  scope: PublishScope;
  expiry: PublishExpiry;
  expires?: string;
  created: string;
  updated: string;
  boards: number;
  state: PublishState;
  error?: string;
  /** The SHA-256 of the last manifest the host took, so an unchanged canvas sends nothing. */
  manifestSha?: string;
}

/** The boards a scope shows: every board, or those of the highest revision (all of them when none has one). */
export function boardsInScope(boards: CanvasBoard[], scope: PublishScope): CanvasBoard[] {
  if (scope === "all") return boards;
  const revisions = boards.map((b) => b.revision).filter((r): r is number => r !== undefined);
  if (revisions.length === 0) return boards;
  const newest = Math.max(...revisions);
  return boards.filter((b) => b.revision === newest);
}

/** A name in the folder that may go up beside the boards: not hidden, not a page. */
export function isAssetName(name: string): boolean {
  return name.length > 0 && name.length <= 255 && !name.startsWith(".") && !/[/\\\0]/.test(name) && !/\.(html?|xhtml|svgz)$/i.test(name);
}

/** The files among `names` that a board's HTML names by a relative address: as written, or percent-encoded. */
export function referencedAssets(htmls: string[], names: string[]): string[] {
  return names.filter((name) => {
    if (!isAssetName(name)) return false;
    const forms = new Set([name, encodeURI(name), encodeURIComponent(name)]);
    return htmls.some((html) => [...forms].some((form) => html.includes(form)));
  });
}

/** A page's title: the name of the folder whose canvas it is. */
export function titleOf(cwd: string): string {
  return basename(cwd.replace(/\/+$/, "")) || cwd;
}

/** The token and key of a new link, from random bytes (12 and 32), as base64url without padding. */
export function newSecrets(random: (n: number) => Buffer): { token: string; key: string } {
  return { token: random(12).toString("base64url"), key: random(32).toString("base64url") };
}

/** When a record runs out, chosen at `from`. */
export function withExpiry(record: PublishRecord, expiry: PublishExpiry, from: Date): PublishRecord {
  const expires = expiresAt(from, expiry);
  const { expires: _old, ...rest } = record;
  return { ...rest, expiry, ...(expires ? { expires } : {}) };
}

/** Whether a record has run out at `now`. */
export function isExpired(record: PublishRecord, now: Date): boolean {
  return record.expires !== undefined && Date.parse(record.expires) <= now.getTime();
}

/** The link as a client sees it: no key, no manifest hash. */
export function linkOf(record: PublishRecord, host: string): PublishedLink {
  return {
    token: record.token,
    kind: record.kind,
    cwd: record.cwd,
    folder: record.folder,
    title: record.title,
    url: shareUrlFor(host, record.token),
    scope: record.scope,
    expiry: record.expiry,
    ...(record.expires ? { expires: record.expires } : {}),
    boards: record.boards,
    created: record.created,
    updated: record.updated,
    state: record.state,
    ...(record.error ? { error: record.error.slice(0, 500) } : {}),
  };
}

/** Every link, newest first. */
export function linksOf(records: PublishRecord[], host: string): PublishedLink[] {
  return [...records].sort((a, b) => b.created.localeCompare(a.created)).map((r) => linkOf(r, host));
}

/** A token as a log may show it: the first 4 characters. The token is the address, so it is never logged whole. */
export function tokenForLog(token: string): string {
  return `${token.slice(0, 4)}…`;
}
