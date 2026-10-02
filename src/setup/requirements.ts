/** What Grenade needs on the Mac before setup can go on: macOS, Node 22+, tmux 3.2+, and an agent to run. iTerm2 is not asked for: sessions open in Terminal.app without it. Pure. */
export const MIN_NODE_MAJOR = 22;
export const MIN_TMUX: readonly [number, number] = [3, 2];

export interface Found {
  platform: string;
  /** `process.versions.node`. */
  node: string;
  /** Output of `tmux -V` ("tmux 3.5a"), or null when tmux is not on PATH. */
  tmux: string | null;
  /** Homebrew is on PATH, so a missing tmux can be installed for the user. */
  brew: boolean;
  claude: boolean;
  codex: boolean;
  /** iTerm2 is installed, so sessions open in its tabs instead of Terminal windows. Only changes what setup says. */
  iterm: boolean;
}

export interface Problem {
  what: "platform" | "node" | "tmux" | "agent";
  message: string;
  /** Setup cannot go on. A warning (no agent yet) lets it. */
  blocks: boolean;
  /** A command that fixes it. Offered either way; only a blocking problem stops setup when it is declined or fails. */
  fix?: string;
}

export function tmuxVersion(output: string): [number, number] | null {
  const m = output.match(/(\d+)\.(\d+)/);
  return m ? [Number(m[1]), Number(m[2])] : null;
}

export function problems(f: Found): Problem[] {
  const list: Problem[] = [];
  if (f.platform !== "darwin") list.push({ what: "platform", message: "Grenade's daemon runs on macOS.", blocks: true });
  if (Number(f.node.split(".")[0]) < MIN_NODE_MAJOR) {
    list.push({ what: "node", message: `Node ${MIN_NODE_MAJOR} or newer is needed; this is ${f.node}.`, blocks: true, ...(f.brew ? { fix: "brew install node" } : {}) });
  }
  const tmux = f.tmux === null ? null : tmuxVersion(f.tmux);
  const tmuxOk = tmux !== null && (tmux[0] > MIN_TMUX[0] || (tmux[0] === MIN_TMUX[0] && tmux[1] >= MIN_TMUX[1]));
  if (!tmuxOk) {
    const found = f.tmux === null ? "it is not installed" : `this is ${f.tmux.trim()}`;
    const fix = f.brew ? { fix: f.tmux === null ? "brew install tmux" : "brew upgrade tmux" } : {};
    list.push({ what: "tmux", message: `tmux ${MIN_TMUX.join(".")} or newer is needed; ${found}.`, blocks: true, ...fix });
  }
  if (!f.claude && !f.codex) {
    list.push({ what: "agent", message: "Neither claude nor codex is on your PATH. Sessions can still run a shell.", blocks: false });
  }
  return list;
}
