import { describe, expect, it } from "vitest";
import { RECENT_WRITE_MS, codexIdsInProcesses, codexOpenElsewhere } from "../src/conversations/runningCodex.js";
import { withLastSessions } from "../src/conversations/heldConversations.js";
import type { Conversation, Session } from "@grenade/protocol";

const A = "0190c0de-1111-7000-8000-00000000000a";
const B = "0190c0de-2222-7000-8000-00000000000b";

describe("Codex threads open elsewhere", () => {
  it("finds a thread a codex process names, and nothing in other programs' arguments", () => {
    const ps = [
      "/opt/homebrew/bin/codex resume --no-alt-screen " + A,
      "vim notes-" + B + ".md",
      "/bin/zsh -c codex resume " + B,
      "/usr/local/bin/node /usr/local/lib/node_modules/@openai/codex/bin/codex.js fork " + B,
      "/bin/zsh -l",
    ].join("\n");
    expect([...codexIdsInProcesses(ps, [A, B])]).toEqual([A, B]);
    expect([...codexIdsInProcesses("/bin/zsh -c codex resume " + B, [B])]).toEqual([]);
  });

  it("counts a named thread or one written just now, never one a Grenade session is in", () => {
    const now = 10 * RECENT_WRITE_MS;
    const rollouts = [
      { id: A, mtimeMs: now - 1000 },
      { id: B, mtimeMs: now - 2 * RECENT_WRITE_MS },
      { id: "old-but-named", mtimeMs: 0 },
      { id: "ours", mtimeMs: now },
    ];
    const open = codexOpenElsewhere({ rollouts, named: new Set(["old-but-named", "ours"]), ours: new Set(["ours"]), now });
    expect([...open].sort()).toEqual([A, "old-but-named"].sort());
  });
});

describe("withLastSessions", () => {
  const conversation = (id: string, over: Partial<Conversation> = {}): Conversation => ({ id, agent: "claude", cwd: "/w", title: id, updatedAt: "2026-10-29T09:00:00.000Z", ...over });
  const session = (id: string, status: Session["status"], statusSince: string): Session => ({ id, name: id, agent: "claude", cwd: "/w", status, statusSince, lastLine: "", createdAt: "2026-10-29T08:00:00.000Z" });

  it("names the newest ended session a conversation was in, and none for a conversation a live session holds", () => {
    const list = withLastSessions(
      [conversation("c1"), conversation("c2", { sessionId: "gr-live" }), conversation("c3")],
      [session("gr-old", "gone", "2026-10-29T08:30:00.000Z"), session("gr-new", "gone", "2026-10-29T09:30:00.000Z"), session("gr-live", "idle", "2026-10-29T09:00:00.000Z")],
      [{ id: "gr-old", path: "/p/c1.jsonl" }, { id: "gr-new", path: "/p/c1.jsonl" }, { id: "gr-live", path: "/p/c2.jsonl" }],
    );
    expect(list.map((c) => c.lastSession)).toEqual(["gr-new", undefined, undefined]);
  });
});
