/**
 * Pure: when a pane's history indexes are renumbered. See PROTOCOL.md "Scrollback".
 *
 * A row's history index (0 = oldest row tmux holds) is stable while output only grows the scrollback. It changes when
 * tmux rewraps history for a new width, trims or clears it (history_size shrinks), or the pane enters or leaves the
 * alternate screen. Each of those bumps the epoch so clients drop the rows they archived under the old numbering.
 */
export interface HistoryMark {
  epoch: number;
  cols: number;
  historySize: number;
  alternate: boolean;
}

export function nextHistoryMark(prev: HistoryMark | null, pane: { cols: number; historySize: number; alternate: boolean }): HistoryMark {
  const renumbered =
    prev !== null && (pane.cols !== prev.cols || pane.alternate !== prev.alternate || pane.historySize < prev.historySize);
  const epoch = prev === null ? 0 : renumbered ? prev.epoch + 1 : prev.epoch;
  return { epoch, cols: pane.cols, historySize: pane.historySize, alternate: pane.alternate };
}
