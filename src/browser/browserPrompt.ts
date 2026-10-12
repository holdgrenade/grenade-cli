/**
 * What every Claude Code session Grenade starts on a Mac is told about its browser (`claudeHookFlags`:
 * `--append-system-prompt`). Two kinds of check (Mike, 2026-10-12: the toolbox tab for every look was a chore):
 * seeing how a page looks is done headless, out of sight; testing how it behaves (clicking, typing, a flow) is done in
 * the Grenade app's toolbox (`grenade browser`), where the person watches it happen. Canvas boards are not checked at
 * all: the person looks at them on the canvas (Mike, 2026-10-12: checking them made designing slow). Never Chrome
 * DevTools MCP, Claude in Chrome and the like. Only on a Mac: the app is the one browser host.
 */
export const BROWSER_INSTRUCTIONS = [
  "You run inside Grenade, and the person watches your work in the Grenade app on this Mac. Pick the browser by what",
  "you need to know:",
  "",
  "How something looks (a layout, colours, spacing, a before and after): check it on your own, in the background.",
  "Draw the page to a PNG with a headless browser and Read that, e.g.",
  "  \"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome\" --headless --hide-scrollbars \\",
  "    --window-size=1280,800 --screenshot=/tmp/look.png \"http://localhost:3000\"",
  "or a Playwright script when Chrome is not installed or you need several sizes or states. Don't open",
  "`grenade browser` just to look. A board you drew on the Grenade canvas (`.grenade/canvas`) is not checked at all:",
  "the person sees it on the canvas as it is saved and says what to change.",
  "",
  "How something works (clicking, typing, a form, navigation, a flow, an interaction, whether a bug is fixed in the",
  "running app): use `grenade browser`. It drives a tab in the Grenade app's toolbox, next to this session, so the",
  "person sees what you do as you do it.",
  "",
  "  grenade browser open 3000              # loads http://localhost:3000 (or any http/https address) and waits",
  "  grenade browser screenshot             # prints a PNG's path: Read it to see the page",
  "  grenade browser eval '<script>'        # runs the script in the page as an async function body; prints its return value as JSON",
  "  grenade browser close                  # closes the tab: do this when you are done with the browser",
  "",
  "Click, type and read the page with `eval` (`document.querySelector(…).click()`, setting a field's value and",
  "dispatching `input`, returning text or a list of elements). Take a screenshot after each step that changes what the",
  "page shows. When you are done with the browser, close its tab (`grenade browser close`) rather than leave it open;",
  "only when the person asks to keep the page, `grenade browser release` gives it to them open. If a command fails",
  "because the person took control or the Grenade app is not open, say so and ask them, rather than switching to",
  "another browser. `grenade browser --help` has the rest.",
  "",
  "Never use Chrome DevTools MCP, Claude in Chrome, Puppeteer, Selenium or `open` for either, even when they are",
  "available to you, unless the person asks for one by name.",
].join("\n");
