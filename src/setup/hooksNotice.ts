/**
 * What `grenade setup` tells a person before it touches their Claude Code settings. Pure.
 * The list is read off the settings themselves (before and after the merge), so it names exactly what would be
 * written, whatever `installHooks.ts` installs.
 */
export interface AddedHook {
  /** The Claude Code hook event. */
  event: string;
  /** What runs on it: a shell command, or the URL an `http` hook posts to. */
  runs: string;
}

/** The hook entries `after` has and `before` lacks, in the order of `after`. */
export function addedHooks(before: unknown, after: unknown): AddedHook[] {
  const had = new Set(entries(before).map((h) => `${h.event}\n${h.runs}`));
  return entries(after).filter((h) => !had.has(`${h.event}\n${h.runs}`));
}

export function hooksNotice(settingsPath: string, added: AddedHook[]): string[] {
  const byWhatRuns = new Map<string, string[]>();
  for (const h of added) byWhatRuns.set(h.runs, [...(byWhatRuns.get(h.runs) ?? []), h.event]);
  const lines = [
    `Grenade can add ${added.length} hook${added.length === 1 ? "" : "s"} to ${settingsPath}`,
    `so the phone knows when Claude Code is working and when it waits for you.`,
  ];
  for (const [runs, events] of byWhatRuns) lines.push(``, `  On    ${events.join(", ")}`, `  Runs  ${runs}`);
  lines.push(
    ``,
    `The PermissionRequest hook is how the phone answers a permission prompt, a question or a plan: Claude Code`,
    `asks the daemon and the terminal at the same moment, and takes the first answer.`,
    ``,
    `Every hook talks to the daemon on this Mac (127.0.0.1) and nowhere else. Your other hooks and settings`,
    `stay as they are. Without the hooks the phone guesses the status from screen changes.`,
    `Take them out again with: grenade install-hooks --remove`,
  );
  return lines;
}

/** The same for Codex's hooks.json, with the one step Codex adds: trusting the hooks once. */
export function codexHooksNotice(hooksPath: string, added: AddedHook[]): string[] {
  const events = added.map((h) => h.event).join(", ");
  const runs = added[0]?.runs ?? "";
  return [
    `Grenade can add ${added.length} hook${added.length === 1 ? "" : "s"} to ${hooksPath}`,
    `so the phone shows what Codex was asked and said, and knows when it is working and when it waits for you.`,
    ``,
    `  On    ${events}`,
    `  Runs  ${runs}`,
    ``,
    `Codex runs new hooks only once you trust them: the next Codex you start shows "Hooks need review".`,
    `Pick "Trust all and continue", in the terminal or from the phone. Until then the phone guesses from the screen.`,
    `Each hook talks to the daemon on this Mac (127.0.0.1), and only inside a Grenade session.`,
    `Take them out again with: grenade install-hooks --remove`,
  ];
}

function entries(settings: unknown): AddedHook[] {
  const hooks = isObject(settings) && isObject(settings["hooks"]) ? settings["hooks"] : {};
  const out: AddedHook[] = [];
  for (const [event, matchers] of Object.entries(hooks)) {
    if (!Array.isArray(matchers)) continue;
    for (const m of matchers) {
      const list = isObject(m) && Array.isArray(m["hooks"]) ? m["hooks"] : [];
      for (const h of list) {
        if (!isObject(h)) continue;
        const runs = typeof h["command"] === "string" ? h["command"] : typeof h["url"] === "string" ? h["url"] : null;
        if (runs !== null) out.push({ event, runs });
      }
    }
  }
  return out;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
