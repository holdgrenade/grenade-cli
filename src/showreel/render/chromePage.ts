/**
 * A page in headless Chrome, driven over the DevTools protocol (Canvas 2, R1B: the renderer steps the motion page
 * frame by frame). Chrome is found on this computer (never downloaded); it runs headless on a port of its own, with
 * file access, and is stopped when the render ends. `ws` carries the protocol, as it carries the phones.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { platform } from "node:os";
import WebSocket from "ws";
import { findOnPath } from "../../platform/findOnPath.js";

const CHROME_CANDIDATES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
];

/** Where a Chrome is on this computer, or null. `GRENADE_CHROME` overrides. */
export function resolveChrome(): string | null {
  const fromEnv = process.env["GRENADE_CHROME"];
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  for (const name of ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"]) {
    const found = findOnPath(name);
    if (found) return found;
  }
  return CHROME_CANDIDATES.find((c) => existsSync(c)) ?? null;
}

export class ChromeError extends Error {}

/** One headless Chrome with one page. */
export class ChromePage {
  private seq = 0;
  private readonly waiting = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private readonly events: ((method: string, params: unknown) => void)[] = [];

  private constructor(
    private readonly child: ChildProcess,
    private readonly socket: WebSocket,
  ) {
    socket.on("message", (data) => {
      const message = JSON.parse(String(data)) as { id?: number; result?: unknown; error?: { message: string }; method?: string; params?: unknown };
      if (message.id !== undefined) {
        const w = this.waiting.get(message.id);
        this.waiting.delete(message.id);
        if (!w) return;
        if (message.error) w.reject(new ChromeError(message.error.message));
        else w.resolve(message.result);
      } else if (message.method) {
        for (const cb of this.events) cb(message.method, message.params);
      }
    });
  }

  /** Starts Chrome headless at `width` × `height` and opens one page. */
  static async open(chrome: string, width: number, height: number, userDataDir: string): Promise<ChromePage> {
    const args = ["--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run", "--no-default-browser-check", "--allow-file-access-from-files", "--autoplay-policy=no-user-gesture-required", "--mute-audio", `--user-data-dir=${userDataDir}`, "--remote-debugging-port=0", `--window-size=${width},${height}`, "about:blank"];
    if (platform() === "linux") args.push("--no-sandbox");
    const child = spawn(chrome, args, { stdio: ["ignore", "ignore", "pipe"] });
    const endpoint = await new Promise<string>((resolve, reject) => {
      let err = "";
      const timer = setTimeout(() => reject(new ChromeError(`Chrome did not start: ${err.trim().slice(0, 200)}`)), 20_000);
      child.stderr?.on("data", (d: Buffer) => {
        err += d.toString();
        const m = /DevTools listening on (ws:\/\/[^\s]+)/.exec(err);
        if (m) {
          clearTimeout(timer);
          resolve(m[1]!);
        }
      });
      child.on("exit", (code) => {
        clearTimeout(timer);
        reject(new ChromeError(`Chrome exited with ${code}: ${err.trim().slice(0, 200)}`));
      });
    });
    const port = new URL(endpoint).port;
    const targets = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as { type: string; webSocketDebuggerUrl: string }[];
    const page = targets.find((t) => t.type === "page");
    if (!page) {
      child.kill();
      throw new ChromeError("Chrome opened no page");
    }
    const socket = new WebSocket(page.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 });
    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve());
      socket.once("error", (e) => reject(new ChromeError(`Could not reach Chrome: ${e.message}`)));
    });
    const self = new ChromePage(child, socket);
    await self.send("Page.enable");
    await self.send("Runtime.enable");
    await self.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
    return self;
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  /** Loads a URL and waits for its load event. */
  async navigate(url: string): Promise<void> {
    const loaded = new Promise<void>((resolve) => {
      const cb = (method: string) => {
        if (method === "Page.loadEventFired") {
          this.events.splice(this.events.indexOf(cb), 1);
          resolve();
        }
      };
      this.events.push(cb);
    });
    await this.send("Page.navigate", { url });
    await Promise.race([loaded, new Promise<void>((r) => setTimeout(r, 30_000))]);
  }

  /** Runs an expression in the page and resolves with its value (a promise is awaited). */
  async evaluate<T>(expression: string): Promise<T> {
    const result = (await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })) as { result: { value: T }; exceptionDetails?: { text: string; exception?: { description?: string } } };
    if (result.exceptionDetails) throw new ChromeError(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result.value;
  }

  /** The page as a PNG. */
  async screenshot(format: "png" | "jpeg" = "png", quality = 92): Promise<Buffer> {
    const result = (await this.send("Page.captureScreenshot", { format, ...(format === "jpeg" ? { quality } : {}), captureBeyondViewport: false })) as { data: string };
    return Buffer.from(result.data, "base64");
  }

  async close(): Promise<void> {
    try {
      this.socket.close();
    } catch {
      // closing anyway
    }
    this.child.kill();
    await new Promise<void>((r) => {
      this.child.once("exit", () => r());
      setTimeout(r, 3000);
    });
  }
}
