/** Quotes a string as one word for /bin/sh, which tmux runs the agent's command line in. Pure. */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
