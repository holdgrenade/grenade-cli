/**
 * `<GRENADE_HOME>/showreel.json` (mode 0600): at which hour of the day the showreel is cut and announced
 * (`grenade showreel hour <h>`). Anything malformed reads as the default.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

/** When the day's reel is cut unless the owner chose another hour: six in the evening, the computer's clock. */
export const DEFAULT_SHOWREEL_HOUR = 18;

export interface ShowreelSettings {
  hour: number;
}

export function loadShowreelSettings(path: string): ShowreelSettings {
  if (!existsSync(path)) return { hour: DEFAULT_SHOWREEL_HOUR };
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const hour = raw["hour"];
    return { hour: typeof hour === "number" && Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : DEFAULT_SHOWREEL_HOUR };
  } catch {
    return { hour: DEFAULT_SHOWREEL_HOUR };
  }
}

export function saveShowreelSettings(path: string, settings: ShowreelSettings): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}
