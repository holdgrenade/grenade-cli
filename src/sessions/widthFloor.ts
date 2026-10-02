/**
 * Pure: the narrowest a session's window may get by following the Mac's terminals. tmux sizes a window to the terminal
 * attached last, and an iTerm tab split for a group of four can give each pane a dozen columns. The agent then wraps
 * everything it writes at that width, for good: a phone or a Mac pane that opens the session later scrolls back
 * through a column of words. So while no Grenade client sizes the window (`resize`, `term.open`) and every attached
 * terminal is narrower than the floor, the window is held at the floor (a narrow pane shows its left part); once a
 * terminal is that wide again, the window follows the terminals as before.
 */

/** Columns. Claude Code and Codex lay out well from here; a phone (about 46) is narrower but sizes the window itself. */
export const WIDTH_FLOOR = 60;

/** What tmux says about one session's window: its width and the widest Mac terminal attached (null for none). */
export interface WindowWidth {
  width: number;
  widest: number | null;
}

/** `floor`: resize the window to `WIDTH_FLOOR`. `follow`: let it fit the terminals again (`resize-window -A`). */
export type FloorAction = "floor" | "follow" | null;

/** A Grenade client gave the width back: follow the terminals, unless they are all narrower than the floor. */
export function onRelease(widest: number | null, floor = WIDTH_FLOOR): Exclude<FloorAction, null> {
  return widest !== null && widest < floor ? "floor" : "follow";
}

/** The 1 s sweep, for a window no Grenade client sizes. `floored`: it was held at the floor and has not followed since. */
export function onSweep(window: WindowWidth, floored: boolean, floor = WIDTH_FLOOR): FloorAction {
  const wideEnough = window.widest !== null && window.widest >= floor;
  if (floored) return wideEnough ? "follow" : null;
  // Narrow while a wide terminal is attached (tmux followed a narrow one that was used last): fit the widest.
  if (window.width < floor) return wideEnough ? "follow" : "floor";
  return null;
}

/** `list-windows -a -F "#{session_name} #{window_width}"` and `list-clients -F "#{session_name} #{client_control_mode}
 * #{client_width}"`: the window width and widest terminal per session. Control-mode clients are Grenade's own live
 * terminals, which size the window through `resize`, so they never count as Mac terminals. */
export function parseWindowWidths(windows: string, clients: string): Map<string, WindowWidth> {
  const out = new Map<string, WindowWidth>();
  for (const line of windows.split("\n")) {
    const [id, w] = line.trim().split(" ");
    const width = Number(w);
    if (id && Number.isInteger(width) && !out.has(id)) out.set(id, { width, widest: null });
  }
  for (const line of clients.split("\n")) {
    const [id, control, w] = line.trim().split(" ");
    const width = Number(w);
    const entry = id ? out.get(id) : undefined;
    if (!entry || control === "1" || !Number.isInteger(width) || width <= 0) continue;
    entry.widest = Math.max(entry.widest ?? 0, width);
  }
  return out;
}
