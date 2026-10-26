/**
 * `grenade todo`: the to-do list of the project of the session it runs in (PROTOCOL.md "To-dos"), for an agent the person asked to
 * keep something for later ("add these as to-dos"). `add` adds one, `list` prints the list. Every client shows the
 * change at once, as when the person adds one. Run inside a Grenade session, which `GRENADE_SESSION` names.
 */
import { TODO_TEXT_MAX, TODO_TITLE_MAX, type Todo } from "@grenade/protocol";
import type { Command } from "commander";
import type { Control } from "./controlClient.js";

export interface TodoCommandDeps {
  control: Control;
  /** The session this runs in (`GRENADE_SESSION`). */
  session?: string;
}

/** A to-do from what an agent passed: a title of at most 200 characters (its first sentence when longer) and the whole text. */
export function newTodo(title: string, text?: string): { title: string; text: string } {
  const words = title.replace(/\s+/g, " ").trim();
  const whole = (text?.trim() || words).slice(0, TODO_TEXT_MAX);
  if (words.length <= TODO_TITLE_MAX) return { title: words, text: text?.trim() ? whole : words };
  const sentence = words.match(/^.+?[.!?](?=\s|$)/)?.[0] ?? words;
  const short = sentence.length <= TODO_TITLE_MAX ? sentence : `${sentence.slice(0, TODO_TITLE_MAX - 1).trimEnd()}…`;
  return { title: short, text: text?.trim() ? whole : words.slice(0, TODO_TEXT_MAX) };
}

/** What `grenade todo list` prints: one line per to-do, open ones first, each with its id. */
export function todoLines(todos: readonly Todo[]): string[] {
  if (todos.length === 0) return ["No to-dos."];
  const open = todos.filter((t) => !t.done);
  const done = todos.filter((t) => t.done);
  return [...open.map((t) => `[ ] ${t.title}  (${t.id})`), ...done.map((t) => `[x] ${t.title}  (${t.id})`)];
}

export function registerTodoCommand(program: Command, d: TodoCommandDeps): void {
  const todo = program.command("todo").description("the to-do list of the project of the Grenade session it runs in: add to it, or list it");
  const sessionOf = (o: { session?: string }) => {
    const id = o.session ?? d.session;
    if (!id) throw new Error("run this inside a Grenade session, or name one with --session");
    return id.startsWith("gr-") ? id : `gr-${id}`;
  };
  todo
    .command("add <title>")
    .description("add a to-do to this project's list, which the person sees in Grenade")
    .option("--text <text>", "the whole item, when there is more to it than the title")
    .option("--session <name>", "the session (default: $GRENADE_SESSION)")
    .addHelpText(
      "after",
      [
        "",
        "Add one to-do per item, in the person's terms: a short title (its first sentence), and --text with the detail",
        "they will need to act on it later. They check it off in Grenade, or send it back to you in a prompt.",
      ].join("\n"),
    )
    .action(async (title: string, o: { text?: string; session?: string }) => {
      const id = sessionOf(o);
      const todos = await d.control<Todo[]>("POST", `/sessions/${encodeURIComponent(id)}/todos`, { todos: [newTodo(title, o.text)] });
      const added = todos.at(-1);
      console.log(added ? `added to ${id}'s to-dos: ${added.title} (${added.id})` : `added to ${id}'s to-dos`);
    });
  todo
    .command("list")
    .description("print this project's to-dos")
    .option("--session <name>", "the session (default: $GRENADE_SESSION)")
    .action(async (o: { session?: string }) => {
      const id = sessionOf(o);
      for (const line of todoLines(await d.control<Todo[]>("GET", `/sessions/${encodeURIComponent(id)}/todos`))) console.log(line);
    });
}
