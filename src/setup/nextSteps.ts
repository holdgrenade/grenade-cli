/** What `grenade setup` prints once the phone is paired: how to start an agent, and where it shows up on the Mac. Pure. */
export function nextSteps(iterm: boolean): string[] {
  const lines = ["Start an agent with: grenade new myproject --cwd ~/code/myproject"];
  if (iterm) {
    lines.push(
      "It opens in a tab of its own in iTerm2. Sessions started in the same folder share that tab, side by side.",
      "The first time, macOS may ask whether grenaded (it says node) may control iTerm2: allow it, or no tab appears.",
    );
  } else {
    lines.push(
      "It opens in a Terminal window of its own. With iTerm2 (brew install --cask iterm2) the sessions of a folder",
      "sit side by side in one tab instead; no restart needed. Any terminal attaches with: grenade open myproject",
      "The first time, macOS may ask whether grenaded (it says node) may control Terminal: allow it, or no window appears.",
    );
  }
  return lines;
}
