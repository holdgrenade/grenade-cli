/**
 * What Claude Code's screen says about whether it is busy. Pure. Used only after a Stop, when an interrupt may leave
 * nothing in the transcript (a prompt stopped before the agent wrote anything is taken back without a line).
 *
 * While it works Claude Code shows a spinner line above its prompt box, "✻ Elucidating… (1m 28s · thought for 11s)",
 * and "esc to interrupt" in its footer (cut short on a narrow pane). Once a turn ends the spinner goes, or reads
 * "✻ Worked for 1m 3s" without the ellipsis and the bracket.
 */
const SPINNER = /^\s*[^\p{L}\p{N}\s]\s+\p{L}[\p{L}\p{N}' -]*…\s*\(/u;

export function claudeIsWorking(lines: readonly string[]): boolean {
  return lines.some((line) => SPINNER.test(line) || line.includes("esc to interrupt"));
}
