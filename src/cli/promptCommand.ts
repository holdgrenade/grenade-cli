/** `grenade prompt test`: puts a test card on a session and says what the phone answered. */
import { InvalidArgumentError, type Command } from "commander";
import { PromptKind } from "@grenade/protocol";
import { PROMPT_TEST_KINDS, PROMPT_TEST_WAIT_MAX_S, PROMPT_TEST_WAIT_S, type PromptTestResult } from "../prompts/promptTests.js";
import type { Control } from "./controlClient.js";
import { answerLines, messageToAgent } from "./promptAnswer.js";

export interface PromptCommandDeps {
  control: Control;
}

interface Started {
  promptId: string;
  sessionId: string;
  sessionName: string;
  kind: PromptKind;
  phones: number;
}

export function registerPromptCommand(program: Command, d: PromptCommandDeps): void {
  const prompt = program.command("prompt").description("the cards a phone answers when Claude Code asks for permission, asks a question or shows a plan");

  prompt
    .command("test [session]")
    .description("show a test card on the phone and print what it answers; no agent is asked and nothing runs")
    .option("--kind <kind>", "permission, question, plan, or all for one after the other", parseKind, "permission")
    .option("--wait <seconds>", "how long to wait for the phone", parseWait, PROMPT_TEST_WAIT_S)
    .action(async (session: string | undefined, o: { kind: PromptKind | "all"; wait: number }) => {
      for (const kind of o.kind === "all" ? PROMPT_TEST_KINDS : [o.kind]) {
        const started = await d.control<Started>("POST", "/prompts/test", { kind, wait: o.wait, ...(session ? { session } : {}) });
        console.log(`Sent a ${kind} card to "${started.sessionName}". Open that session in Grenade on the phone.`);
        if (started.phones === 0) console.log("No phone is connected right now. The card will be there when one connects.");
        console.log(`Waiting up to ${o.wait} s for an answer…`);
        const result = await waitForAnswer(d.control, started.promptId, o.wait);
        for (const line of resultLines(result)) console.log(line);
        console.log("");
      }
    });
}

/**
 * Asks the daemon what became of a test card, again and again until it says. One request cannot wait that long:
 * Node gives up on a request that has had no answer for five minutes, and the daemon only answers once the phone
 * has. A request that ends without an answer while the daemon is still there is simply asked again.
 */
export async function waitForAnswer(control: Control, promptId: string, waitSeconds: number, now: () => number = Date.now): Promise<PromptTestResult> {
  // The daemon closes the card when the wait is over, so a little after that there is always an answer.
  const giveUpAt = now() + (waitSeconds + 30) * 1000;
  for (;;) {
    try {
      return await control<PromptTestResult>("GET", `/prompts/test/${promptId}`);
    } catch (e) {
      if (now() >= giveUpAt) throw e;
      // Throws when the daemon really is gone, which ends the wait with the reason.
      await control("GET", "/status");
    }
  }
}

export function resultLines(result: PromptTestResult): string[] {
  if (result.outcome !== "answered" || !result.reply) return ["No answer. The card is gone from the phone."];
  const said = messageToAgent(result.reply);
  return [
    "The phone answered:",
    ...answerLines(result.kind, result.reply).map((line) => `  ${line}`),
    ...(said ? ["The agent would have been told:", `  ${said}`] : []),
    "Claude Code would have received:",
    `  ${JSON.stringify(result.reply)}`,
  ];
}

function parseKind(value: string): PromptKind | "all" {
  if (value === "all") return value;
  const kind = PromptKind.safeParse(value);
  if (!kind.success) throw new InvalidArgumentError("choose permission, question, plan or all");
  return kind.data;
}

function parseWait(value: string): number {
  const seconds = Number(value);
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > PROMPT_TEST_WAIT_MAX_S) throw new InvalidArgumentError(`a number of seconds from 1 to ${PROMPT_TEST_WAIT_MAX_S}`);
  return seconds;
}
