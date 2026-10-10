/** Pure: a highlight's id, `h-` and 12 hex characters of a hash of what it stands for, so the same picture gets the same id. */
import { createHash } from "node:crypto";

export function highlightIdOf(seed: string): string {
  return `h-${createHash("sha256").update(seed).digest("hex").slice(0, 12)}`;
}
