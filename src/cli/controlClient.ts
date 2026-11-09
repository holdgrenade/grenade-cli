/** Calls the daemon's loopback control API (src/daemon/control.ts) for the CLI. */
export class DaemonNotRunningError extends Error {
  constructor(env: NodeJS.ProcessEnv = process.env) {
    super(unreachableMessage(env));
  }
}

/**
 * Why the daemon did not answer. Inside Codex's sandbox (`CODEX_SANDBOX_NETWORK_DISABLED`) no address answers, the
 * loopback one included, so the agent is told how to get through rather than that grenaded is not running.
 */
export function unreachableMessage(env: NodeJS.ProcessEnv): string {
  if (env["CODEX_SANDBOX_NETWORK_DISABLED"] === "1") {
    return "Codex's sandbox keeps this command from reaching Grenade on this computer. Run it again with escalated permissions (outside the sandbox).";
  }
  return "grenaded is not running. Start it with: grenade service install (or in the foreground: grenade daemon)";
}

export type Control = <T = unknown>(method: string, path: string, body?: unknown) => Promise<T>;

export function controlClient(port: () => number): Control {
  return async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    let res: Response;
    try {
      res = await fetch(`http://127.0.0.1:${port()}${path}`, {
        method,
        headers: body ? { "content-type": "application/json" } : {},
        body: body ? JSON.stringify(body) : null,
      });
    } catch {
      throw new DaemonNotRunningError();
    }
    const json = (await res.json()) as T & { error?: string; message?: string };
    if (!res.ok) throw new Error(json.message ?? json.error ?? `HTTP ${res.status}`);
    return json;
  };
}
