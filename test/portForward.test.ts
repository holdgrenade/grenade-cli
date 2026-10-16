import { createConnection, createServer, type AddressInfo, type Server } from "node:net";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { FORWARD_STREAMS_MAX, type DaemonFrame } from "@grenade/protocol";
import { PortForwards, type ForwardSocket } from "../src/forward/portForward.js";

const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const b64 = (s: string) => Buffer.from(s).toString("base64");
const text = (frames: DaemonFrame[]) =>
  frames.flatMap((f) => (f.type === "forward.data" ? [Buffer.from(f.data, "base64").toString()] : [])).join("");

describe("PortForwards", () => {
  let server: Server | undefined;
  afterEach(() => server?.close());

  /** An echo server on a free loopback port that answers "echo:" + what it got. */
  const echo = async (): Promise<number> => {
    server = createServer((socket) => socket.on("data", (d) => socket.write("echo:" + d.toString())));
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
    return (server!.address() as AddressInfo).port;
  };

  it("connects to a loopback port and carries bytes both ways, writing what came before the connect", async () => {
    const port = await echo();
    const out: DaemonFrame[] = [];
    const forwards = new PortForwards((f) => out.push(f));
    forwards.open("s1", port);
    forwards.data("s1", b64("hello")); // before the socket has connected
    await settle(80);
    expect(out[0]).toEqual({ type: "forward.opened", id: "s1" });
    expect(text(out)).toBe("echo:hello");
    forwards.close("s1");
    await settle();
    // Closed by the client: nothing more for it, not even forward.closed.
    expect(out.filter((f) => f.type === "forward.closed")).toEqual([]);
    expect(forwards.count).toBe(0);
  });

  it("says refused when nothing listens on the port, after trying IPv6 too", async () => {
    const port = await echo();
    server!.close();
    server = undefined;
    const out: DaemonFrame[] = [];
    const hosts: string[] = [];
    const forwards = new PortForwards((f) => out.push(f), (host, p) => {
      hosts.push(host);
      return createConnection({ host, port: p });
    });
    forwards.open("s1", port);
    await settle(120);
    expect(hosts).toEqual(["127.0.0.1", "::1"]);
    expect(out).toEqual([{ type: "forward.closed", id: "s1", reason: "refused" }]);
  });

  it("tells the client when the port's side closes, and closes every stream with the connection", async () => {
    const sockets: FakeSocket[] = [];
    const out: DaemonFrame[] = [];
    const forwards = new PortForwards((f) => out.push(f), () => { const s = new FakeSocket(); sockets.push(s); return s; });
    forwards.open("a", 3000);
    forwards.open("b", 3000);
    sockets.forEach((s) => s.emit("connect"));
    sockets[0]!.emit("close");
    expect(out).toContainEqual({ type: "forward.closed", id: "a", reason: "ended" });
    forwards.closeAll();
    expect(sockets[1]!.destroyed).toBe(true);
    expect(forwards.count).toBe(0);
  });

  it("refuses more than its streams at once, and splits a large read into frames", () => {
    const sockets: FakeSocket[] = [];
    const out: DaemonFrame[] = [];
    const forwards = new PortForwards((f) => out.push(f), () => { const s = new FakeSocket(); sockets.push(s); return s; });
    for (let i = 0; i < FORWARD_STREAMS_MAX; i++) forwards.open("s" + i, 3000);
    forwards.open("one-more", 3000);
    expect(out).toEqual([{ type: "forward.closed", id: "one-more", reason: "failed" }]);
    sockets[0]!.emit("connect");
    sockets[0]!.emit("data", Buffer.alloc(600 * 1024, 1));
    expect(out.filter((f) => f.type === "forward.data").length).toBe(3);
  });
});

class FakeSocket extends EventEmitter implements ForwardSocket {
  destroyed = false;
  written: Buffer[] = [];
  write(data: Buffer) { this.written.push(data); }
  end() {}
  destroy() { this.destroyed = true; }
}
