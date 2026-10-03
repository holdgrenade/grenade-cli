/**
 * The shell a `shell` session runs: `$SHELL`, else the user's login shell from the password database, else the
 * system's usual one. `$SHELL` is not always set (a service, a container, a daemon started by another program),
 * and zsh, the Mac's shell, is not installed on most Linux systems: a session started with a shell that is not
 * there ends at once, and takes a tmux server with no other session with it.
 */
import { userInfo } from "node:os";

export function loginShell(env: NodeJS.ProcessEnv = process.env, fromUser: () => string | null = userShell, platform: string = process.platform): string {
  return env["SHELL"] || fromUser() || (platform === "darwin" ? "/bin/zsh" : "/bin/sh");
}

function userShell(): string | null {
  try {
    return userInfo().shell;
  } catch {
    // No entry for this uid (a container running as an arbitrary user).
    return null;
  }
}
