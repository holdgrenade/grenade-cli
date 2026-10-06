/**
 * `grenade talk "<words>" | talk agent [claude|codex] | talk log`: typed Talk from the terminal, through the control
 * API (PROTOCOL.md "Talk by text"). `talk` says the words as a phone's `talk.say` would and prints the rows that
 * follow until the agent's turn ends. `grenade talk-mcp` (hidden) is the MCP server the agent itself runs.
 */
import type { Command } from "commander";
import type { AgentInfo, TalkEntry, TalkThreadFrame } from "@grenade/protocol";
import { computerWord } from "../platform/computer.js";
import { runTalkMcp } from "../talk/talkMcp.js";
import type { Control } from "./controlClient.js";

export interface TalkCommandDeps {
  control: Control;
  version: string;
}

/** How often `grenade talk` looks for new rows, and how long it waits for the turn at most. */
const POLL_MS = 700;
const WAIT_MS = 6 * 60 * 1000;

export function registerTalkCommand(program: Command, d: TalkCommandDeps): void {
  const talk = program
    .command("talk")
    .description(`tell Grenade what you want done; an agent on this ${computerWord()} sends it to the right session (typed Talk)`)
    .argument("[words...]", "what you want done, such as: ask the relay one to bump its version")
    .action(async (words: string[]) => {
      const text = words.join(" ").trim();
      if (!text) return printThread(await d.control<TalkThreadFrame>("GET", "/talk/thread"));
      await say(d.control, text);
    });

  talk
    .command("agent [agent]")
    .description("which agent answers typed Talk; with an agent, choose it")
    .action(async (agent?: string) => {
      const thread = agent ? await d.control<TalkThreadFrame>("POST", "/talk/agent", { agent }) : await d.control<TalkThreadFrame>("GET", "/talk/thread");
      const status = await d.control<{ agents?: AgentInfo[] }>("GET", "/status");
      for (const line of agentLines(thread.agent, status.agents ?? [])) console.log(line);
    });

  talk
    .command("log")
    .description("today's Talk thread")
    .action(async () => printThread(await d.control<TalkThreadFrame>("GET", "/talk/thread")));

  program
    .command("talk-mcp", { hidden: true })
    .description("the MCP server typed Talk's agent runs (started by grenaded, not by hand)")
    .action(() => runTalkMcp(d.version));
}

/** Says the words, then prints each row that follows until the turn is over. */
async function say(control: Control, text: string): Promise<void> {
  const { id } = await control<{ id: string; said: boolean }>("POST", "/talk/say", { text });
  const shown = new Set<string>([id]);
  const deadline = Date.now() + WAIT_MS;
  let seenBusy = false;
  for (;;) {
    const thread = await control<TalkThreadFrame>("GET", "/talk/thread");
    const at = thread.entries.findIndex((e) => e.id === id);
    for (const entry of at >= 0 ? thread.entries.slice(at + 1) : []) {
      if (shown.has(entry.id)) continue;
      shown.add(entry.id);
      console.log(rowLine(entry));
    }
    seenBusy ||= thread.busy;
    // Done once the agent stopped after our words, and something answered them.
    if (!thread.busy && (seenBusy || at < thread.entries.length - 1)) return;
    if (Date.now() > deadline) return console.log("(still working: `grenade talk log` shows the rest)");
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

function printThread(thread: TalkThreadFrame): void {
  console.log(`Talk · ${thread.date}${thread.agent ? ` · answered by ${thread.agent}` : " · no agent can answer"}${thread.busy ? " · working" : ""}`);
  if (thread.entries.length === 0) console.log("(nothing said today)");
  for (const entry of thread.entries) console.log(rowLine(entry));
}

/** One row as the terminal shows it. Pure. */
export function rowLine(entry: TalkEntry, timeZone?: string): string {
  const time = new Date(entry.at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", ...(timeZone ? { timeZone } : {}) });
  const title = entry.title ? `"${entry.title}"` : "a session";
  const body = (() => {
    switch (entry.kind) {
      case "you":
        return `you: ${entry.text}`;
      case "it":
        return `talk: ${entry.text}`;
      case "sent":
        return `→ sent to ${title}: ${entry.text}`;
      case "started":
        return `+ started ${title}: ${entry.text}`;
      case "which":
        return `? ${entry.text} ${(entry.choices ?? []).map((c, i) => `[${i + 1}] ${c.title}${c.status ? ` (${c.status})` : ""}`).join("  ")}`;
      case "needsYou":
        return `! ${title} needs you`;
      case "finished":
        return `✓ ${title} finished`;
      case "failed":
        return `✗ ${entry.text}`;
      default:
        return `${entry.kind}: ${entry.text}`;
    }
  })();
  return `${time}  ${body}`;
}

/** What `grenade talk agent` prints. Pure. */
export function agentLines(current: string | undefined, agents: readonly AgentInfo[]): string[] {
  const able = agents.filter((a) => a.talk === true);
  if (able.length === 0) return [`No agent that can answer Talk is installed on this ${computerWord()}. Install Claude Code or Codex.`];
  return [
    `Talk is answered by ${agents.find((a) => a.kind === current)?.name ?? current ?? "nobody"}.`,
    `Agents that can answer: ${able.map((a) => `${a.kind} (${a.name})`).join(", ")}. Choose one with: grenade talk agent <agent>`,
  ];
}
