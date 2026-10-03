/**
 * Reads what `systemctl --user show <unit> --property=LoadState,ActiveState,MainPID,ExecMainCode,ExecMainStatus`
 * says about the service: one `Key=value` per line. Pure. Null (systemctl failed, no user session) is a service
 * systemd does not know.
 */
import type { ServiceState } from "./serviceTypes.js";

export const SHOWN_PROPERTIES = ["LoadState", "ActiveState", "MainPID", "ExecMainCode", "ExecMainStatus"];

export function parseSystemctlShow(output: string | null): ServiceState {
  if (output === null) return { loaded: false, running: false };
  const value = (key: string) => output.match(new RegExp(`^${key}=(.*)$`, "m"))?.[1]?.trim();
  const pid = Number(value("MainPID") ?? 0);
  const running = value("ActiveState") === "active" && pid > 0;
  const s: ServiceState = { loaded: value("LoadState") === "loaded", running };
  if (running) s.pid = pid;
  // ExecMainCode is 0 until the main process has ended once (1: it exited, 2: a signal killed it).
  const ended = value("ExecMainCode");
  const status = value("ExecMainStatus");
  if (!running && ended !== undefined && ended !== "0" && status !== undefined && /^-?\d+$/.test(status)) s.lastExit = Number(status);
  return s;
}
