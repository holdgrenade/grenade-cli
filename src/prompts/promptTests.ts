/**
 * Test cards (`grenade prompt test`): a prompt that looks like one of Claude Code's, put on a session so the
 * phone shows its card, with nothing behind it. What the phone answers comes back as the reply Claude Code
 * would have been given. No agent is asked anything and nothing runs.
 */
import type { PromptFrame, PromptKind } from "@grenade/protocol";
import type { PromptStore } from "./promptStore.js";

export const PROMPT_TEST_KINDS: readonly PromptKind[] = ["permission", "question", "plan"];
/** How long a test card waits for the phone when the caller does not say. */
export const PROMPT_TEST_WAIT_S = 120;
export const PROMPT_TEST_WAIT_MAX_S = 3600;
/** How long a finished test is kept for the CLI to fetch. */
const KEEP_RESULT_MS = 10 * 60 * 1000;

export interface PromptTestResult {
  promptId: string;
  sessionId: string;
  kind: PromptKind;
  /** `answered`: the phone answered. `unanswered`: the wait ran out, or the card was closed another way. */
  outcome: "answered" | "unanswered";
  /** The hook reply the phone's answer became: what Claude Code would have received. */
  reply?: Record<string, unknown>;
}

/** A `PermissionRequest` payload as Claude Code sends it, one per kind of card. Each says it is a test. */
export function testPayload(kind: PromptKind): Record<string, unknown> {
  const base = { hook_event_name: "PermissionRequest", permission_mode: "default" };
  switch (kind) {
    case "permission":
      return {
        ...base,
        tool_name: "Bash",
        tool_input: { command: 'echo "Hello from Grenade"', description: "A test card from grenade prompt test. Nothing runs, whatever you answer." },
      };
    case "question":
      return {
        ...base,
        tool_name: "AskUserQuestion",
        tool_input: {
          questions: [
            {
              question: "This is a test card. Did it reach your phone?",
              header: "Card test",
              options: [
                { label: "Yes, on the phone", description: "The card showed up over the terminal." },
                { label: "Yes, from a notification", description: "A notification brought me here." },
              ],
              multiSelect: false,
            },
            {
              question: "Which parts of the card look right?",
              header: "Looks",
              options: [{ label: "The text" }, { label: "The buttons" }, { label: "The spacing" }],
              multiSelect: true,
            },
          ],
        },
      };
    case "plan":
      return {
        ...base,
        permission_mode: "plan",
        tool_name: "ExitPlanMode",
        tool_input: {
          plan: [
            "# Test plan",
            "",
            "This is a test card from `grenade prompt test`. No agent wrote it and nothing runs.",
            "",
            "## Steps",
            "- Read the plan on the phone.",
            "- Approve it, or send it back with a note.",
            "",
            "## Check",
            "- The answer shows up in the terminal that ran the test.",
          ].join("\n"),
          planFilePath: "/dev/null",
        },
      };
  }
}

export interface PromptTestsOptions {
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (timer: unknown) => void;
}

export class PromptTests {
  private readonly results = new Map<string, Promise<PromptTestResult>>();
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (timer: unknown) => void;

  constructor(private readonly store: PromptStore, opts: PromptTestsOptions = {}) {
    this.setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms).unref());
    this.clearTimer = opts.clearTimer ?? ((t) => clearTimeout(t as NodeJS.Timeout));
  }

  /** Puts a test card on the session. It stays until the phone answers or `waitMs` have passed. */
  start(sessionId: string, kind: PromptKind, waitMs: number): PromptFrame {
    let finish: (result: PromptTestResult) => void = () => {};
    const result = new Promise<PromptTestResult>((resolve) => (finish = resolve));
    let timer: unknown;
    const respond = (reply: Record<string, unknown> | null): void => {
      this.clearTimer(timer);
      const base = { promptId: frame?.promptId ?? "", sessionId, kind };
      finish(reply ? { ...base, outcome: "answered", reply } : { ...base, outcome: "unanswered" });
    };
    // Marked as a test, so the hooks of a session that is busy do not close it.
    const frame = this.store.open(sessionId, testPayload(kind), respond, { test: true });
    // The payloads above always make a prompt; this is for the type.
    if (!frame) throw new Error(`no test card for ${kind}`);
    timer = this.setTimer(() => this.store.expire(frame.promptId), waitMs);
    this.results.set(frame.promptId, result);
    this.setTimer(() => this.results.delete(frame.promptId), waitMs + KEEP_RESULT_MS);
    return frame;
  }

  /** What became of a test card, once it is known. Undefined for an id that is not a test's. */
  result(promptId: string): Promise<PromptTestResult> | undefined {
    return this.results.get(promptId);
  }
}
