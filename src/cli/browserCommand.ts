/**
 * `grenade browser open|screenshot|eval|release`: an agent drives its browser, a tab in the Grenade app's toolbox on
 * this computer (PROTOCOL.md "Agent browser"). Run inside a Grenade session, which `GRENADE_SESSION` names; the tab is
 * that session's, in its group. The person sees it dimmed under "Take control" and can take it back at any time.
 */
import { readFileSync } from "node:fs";
import type { Command } from "commander";
import type { Control } from "./controlClient.js";

export interface BrowserCommandDeps {
  control: Control;
  /** The session this runs in (`GRENADE_SESSION`). */
  session?: string;
}

interface BrowserReply {
  ok: boolean;
  message?: string;
  url?: string;
  title?: string;
  value?: string;
  path?: string;
}

export function registerBrowserCommand(program: Command, d: BrowserCommandDeps): void {
  const browser = program
    .command("browser")
    .description("drive a browser tab in the Grenade app's toolbox, from an agent in a Grenade session")
    .option("--session <name>", "the session whose tab it is (default: $GRENADE_SESSION)")
    .addHelpText(
      "after",
      [
        "",
        "The tab opens in the session's group, in the app on this computer. While the agent has it, it is dimmed under",
        "a \"Take control\" button; once the person takes it, commands fail and `open` starts a new tab.",
        "",
        "Examples:",
        "  grenade browser open 3000                  # http://localhost:3000",
        "  grenade browser screenshot                 # prints the PNG's path: read it to see the page",
        "  grenade browser eval 'return document.title'",
        "  grenade browser eval 'document.querySelector(\"button\").click()'",
        "  grenade browser eval - < script.js         # the script from stdin",
        "  grenade browser release                    # give the tab back to the person",
      ].join("\n"),
    );

  const run = async (body: Record<string, unknown>, print: (r: BrowserReply) => string | undefined): Promise<void> => {
    const session = browser.opts<{ session?: string }>().session ?? d.session;
    if (!session) throw new Error("run this inside a Grenade session, or name one with --session");
    const reply = await d.control<BrowserReply>("POST", "/browser", { session, ...body });
    if (!reply.ok) {
      console.error(reply.message ?? "the browser could not do that");
      process.exitCode = 1;
      return;
    }
    const line = print(reply);
    if (line !== undefined) console.log(line);
  };

  browser
    .command("open <address>")
    .description("load a page in the session's tab (a port alone is localhost), and wait for it")
    .action((address: string) => run({ action: "open", url: browserUrl(address) }, pageLine));

  browser
    .command("screenshot")
    .description("save what the tab shows to a PNG and print its path")
    .action(() => run({ action: "screenshot" }, (r) => r.path));

  browser
    .command("eval <script>")
    .description("run a script in the page, as the body of an async function (`-` reads it from stdin); prints what it returns as JSON")
    .action((script: string) => run({ action: "eval", script: script === "-" ? readFileSync(0, "utf8") : script }, (r) => r.value ?? "undefined"));

  browser
    .command("release")
    .description("give the tab back to the person; it stays open")
    .action(() => run({ action: "release" }, () => "released"));
}

/** `3000` → `http://localhost:3000/`, `localhost:5173/x` → `http://localhost:5173/x`; an address with a scheme as it is. Pure. */
export function browserUrl(address: string): string {
  const typed = address.trim();
  if (/^\d{2,5}(\/.*)?$/.test(typed)) return `http://localhost:${typed}`;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(typed)) return typed;
  const local = /^(localhost|127\.0\.0\.1|\[::1\]|[\w-]+\.local)(:\d+)?(\/|$)/i.test(typed);
  return `${local ? "http" : "https"}://${typed}`;
}

function pageLine(r: BrowserReply): string {
  return [r.title, r.url].filter(Boolean).join("  ") || "opened";
}
