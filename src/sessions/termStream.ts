/**
 * TermStream: one client's live terminal on one session (PROTOCOL.md "Live terminal"). Runs a tmux control-mode client
 * (`tmux -C attach-session`), paints the pane's state first (`firstPaint`), then passes on every byte the pane writes
 * and hands typed bytes to the pane with `send-keys -H`. The window is sized through the registry (`resize`, `by`
 * this stream), so it plays by the same "last client to size it wins" rule as `resize`, and gets its width back on close.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { Logger } from "../log.js";
import { ControlParser, type ControlEvent } from "../tmux/controlParser.js";
import { tmuxEnv } from "../tmux/parse.js";
import { PAINT_HISTORY_ROWS, PANE_STATE_FORMAT, firstPaint, parsePaneState, sendBytesCommands } from "../tmux/termPaint.js";

/** Output is held this long so a burst goes out as one frame. */
const COALESCE_MS = 8;
/** At most this many bytes in one `term.output`. */
const MAX_FRAME_BYTES = 64 * 1024;

export interface TermStreamDeps {
  sessionId: string;
  cols: number;
  rows: number;
  bin?: string;
  /** Sizes the window for this stream (the registry's `resize` with `by` = the stream). */
  resize(cols: number, rows: number, by: object): Promise<void>;
  /** Gives the width back, unless another client sized the window since (the registry's `releaseSize`). */
  release(by: object): Promise<void>;
  output(data: Buffer, reset: boolean): void;
  /** The stream ended without `close()`: the session ended or tmux could not attach. */
  closed(reason: "ended" | "failed"): void;
  log: Logger;
}

export class TermStream {
  private child: ChildProcessWithoutNullStreams | null = null;
  private readonly parser = new ControlParser();
  /** Handlers for the replies to the commands this stream wrote, in order. */
  private readonly replies: ((event: Extract<ControlEvent, { kind: "reply" }>) => void)[] = [];
  private paneId: string | null = null;
  /** Output counts once the first paint is out: anything earlier is already in it. */
  private live = false;
  private pending: Buffer[] = [];
  private pendingBytes = 0;
  private flushTimer: NodeJS.Timeout | null = null;
  private over = false;
  private readonly target: string;

  constructor(private readonly d: TermStreamDeps) {
    this.target = `=${d.sessionId}:`;
  }

  start(): void {
    const bin = this.d.bin ?? process.env["TMUX_BIN"] ?? "tmux";
    const child = spawn(bin, ["-C", "attach-session", "-t", `=${this.d.sessionId}`], { env: tmuxEnv(process.env) });
    this.child = child;
    child.stdout.on("data", (chunk: Buffer) => this.onData(chunk));
    child.stderr.on("data", (chunk: Buffer) => this.d.log.debug("tmux control client said", { session: this.d.sessionId, text: chunk.toString().trim() }));
    child.on("error", (e) => this.end("failed", e.message));
    child.on("exit", () => this.end(this.live ? "ended" : "failed", "tmux control client exited"));
    child.stdin.on("error", () => {});
    void this.paint(this.d.cols, this.d.rows);
  }

  /** Bytes the user typed, to the pane as they are. */
  input(bytes: Buffer): void {
    if (bytes.length === 0) return;
    for (const line of sendBytesCommands(this.target, bytes)) this.command(line);
  }

  resize(cols: number, rows: number): void {
    this.command(`refresh-client -C ${cols}x${rows}`);
    this.d.resize(cols, rows, this).catch((e: unknown) => this.d.log.debug("Could not size the window", { session: this.d.sessionId, error: String(e) }));
  }

  /** The client closed it (or went away): stop quietly and give the width back. */
  close(): void {
    if (this.over) return;
    this.over = true;
    this.stop();
  }

  private async paint(cols: number, rows: number): Promise<void> {
    this.command(`refresh-client -C ${cols}x${rows}`);
    // The window must have the client's size before the screen is read, or the paint has the old width.
    await this.d.resize(cols, rows, this).catch((e: unknown) => this.d.log.debug("Could not size the window", { session: this.d.sessionId, error: String(e) }));
    if (this.over) return;
    let state: ReturnType<typeof parsePaneState> = null;
    this.command(`display-message -p -t ${this.target} "${PANE_STATE_FORMAT}"`, (r) => {
      state = r.ok && r.lines[0] ? parsePaneState(r.lines[0].toString("latin1")) : null;
    });
    this.command(`capture-pane -p -e -S -${PAINT_HISTORY_ROWS} -t ${this.target}`, (r) => {
      if (!r.ok || !state) return this.end("failed", "could not read the pane");
      this.paneId = state.paneId;
      this.d.output(firstPaint(r.lines, state), true);
      this.live = true;
    });
  }

  private command(line: string, onReply?: (event: Extract<ControlEvent, { kind: "reply" }>) => void): void {
    if (!this.child || this.over) return;
    this.replies.push(onReply ?? (() => {}));
    this.child.stdin.write(`${line}\n`);
  }

  private onData(chunk: Buffer): void {
    for (const event of this.parser.feed(chunk)) {
      if (event.kind === "reply") {
        if (event.fromClient) this.replies.shift()?.(event);
      } else if (event.kind === "output") {
        if (this.live && event.pane === this.paneId) this.queue(event.data);
      } else {
        this.end(this.live ? "ended" : "failed", "tmux detached the control client");
      }
    }
  }

  private queue(data: Buffer): void {
    this.pending.push(data);
    this.pendingBytes += data.length;
    if (this.pendingBytes >= MAX_FRAME_BYTES) return this.flush();
    this.flushTimer ??= setTimeout(() => this.flush(), COALESCE_MS);
  }

  private flush(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    if (this.pending.length === 0 || this.over) return;
    const data = Buffer.concat(this.pending);
    this.pending = [];
    this.pendingBytes = 0;
    for (let i = 0; i < data.length; i += MAX_FRAME_BYTES) this.d.output(data.subarray(i, i + MAX_FRAME_BYTES), false);
  }

  private end(reason: "ended" | "failed", why: string): void {
    if (this.over) return;
    this.flush();
    this.over = true;
    this.d.log.debug("Live terminal ended", { session: this.d.sessionId, reason, why });
    this.stop();
    this.d.closed(reason);
  }

  private stop(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    this.pending = [];
    const child = this.child;
    this.child = null;
    if (child && child.exitCode === null) {
      // Detach cleanly: an empty line ends a control client; the kill is for one that does not listen.
      child.stdin.end("\n");
      setTimeout(() => child.kill(), 1000).unref();
    }
    this.d.release(this).catch(() => {});
  }
}
