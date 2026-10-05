/** published.json: the links this daemon published, each with its key, readable by this user only (PROTOCOL.md "Publishing"). */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { PublishExpiry, PublishScope, ShareKey, ShareToken } from "@grenade/protocol";
import type { PublishRecord } from "./publishPlan.js";

function isRecord(r: unknown): r is PublishRecord {
  if (typeof r !== "object" || r === null) return false;
  const o = r as Record<string, unknown>;
  return (
    ShareToken.safeParse(o.token).success &&
    ShareKey.safeParse(o.key).success &&
    o.kind === "canvas" &&
    typeof o.cwd === "string" &&
    typeof o.folder === "string" &&
    typeof o.title === "string" &&
    PublishScope.safeParse(o.scope).success &&
    PublishExpiry.safeParse(o.expiry).success &&
    typeof o.created === "string" &&
    typeof o.updated === "string"
  );
}

export function loadPublished(path: string): PublishRecord[] {
  if (!existsSync(path)) return [];
  try {
    const j: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!Array.isArray(j)) return [];
    return j.filter(isRecord).map((r) => ({ ...r, boards: typeof r.boards === "number" ? r.boards : 0, state: r.state ?? "uploading" }));
  } catch {
    return [];
  }
}

export function savePublished(path: string, records: PublishRecord[]): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.tmp`;
  writeFileSync(temp, JSON.stringify(records, null, 2) + "\n", { mode: 0o600 });
  chmodSync(temp, 0o600);
  renameSync(temp, path);
}
