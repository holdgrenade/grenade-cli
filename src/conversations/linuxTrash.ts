/**
 * The Trash on Linux, as the freedesktop.org Trash specification lays it out: `<data home>/Trash/files/<name>` holds
 * what was deleted and `Trash/info/<name>.trashinfo` says where it came from and when, so the file manager (Nautilus
 * on Omarchy) shows it and can put it back. Only the home trash: a path on another disk is refused, never copied.
 * `trashInfo` and `trashName` are pure.
 */
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

/** `$XDG_DATA_HOME/Trash`, else `~/.local/share/Trash`. */
export function trashDir(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  const data = env["XDG_DATA_HOME"];
  return join(data && data.startsWith("/") ? data : join(home, ".local", "share"), "Trash");
}

/** The `.trashinfo` of one deleted path: the path URL-escaped with its slashes kept, the date in local time. */
export function trashInfo(path: string, at: Date): string {
  const escaped = path.split("/").map(encodeURIComponent).join("/");
  const two = (n: number) => String(n).padStart(2, "0");
  const date = `${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())}T${two(at.getHours())}:${two(at.getMinutes())}:${two(at.getSeconds())}`;
  return `[Trash Info]\nPath=${escaped}\nDeletionDate=${date}\n`;
}

/** The name a path gets in the Trash on its `n`th try: its own, then `name.2`, `name.3`… */
export function trashName(path: string, n: number): string {
  return n <= 1 ? basename(path) : `${basename(path)}.${n}`;
}

/** Moves `paths` to the home trash; throws when any could not be moved (the ones before it stay in the Trash). */
export function moveToLinuxTrash(paths: string[], dir: string = trashDir(), now: () => Date = () => new Date()): void {
  const files = join(dir, "files");
  const info = join(dir, "info");
  mkdirSync(files, { recursive: true, mode: 0o700 });
  mkdirSync(info, { recursive: true, mode: 0o700 });
  for (const given of paths) {
    const path = resolve(given);
    const name = reserve(info, path, now());
    try {
      renameSync(path, join(files, name));
    } catch (e) {
      rmSync(join(info, `${name}.trashinfo`), { force: true });
      if ((e as NodeJS.ErrnoException).code === "EXDEV") throw new Error(`${path} is on another disk than the Trash`);
      throw e;
    }
  }
}

/** Writes the info file first, as the specification asks: creating it is what claims the name. */
function reserve(info: string, path: string, at: Date): string {
  for (let n = 1; n <= 1000; n++) {
    const name = trashName(path, n);
    try {
      writeFileSync(join(info, `${name}.trashinfo`), trashInfo(path, at), { flag: "wx", mode: 0o600 });
      return name;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
  }
  throw new Error(`the Trash already holds too many files named ${basename(path)}`);
}
