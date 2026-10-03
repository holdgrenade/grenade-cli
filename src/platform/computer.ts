import { DAEMON_OS_LINUX, DAEMON_OS_MAC } from "@grenade/protocol";

/** What the CLI calls the machine grenaded runs on: "Mac" on macOS, "computer" on Linux. Pure. */
export function computerWord(platform: string = process.platform): string {
  return platform === "darwin" ? "Mac" : "computer";
}

/** The system's name as setup prints it. */
export function systemName(platform: string = process.platform): string {
  return platform === "darwin" ? "macOS" : platform === "linux" ? "Linux" : platform;
}

/** What the daemon says it runs on in its `daemon` object (PROTOCOL.md `os`): the apps say "Mac" for `macos`, "computer" for anything else. Pure. */
export function daemonOs(platform: string = process.platform): string {
  return platform === "darwin" ? DAEMON_OS_MAC : platform === "linux" ? DAEMON_OS_LINUX : platform;
}
