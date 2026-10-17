/**
 * ConnectorReader (PROTOCOL.md "Connectors"): answers `connectors` from `claude mcp list`, run in the owner's home
 * folder. A reading checks every MCP server and takes seconds, so one under `CONNECTORS_FRESH_MS` old is answered
 * as it is unless the client asks to refresh, and two never run at once.
 */
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { CONNECTORS_FRESH_MS, type ConnectorsFrame } from "@grenade/protocol";
import { computerWord } from "../platform/computer.js";
import { resolveClaudeBin } from "../summary/claudeCli.js";
import { connectorsFrom, mcpServersIn } from "./mcpList.js";

/** `claude mcp list` waits on every server it checks; one that hangs must not hold the answer forever. */
const LIST_TIMEOUT_MS = 45_000;

/** Runs `claude mcp list` and gives its output, or throws with a sentence for the owner. */
export type McpListRunner = () => Promise<string>;

export class ConnectorReader {
  private last: ConnectorsFrame | undefined;
  private lastAt = 0;
  private reading: Promise<ConnectorsFrame> | undefined;

  constructor(
    private readonly run: McpListRunner = runClaudeMcpList,
    private readonly now: () => number = Date.now,
  ) {}

  /** The connectors: the last reading while it is fresh and `refresh` is not asked, else a new one. */
  read(refresh = false): Promise<ConnectorsFrame> {
    if (this.reading) return this.reading;
    if (!refresh && this.last && this.now() - this.lastAt < CONNECTORS_FRESH_MS) return Promise.resolve(this.last);
    this.reading = this.readNow().finally(() => (this.reading = undefined));
    return this.reading;
  }

  private async readNow(): Promise<ConnectorsFrame> {
    const at = this.now();
    let frame: ConnectorsFrame;
    try {
      frame = { type: "connectors", connectors: connectorsFrom(mcpServersIn(await this.run())), at: new Date(at).toISOString() };
    } catch (e) {
      // Not kept: the next request tries again, so installing Claude Code shows at once.
      return { type: "connectors", connectors: [], at: new Date(at).toISOString(), problem: (e instanceof Error ? e.message : String(e)).slice(0, 300) };
    }
    this.last = frame;
    this.lastAt = at;
    return frame;
  }
}

/** `claude mcp list` from the home folder (no project's `.mcp.json`), without GRENADE_SESSION so it never reports as a session. */
export function runClaudeMcpList(): Promise<string> {
  const bin = resolveClaudeBin();
  if (!bin) return Promise.reject(new Error(`Claude Code is not installed on this ${computerWord()}.`));
  const env = { ...process.env };
  delete env["GRENADE_SESSION"];
  return new Promise((resolve, reject) => {
    execFile(bin, ["mcp", "list"], { cwd: homedir(), env, timeout: LIST_TIMEOUT_MS, maxBuffer: 1024 * 1024 }, (error, stdout) => {
      // It exits 0 even when a server failed; a non-zero exit with lines printed still lists what it checked.
      if (error && !stdout) return reject(new Error(`Could not read Claude Code's MCP servers: ${error.killed ? "it did not answer in time" : error.message.split("\n")[0]}`));
      resolve(stdout);
    });
  });
}
