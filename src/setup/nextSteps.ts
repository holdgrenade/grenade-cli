/** What `grenade setup` prints once the phone is paired: how to start an agent, where to watch it, and (on a Mac) how to open it in a terminal too. Pure. */
export function nextSteps(iterm: boolean, platform: string = "darwin"): string[] {
  const start = "Start an agent with: grenade new myproject --cwd ~/code/myproject";
  if (platform !== "darwin") return [start, "Watch it on your phone. Any terminal attaches with: grenade open myproject"];
  return [
    start,
    "Watch it in the Grenade Mac app or on your phone. Any terminal attaches with: grenade open myproject",
    iterm
      ? "Want every session in iTerm2 too, a folder's sessions side by side in one tab? Run: grenade terminal iterm"
      : "Want every session in a Terminal window too? Run: grenade terminal terminal",
  ];
}
