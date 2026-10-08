/**
 * The owner's name (PROTOCOL.md "Comments"): who the share pages say published them, and who the owner's replies are
 * from. Kept in owner.json for every client of this computer, so a phone replies under the name the Mac set. With no
 * file, the name of this computer's account (`id -F` on a Mac); `""` is no name ("Owner" on a reply).
 */
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { SHARE_COMMENT_NAME_MAX } from "@grenade/protocol";

/** The account's full name on a Mac, or "" anywhere else or when it cannot be read. */
export function accountName(): string {
  if (process.platform !== "darwin") return "";
  try {
    return execFileSync("/usr/bin/id", ["-F"], { encoding: "utf8", timeout: 2000 }).trim().slice(0, SHARE_COMMENT_NAME_MAX);
  } catch {
    return "";
  }
}

export class OwnerName extends EventEmitter {
  private current: string;

  constructor(
    private readonly path: string,
    fallback: () => string = accountName,
  ) {
    super();
    this.current = OwnerName.load(path) ?? fallback();
  }

  private static load(path: string): string | undefined {
    if (!existsSync(path)) return undefined;
    try {
      const j = JSON.parse(readFileSync(path, "utf8")) as { name?: unknown };
      return typeof j.name === "string" ? j.name.slice(0, SHARE_COMMENT_NAME_MAX) : undefined;
    } catch {
      return undefined;
    }
  }

  get name(): string {
    return this.current;
  }

  /** Sets the name ("" for none), saves it, and tells listeners when it changed. */
  set(name: string): string {
    const next = name.trim().slice(0, SHARE_COMMENT_NAME_MAX);
    mkdirSync(dirname(this.path), { recursive: true });
    const temp = `${this.path}.tmp`;
    writeFileSync(temp, JSON.stringify({ name: next }) + "\n", { mode: 0o600 });
    chmodSync(temp, 0o600);
    renameSync(temp, this.path);
    if (next !== this.current) {
      this.current = next;
      this.emit("changed", next);
    }
    return next;
  }
}
