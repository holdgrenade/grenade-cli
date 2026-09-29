/**
 * Reads what `launchctl print gui/<uid>/<label>` says about the agent. Pure.
 * Only the job's own lines count (one tab deep); its sockets and endpoints have a `state` of their own further in.
 */
export interface ServiceState {
  /** launchd knows the job (its plist is loaded). */
  loaded: boolean;
  running: boolean;
  pid?: number;
  /** Exit code of the last run, when launchd reports one. */
  lastExit?: number;
}

export function parseLaunchctlPrint(output: string | null): ServiceState {
  if (output === null) return { loaded: false, running: false };
  const state = output.match(/^\tstate = (.+)$/m)?.[1]?.trim();
  const pid = output.match(/^\tpid = (\d+)$/m)?.[1];
  const lastExit = output.match(/^\tlast exit code = (-?\d+)/m)?.[1];
  const s: ServiceState = { loaded: true, running: state === "running" };
  if (pid) s.pid = Number(pid);
  if (lastExit !== undefined) s.lastExit = Number(lastExit);
  return s;
}
