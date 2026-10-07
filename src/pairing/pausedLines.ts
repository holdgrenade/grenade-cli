/** Pure: what `grenade pair` prints while pairing is paused (PROTOCOL.md "Pausing after wrong codes"). */
export function pausedLines(pausedUntil: number, now: number, lastStrike: { at: number; route: "lan" | "relay" } | null): string[] {
  const lines = ["", `  Pairing is paused for ${remainingWords(pausedUntil - now)}.`];
  if (lastStrike) {
    const at = new Date(lastStrike.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    lines.push(`  5 wrong codes were typed at ${at}, ${lastStrike.route === "relay" ? "through the relay" : "on the Wi‑Fi"}.`);
  } else {
    lines.push("  Too many wrong codes were typed.");
  }
  lines.push("  Nothing can end a pause early. Run grenade pair again once it is over.", "");
  return lines;
}

/** "9 min 41 s", "1 h 5 min", "42 s". */
export function remainingWords(ms: number): string {
  const s = Math.max(Math.ceil(ms / 1000), 0);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return m > 0 ? `${h} h ${m} min` : `${h} h`;
  if (m > 0) return sec > 0 ? `${m} min ${sec} s` : `${m} min`;
  return `${sec} s`;
}
