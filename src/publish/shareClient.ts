/**
 * The share host's HTTP API from the daemon's side (PROTOCOL.md "Share host"): the manifest, the files it lacks, and
 * taking a link down. Every call has a time limit and rejects with `ShareHostError`, whose message is a sentence for
 * the user.
 */
import { ShareError, ShareManifestReply, type ShareManifest } from "@grenade/protocol";

export class ShareHostError extends Error {
  constructor(
    message: string,
    /** The HTTP status, 0 when the host did not answer. */
    readonly status: number,
  ) {
    super(message);
  }
}

export type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body?: string | Uint8Array; signal: AbortSignal }) => Promise<{ status: number; ok: boolean; json(): Promise<unknown>; text(): Promise<string> }>;

const TIMEOUT_MS = 30_000;

export class ShareClient {
  constructor(
    readonly host: string,
    private readonly fetcher: Fetch = fetch as unknown as Fetch,
  ) {}

  private url(path: string): string {
    return `${this.host.replace(/\/+$/, "")}${path}`;
  }

  private async call(method: string, path: string, key: string, body?: string | Uint8Array, type?: string) {
    let response;
    try {
      response = await this.fetcher(this.url(path), {
        method,
        headers: { Authorization: `Bearer ${key}`, ...(type ? { "Content-Type": type } : {}) },
        ...(body !== undefined ? { body } : {}),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw new ShareHostError("The share host did not answer.", 0);
    }
    if (response.ok) return response;
    let message = `The share host answered ${response.status}.`;
    try {
      const parsed = ShareError.safeParse(await response.json());
      if (parsed.success) message = parsed.data.message;
    } catch {
      // Not JSON: keep the status.
    }
    throw new ShareHostError(message, response.status);
  }

  /** Sends what the page shows; resolves with the files the host lacks. */
  async putManifest(token: string, key: string, manifest: ShareManifest): Promise<string[]> {
    const response = await this.call("PUT", `/v1/c/${token}`, key, JSON.stringify(manifest), "application/json");
    const parsed = ShareManifestReply.safeParse(await response.json().catch(() => null));
    if (!parsed.success) throw new ShareHostError("The share host answered something unexpected.", response.status);
    return parsed.data.missing;
  }

  async putFile(token: string, key: string, file: string, bytes: Uint8Array): Promise<void> {
    await this.call("PUT", `/v1/c/${token}/f/${encodeURIComponent(file)}`, key, bytes, "application/octet-stream");
  }

  /** Takes a link down. A link the host does not have (404) is down already. */
  async remove(token: string, key: string): Promise<void> {
    try {
      await this.call("DELETE", `/v1/c/${token}`, key);
    } catch (e) {
      if (e instanceof ShareHostError && e.status === 404) return;
      throw e;
    }
  }
}
