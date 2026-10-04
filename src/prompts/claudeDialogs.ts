/**
 * Pure: the dialogs Claude Code shows that no hook announces, read off its screen (PROTOCOL.md "Claude Code
 * dialogs"). One so far: "Switch model?", which it asks when the model is changed in a conversation that already has
 * messages, whoever changed it (an app's `session.model`, or `/model` typed in the terminal).
 *
 *     Switch model?
 *     Your next response will be slower and use more tokens
 *
 *     This conversation is cached for the current model. Switching to Opus 5.5 means the full
 *     history gets re-read on your next message.
 *
 *     ❯ 1. Yes, switch to Opus 5.5
 *       2. No, go back
 *
 * "No, go back" (and Esc) lead back to the `/model` picker, which nobody asked to see again: the choice that says no
 * closes it with Esc once it is on the screen.
 */
import { modelPickerIn, sessionModelIn } from "../models/claudeModelPicker.js";
import { keysTo, menuIn, questionBody, type DialogChoice, type ScreenDialog } from "./screenDialog.js";

/** Claude Code marks the selected row of a menu with "❯". */
const MARK = "❯";
const SWITCH_TITLE = "Switch model?";
const YES = "Yes, switch to ";
const NO = "No";
/** A question is at most 1000 characters (PROTOCOL.md "Prompts"). */
const QUESTION_MAX = 1000;

/** The Claude Code dialog on this screen, or null when none is (or its menu cannot be read). */
export function claudeDialogIn(lines: string[]): ScreenDialog | null {
  const top = lines.map((l) => l.trim()).lastIndexOf(SWITCH_TITLE);
  return top < 0 ? null : switchModelDialog(lines.slice(top + 1));
}

/** `below`: the rows under the dialog's title. */
function switchModelDialog(below: string[]): ScreenDialog | null {
  const menu = menuIn(below, MARK);
  const model = menu.find((r) => r.text.startsWith(YES))?.text.slice(YES.length).trim();
  const yes = keysTo(menu, YES);
  const no = keysTo(menu, NO);
  if (!model || !yes || !no) return null;
  const switchTo: DialogChoice = { label: "Switch", description: `Yes, switch to ${model}.`, keys: yes };
  const keep: DialogChoice = {
    label: "Don't switch",
    description: "Keep the model this session has.",
    keys: no,
    then: { when: (screen) => modelPickerIn(screen) !== null, key: "escape" },
  };
  const why = paragraphs(below.slice(0, below.findIndex((l) => menuIn([l], MARK).length > 0)));
  const question = `Switch to ${model}?${why ? ` ${why}` : ""}`.slice(0, QUESTION_MAX);
  return {
    id: `switch-model:${model}`,
    body: questionBody("Model", question, [switchTo, keep]),
    choices: [switchTo, keep],
    dismiss: keep,
    chose: (screen) => {
      const set = sessionModelIn(screen);
      return set?.model === model ? set : null;
    },
  };
}

/** The dialog's own words as sentences: wrapped rows joined, a blank row ending a paragraph. */
function paragraphs(rows: string[]): string {
  const out: string[] = [];
  let open = false;
  for (const row of rows.map((r) => r.trim())) {
    if (!row) open = false;
    else if (open) out[out.length - 1] += ` ${row}`;
    else {
      out.push(row);
      open = true;
    }
  }
  return out.map((p) => (/[.!?:]$/.test(p) ? p : `${p}.`)).join(" ");
}
