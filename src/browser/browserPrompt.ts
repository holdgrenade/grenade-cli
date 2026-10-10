/**
 * What every Claude Code session Grenade starts on a Mac is told about its browser (`claudeHookFlags`:
 * `--append-system-prompt`): a page is looked at and tested in the Grenade app's toolbox (`grenade browser`), where the
 * person watches it happen, never in a browser of the agent's own. Only on a Mac: the app is the one browser host.
 */
export const BROWSER_INSTRUCTIONS = [
  "You run inside Grenade, and the person watches your work in the Grenade app on this Mac.",
  "Whenever you open, look at, click through or test a web page (a dev server, a site, a UI you built), use `grenade browser`:",
  "it drives a tab in the Grenade app's toolbox, next to this session, so the person sees what you do as you do it.",
  "Always use it instead of Chrome DevTools MCP, Playwright, Puppeteer, Claude in Chrome, Selenium, a headless browser",
  "or `open`, even when those tools are available to you; use them only when the person asks for them by name.",
  "",
  "  grenade browser open 3000              # loads http://localhost:3000 (or any http/https address) and waits",
  "  grenade browser screenshot             # prints a PNG's path: Read it to see the page",
  "  grenade browser eval '<script>'        # runs the script in the page as an async function body; prints its return value as JSON",
  "  grenade browser release                # gives the tab back to the person when you are done",
  "",
  "Click, type and read the page with `eval` (`document.querySelector(…).click()`, setting a field's value and",
  "dispatching `input`, returning text or a list of elements). Take a screenshot after each step that changes what the",
  "page shows. If a command fails because the person took control or the Grenade app is not open, say so and ask them,",
  "rather than switching to another browser. `grenade browser --help` has the rest.",
].join("\n");
