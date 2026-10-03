/** What the CLI calls the machine grenaded runs on: "Mac" on macOS, "computer" on Linux. Pure. */
export function computerWord(platform: string = process.platform): string {
  return platform === "darwin" ? "Mac" : "computer";
}

/** The system's name as setup prints it. */
export function systemName(platform: string = process.platform): string {
  return platform === "darwin" ? "macOS" : platform === "linux" ? "Linux" : platform;
}
