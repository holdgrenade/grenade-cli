/**
 * Pure: what a Codex rollout says is waiting for the person (PROTOCOL.md "Codex questions and plans"): a
 * `request_user_input` call not answered yet, and the plan of the newest `<proposed_plan>` block. No hook announces
 * either; the screen says when one is up, and the rollout holds its words.
 */
import { PROMPT_PLAN_MAX, type PromptQuestion } from "@grenade/protocol";

/** One question of Codex's `request_user_input`, as the card shows it. */
export interface CodexQuestion {
  id: string;
  header?: string;
  question: string;
  options: { label: string; description?: string }[];
}

interface Line {
  type?: string;
  payload?: { type?: string; name?: string; call_id?: string; arguments?: string; role?: string; content?: { type?: string; text?: string }[] };
}

function linesOf(jsonl: string): Line[] {
  const out: Line[] = [];
  for (const raw of jsonl.split("\n")) {
    if (!raw.trim()) continue;
    try {
      out.push(JSON.parse(raw) as Line);
    } catch {
      // A line still being written.
    }
  }
  return out;
}

/** The newest `request_user_input` call that has no output yet, with its questions; null when every one is answered. */
export function codexOpenQuestionsIn(jsonl: string): { callId: string; questions: CodexQuestion[] } | null {
  const lines = linesOf(jsonl);
  const answered = new Set(lines.filter((l) => l.payload?.type === "function_call_output").map((l) => l.payload?.call_id));
  for (let i = lines.length - 1; i >= 0; i--) {
    const p = lines[i]!.payload;
    if (p?.type !== "function_call" || p.name !== "request_user_input" || !p.call_id) continue;
    if (answered.has(p.call_id)) return null;
    const questions = questionsOf(p.arguments);
    return questions.length > 0 ? { callId: p.call_id, questions } : null;
  }
  return null;
}

function questionsOf(args: string | undefined): CodexQuestion[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(args ?? "");
  } catch {
    return [];
  }
  const raw = (parsed as { questions?: unknown } | null)?.questions;
  if (!Array.isArray(raw)) return [];
  const out: CodexQuestion[] = [];
  for (const q of raw) {
    if (typeof q !== "object" || q === null) continue;
    const { id, header, question, options } = q as Record<string, unknown>;
    if (typeof question !== "string" || !question.trim()) continue;
    const opts = Array.isArray(options)
      ? options.flatMap((o) => {
          const { label, description } = (o ?? {}) as Record<string, unknown>;
          return typeof label === "string" && label ? [{ label, ...(typeof description === "string" && description ? { description } : {}) }] : [];
        })
      : [];
    out.push({ id: typeof id === "string" ? id : `q${out.length + 1}`, ...(typeof header === "string" && header ? { header } : {}), question, options: opts });
  }
  return out;
}

/** The questions as a card shows them. Codex takes one choice each; a typed answer goes in as its note. */
export function cardQuestions(questions: readonly CodexQuestion[]): PromptQuestion[] {
  return questions.slice(0, 4).map((q) => ({
    question: q.question.slice(0, 1000),
    ...(q.header ? { header: q.header.slice(0, 60) } : {}),
    options: q.options.slice(0, 10).map((o) => ({ label: o.label.slice(0, 200), ...(o.description ? { description: o.description.slice(0, 500) } : {}) })),
    multiSelect: false,
  }));
}

const PLAN_CUT = "\n\n… (the plan goes on in the terminal)";

/** The plan of the newest `<proposed_plan>` block Codex wrote, in Markdown; null when it wrote none. */
export function codexProposedPlanIn(jsonl: string): string | null {
  const lines = linesOf(jsonl);
  for (let i = lines.length - 1; i >= 0; i--) {
    const p = lines[i]!.payload;
    if (p?.type !== "message" || p.role !== "assistant") continue;
    for (const c of [...(p.content ?? [])].reverse()) {
      const m = /<proposed_plan>\s*\n?([\s\S]*?)\n?\s*<\/proposed_plan>/.exec(c.text ?? "");
      if (m) return m[1]!.trim();
    }
  }
  return null;
}

/** A plan as a `plan` card carries it, cut to fit. */
export function cardPlan(plan: string): string {
  return plan.length <= PROMPT_PLAN_MAX ? plan : plan.slice(0, PROMPT_PLAN_MAX - PLAN_CUT.length) + PLAN_CUT;
}
