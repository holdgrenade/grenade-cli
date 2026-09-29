/** Calls the daemon's loopback control API (src/daemon/control.ts) for the CLI. */
export class DaemonNotRunningError extends Error {
  constructor() {
    super("grenaded is not running. Start it with: grenade service install (or in the foreground: grenade daemon)");
  }
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
