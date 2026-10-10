# Changelog

What changed in each version of Grenade's CLI and daemon (`@holdgrenade/cli`), newest first. Every push to `main` is a release: CI's `bump` job (`.github/workflows/release.yml`) writes the released version's section from the commit subjects since the previous tag, and that section is the GitHub release's notes. A section written here by hand for the version being released is kept as it is, so write one when the commit subjects don't say enough.

## 1.0.87 (2026-10-10)

- On a Mac, Claude Code sessions started by Grenade now open and test web pages in the Grenade app's browser tab, so you can watch them work. They ask you before switching to another browser, including when you have taken control or the app is closed. Sessions that were already running, Codex sessions, and `claude` you start by hand keep their previous behavior.

## 1.0.86 (2026-10-10)

- Agents in a Grenade session can now drive a browser tab with `grenade browser`: `open <url>`, `screenshot`, `eval <script>`, and `release`. The tab lives in the Mac app's toolbox and needs the Mac app running on this computer.
- Screenshots are saved to a file and the path is printed, so the agent can open or reference the image.
- The browser tab belongs to its session and sits in that session's group. It appears dimmed under "Take control," so you can take it over at any time.

## 1.0.85 (2026-10-10)

- Captions and highlighted words under a picture no longer show Markdown marks like bold stars, code ticks, or list bullets. The words themselves stay.

## 1.0.84 (2026-10-10)

- Highlights no longer show a picture the agent read as two tiles. Each screenshot an agent reads now appears once. Screenshots taken by a browser tool still appear as before.

## 1.0.83 (2026-10-10)

- Small fixes and improvements.

## 1.0.82 (2026-10-10)

- Long design turns in highlights now show the newest boards, up to eighteen, instead of the oldest ones.
- In a long design turn's spoken highlight, the choices are trimmed to the first and last two, so the closing sentence and the main ask, approach, and result are no longer cut off.

## 1.0.81 (2026-10-10)

- Finished turns in Talk now collect their highlights: the boards saved on the group's canvases during the turn, screenshots and pictures the agent read or was shown, pictures you sent, and any push it sent. They appear on the turn's row about twenty seconds after it finishes.
- Each highlight gets a caption taken from existing text: the board's title, the agent's nearest sentence, your prompt, or the push's message.

## 1.0.80 (2026-10-09)

- The showreel changes from earlier work are backed out. `grenade clip` no longer keeps what an agent recorded, and the daemon no longer cuts a daily reel.
- The day's showreel no longer opens with a sentence about what shipped, written from the titles.
- `grenade showreel render` has been removed, so the day's reel is no longer cut into an MP4 in Movies.

## 1.0.79 (2026-10-09)

- Showreels now open with a one-sentence summary of what shipped that day, shown on the opening card. Without an AI model, the card reads like "Shipped today: A, B and C." Re-cutting a reel without the model keeps the earlier summary sentence and still updates the piece titles.

## 1.0.78 (2026-10-09)

- Agents can now save a short recording of a feature in use with `grenade clip <file> --title …`, optionally with `--line` and `--before`. Clips are kept by day under ~/.grenade/clips.
- Each clip is re-encoded to a 720p MP4 of at most 15 seconds, using ffmpeg or the Mac's avconvert. Pictures are copied as they are.
- The daemon cuts a showreel from each day's clips, with one piece per feature, the before shown beside its clip, and the push that closed it.
- Once a day's clips stop changing, a small AI model (Haiku) gives each showreel piece a title and a bucket.
- `grenade showreel hour` sets the end-of-day hour, when the daemon writes that day's showreel.
- The daemon now answers requ

## 1.0.77 (2026-10-09)

- On a Mac, `grenade setup` now has a fourth step, "The Mac app," which offers to install the Mac app if it isn't already in your Applications folder. Pairing is now step five. Setup on Linux still has four steps.
- The offered install is the same download the website links to. Before the app is copied into place and opened, grenade checks it against its published SHA-256 and confirms it is signed with a Developer ID and notarized by Apple.
- Pass `--no-app` to `grenade setup` to skip the Mac app step.
- New `grenade app` command shows where the Mac app is installed. `grenade app install` installs it on request.

## 1.0.76 (2026-10-09)

- Each session now shows a git summary: how many files have changed and how many commits haven't been pushed yet. It refreshes when the session starts, after the agent's hooks run, and every 10 seconds.
- From the app, phone, or Chrome, you can list a session's changed files and commits and view the diff for any file.
- You can push a session's branch from the app. Pushes never force-push.
- Every push, whether from the app, the agent, or a terminal, adds a push card to the session's activity.
- A rejected or failed push shows the reason on its card.

## 1.0.75 (2026-10-09)

- Small fixes and improvements.

## 1.0.74 (2026-10-09)

- Small fixes and improvements.

## 1.0.73 (2026-10-09)

- Small fixes and improvements.

## 1.0.72 (2026-10-09)

- Small fixes and improvements.

## 1.0.71 (2026-10-09)

- Web pages can no longer open a connection to the daemon to use up its pairing attempts, and messages up to 4 MiB are now accepted, matching the relay's limit.
- The Grenade data folder is now private to your user. An existing folder is locked down on upgrade, and attachments and the log are readable only by you.
- Saving the paired-device list is safer: it's written to a temporary file and then swapped in, so an interrupted write won't leave it damaged.
- tmux errors in the log now show tmux's own message instead of the full command, so text you type is no longer written to the log.

## 1.0.70 (2026-10-09)

- The daemon's control API now accepts requests only from Grenade's own Chrome extension, not from any Chrome extension.
- The control API now refuses requests addressed to any name other than localhost, 127.0.0.1, or [::1]. This stops a web page from reading the daemon's replies by pointing its own domain name at your computer.

## 1.0.69 (2026-10-09)

- Small fixes and improvements.

## 1.0.68 (2026-10-08)

- Small fixes and improvements.

## 1.0.67 (2026-10-08)

- Fixed a false error card in Activity: when the model's reply merely mentions things like "rate limits" or "API error", it now shows as a normal reply instead of an error.

## 1.0.66 (2026-10-08)

- The daemon now accepts local requests only from the Grenade Chrome extension or from tools that send no browser origin. Requests from regular web pages are refused, including ones that arrive with a blank origin.

## 1.0.65 (2026-10-08)

- Comments left on your published links now sync to your computer. Checks run every 15 seconds while someone is viewing the link, and every 2 minutes otherwise.
- Synced comments are kept on your computer, and the app remembers which ones you have read.
- You can reply to comments on a published link and mark them resolved.
- Published links now show "Shared by" with your name. It starts as your account's full name and is stored on your computer.

## 1.0.63 (2026-10-08)

- When you approve a plan with a note, the note is now passed to the agent after the plan, so it reaches the agent along with the approval.

## 1.0.62 (2026-10-08)

- Claude Code sessions can now be switched into plan mode remotely, so Claude plans its changes before editing files.

## 1.0.61 (2026-10-08)

- You can now publish a session's plan to a secret link, and the link updates every time the plan is saved.
- Prompts pasted with a picture path in them now send reliably. Before, Enter could be lost while Claude Code was loading the picture, leaving the prompt sitting in its input box. Grenade now waits up to 2 seconds for the pane to settle before sending Enter.

## 1.0.60 (2026-10-08)

- Plans can now be followed and edited from your phone, the Mac app, or Chrome. While an agent is writing its plan, the plan is locked. When you approve, the agent builds the plan as it currently stands, including your edits, and it is told once when you have changed the plan.
- The Chrome extension now pairs with the daemon as Chrome, so it shows up as its own kind of device.
- The local control API and pairing no longer accept requests from web pages open in a browser.

## 1.0.59 (2026-10-07)

- Files dropped together at once now each save successfully. Before, two files with the same name could collide, and one would fail.
- When an attachment upload fails, the error now includes the ID of that upload, so you can tell which one failed.

## 1.0.58 (2026-10-07)

- Removed the Wispr Flow voice provider, since its API has closed. `grenade voice` now lists only OpenAI and Gemini.
- A saved Wispr Flow key is removed from your voice keys file the next time the daemon reads it.

## 1.0.57 (2026-10-07)

- Prompts pasted into Claude Code with line breaks now appear in the activity right away, instead of showing up late or not at all.
- Prompts sent while Claude Code is mid-turn now appear once, right away, even when several are queued. They no longer show up twice. The feed's working row shows them the same way.

## 1.0.56 (2026-10-06)

- Pairing now pauses after repeated wrong codes. Every fifth wrong try while a code is live locks pairing for 1 minute, then 10 minutes, then an hour, then 24 hours.
- While pairing is paused, no new code is generated, and each attempt is rejected with a "too many attempts" error that shows when the pause ends.
- The pause is saved to disk, so it still applies after the daemon restarts.

## 1.0.55 (2026-10-06)

- A group can now hold several canvases. The `canvases` command lists them, each named after its first board's title.
- Canvas frames are now served by group and canvas, so each canvas in a group can be opened on its own.
- A published link can be pointed at a canvas that has moved to another group, and it keeps its original address.

## 1.0.54 (2026-10-06)

- The Talk thread now shows a feed with a row for every session that has activity: working, needs you, or finished.
- Working rows show the prompt for that turn, except for turns you started from Talk.
- Needs you rows say what the open question or permission card is asking.
- Finished rows show how the agent's reply began once the turn ends.
- The feed is built from each session's own hooks and output, so it adds no model cost.
- A row that would repeat a session's last status is skipped, so the thread stays quiet.
- Talk's daily summary now includes only the newest feed row for each session.
- Restarting the daemon no longer adds a finished row for a turn it didn't see start.

## 1.0.53 (2026-10-06)

- Fixed a canvas that failed to publish when its session was started inside the project's `.grenade/canvas` folder. The Mac app now publishes the canvas instead of getting a "No session on this Mac works in…" error from the daemon.

## 1.0.52 (2026-10-05)

- Added typed Talk: type a message to talk with Claude Code or Codex running on this computer, and get answers back in text.
- Talk keeps one day's conversation at a time, saved in your Grenade folder, and answers one message at a time.
- Your message is sent only to a session Talk has matched to it for that turn. It never goes to a plain shell, to a session waiting for an answer, or to one showing a dialog.
- When Talk isn't sure which session you mean, it asks you which one to use instead of guessing.
- Sessions that need you or have finished are reported as they happen, following the same notification rules as before.

## 1.0.51 (2026-10-05)

- Publish a group's canvas to a secret link with `grenade publish`, and stop sharing it with `grenade publish off <link>`.
- The published page stays up to date as you save boards, so the link shows your latest work.
- You can publish either just the newest revision or all revisions, and the files the boards refer to are included.
- Each update only sends the files that changed. If an update fails, it retries after about a minute.
- The keys for your published links are kept only on your computer, readable by your user account alone.
- Set `GRENADE_SHARE_URL` to publish to a different share host.

## 1.0.50 (2026-10-05)

- Sessions now show how much of their context window is in use, for both Claude Code and Codex.
- Grenade adds a status line to Claude Code's settings so it can read context and plan limits. Your own status line still runs unchanged.
- On Claude Pro and Max, Grenade shows your five-hour and weekly usage windows. Codex reports the same kinds of limits.
- Limits lists every window that has not yet reset.

## 1.0.49 (2026-10-04)

- Added design canvas support: the daemon can now show a group's design boards in the apps, reading boards from the session's folder or the folder a group shares.
- Canvas access is read-only and stays inside the project folder. Boards can't reach files outside it, and nothing is written.
- Subscribed canvases refresh about every 0.4 seconds and update when a board is added, saved, or removed.
- Boards over 2 MiB, or too large to send through the relay, are refused with a short message explaining why.
- The daemon now reports canvas support in its status.

## 1.0.48 (2026-10-04)

- Small fixes and improvements.

## 1.0.47 (2026-10-04)

- When you switch models from the Grenade app while Claude Code is running, the "Switch model?" prompt is now answered automatically. You no longer see a stray prompt card or an error, and on iPhone the model sheet closes instead of staying open behind the card.

## 1.0.46 (2026-10-04)

- The daemon's agent list now shows which agents this computer can run, whether each one is signed in as the agent itself reports, and the commands to install and sign in to any that are missing. This helps the Mac app guide you through setup on first run.

## 1.0.45 (2026-10-04)

- The README now explains how to store your Talk and dictation API keys with `grenade voice key <provider>`, remove them with `grenade voice forget <provider>`, and see the `grenade voice` command. It covers where the key is kept, how apps get a short-lived pass instead of the key, and which app versions use this.

## 1.0.44 (2026-10-04)

- When Claude Code asks "Switch model?" after you change models in a conversation that already has messages, the question now appears in the app as Switch or Don't switch. Before, you could only answer it in the terminal.
- The same question also appears when you change models with /model in the terminal.
- If a model change from an app hits this question, the app shows the question and an error saying it is waiting in the session. Choosing Switch completes the change.

## 1.0.43 (2026-10-04)

- Voice provider API keys for Talk and dictation can now be stored on this computer, with grenaded holding them. Apps get a short-lived token each time they connect to the provider, and the audio still goes directly to the provider, not through the daemon.
- New `grenade voice` command lists the voice providers and shows whether each has a key, with the key masked.
- New `grenade voice key <provider>` prompts for a key without showing it (or reads it from stdin), checks it with the provider, and saves it locally with owner-only file permissions.
- New `grenade voice forget <provider>` removes a stored voice key.

## 1.0.42 (2026-10-03)

- You can now switch the model and effort level of a running Claude Code session from Grenade. The change applies only to that session, so the default in Claude Code's settings stays the same.
- The daemon now lists the models available for each agent, and each session shows its current effort level along with its model.

## 1.0.41 (2026-10-03)

- Renamed groups now keep their name. The name is saved with the sessions in the group, so it stays after a restart. A session that joins the group picks up the name, and a session that leaves it loses the name.

## 1.0.40 (2026-10-03)

- The daemon now reports whether it runs on macOS or Linux, so the apps label a Linux computer as a computer instead of a Mac.

## 1.0.39 (2026-10-03)

- Small fixes and improvements.

## 1.0.38 (2026-10-03)

- `brew info grenade` now links to the Grenade website, https://www.holdgrenade.com, as the project homepage, matching the npm package. The download still comes from this project's releases.

## 1.0.37 (2026-10-03)

- On Linux, `grenade update` and the background daemon now update installs made with the website's install script. They download the new release tarball, verify its checksum, and swap it in.
- On Linux, `grenade update` checks the latest version against the Homebrew tap, the same source Homebrew installs use.
- On Linux, the commands, logs, errors shown on your phone, and push notification text say "computer" where they used to say "Mac."
- On Linux, `grenade push status` reports that no push is held, since there isn't one to hold there.

## 1.0.36 (2026-10-03)

- Fixed shell sessions on Linux when the `SHELL` environment variable is not set. They now start your login shell instead of `/bin/zsh`, which most Linux systems don't have. Before, the session ended right away and took the tmux server with it. If the login shell can't be found, sessions fall back to `/bin/sh`.

## 1.0.35 (2026-10-03)

- Added Linux support for the daemon: `grenade service` installs grenaded as a systemd user service there (launchd on a Mac), and the daemon can restart itself into a new version under either.
- `grenade setup` now accepts Linux and can install tmux through pacman, apt-get or dnf.
- Under systemd, tmux runs in its own scope, so stopping or restarting the service no longer ends running agents.
- On Linux, discovery registers through avahi, as macOS does with dns-sd. Without avahi-daemon, the JavaScript stack handles discovery instead.

## 1.0.34 (2026-10-03)

- Small fixes and improvements.

## 1.0.33 (2026-10-03)

- Push notifications now include the session's title, so you can tell which session a notification is about at a glance.

## 1.0.32 (2026-10-03)

- Claude Code sessions stay marked as working while a background command, subagent, or workflow from the turn is still running. The session lists those tasks and shows as done only after they finish. Stopping a task in Claude Code's task view also ends the wait.
- Codex sessions behave the same way for background terminals shown on their screen.
- A session that has finished no longer switches back to working when a tool runs inside a subagent, so it no longer looks like a turn stopped partway.

## 1.0.31 (2026-10-03)

- Sessions no longer open a new iTerm2 tab or Terminal window by default, so they no longer clutter your screen beside the Mac app or phone. To get the terminal tabs back, run `grenade terminal iterm`, `grenade terminal terminal`, or `grenade terminal auto`. Use `grenade terminal none` to turn them off again.
- The terminal choice is read at every session event, so changes apply without restarting the daemon. Tabs for sessions already running are opened when you change the setting.
- `--terminal` and the `GRENADE_TERMINAL` environment variable still override the saved setting.

## 1.0.30 (2026-10-03)

- Your phone's Live Activity now stays current with your Mac's board, so you can see what your agents are doing without opening the app.
- Board updates to your phone are batched and rate-limited: a change is sent after a short pause, and no more than one update reaches a phone every 5 seconds.
- Your phone alerts you only when a new question appears while nobody is at the Mac.
- The Live Activity ends on its own after 15 minutes with no activity.
- Each paired phone gets its own board.

## 1.0.29 (2026-10-02)

- Codex sessions now scroll back on your phone. Previously a drag selected text instead of scrolling up through Codex's output. Codex also doesn't ask you to trust its hooks again after this update.

## 1.0.28 (2026-10-02)

- Codex conversations now appear in the conversation list alongside Claude Code ones, sorted newest first.
- You can resume a Codex conversation from Grenade, which continues it as a fork of the original.
- The preview of a resumed Codex conversation shows the original's earlier lines, not only what came after the fork.
- Newer apps see both Codex and Claude Code conversations. Older apps still show only Claude Code conversations.

## 1.0.27 (2026-10-02)

- Prompts sent to Codex sessions now go through, instead of sitting unsent in the input box until you press Enter on the computer.

## 1.0.26 (2026-10-02)

- Small fixes and improvements.

## 1.0.25 (2026-10-02)

- Codex startup prompts such as "Hooks need review" and "Trust this folder?" now appear as cards on your phone. Tap Trust or Skip there and Grenade answers the prompt for you.
- A Codex session that is waiting on one of these prompts now shows an "asks" status, so you can tell it needs your input.
- Spotting these prompts is best-effort until Codex's hooks run, so a dialog may occasionally not show up as a card.

## 1.0.24 (2026-10-02)

- Sessions now report their activity without any changes to your Claude Code or Codex settings files. Grenade passes its hooks when it starts each agent.
- Setup no longer writes hooks. It now has four steps instead of five.
- Setup updates Grenade hooks already in your Claude Code settings, so they run once after upgrading.
- Setup removes the Grenade hook entries that version 1.0.23 added to your Codex hooks file.
- A prompt that reports twice now shows as one entry in the activity list.

## 1.0.23 (2026-10-02)

- Codex sessions now show live activity and status. Grenade reads what Codex is doing and shows the model it's running, and a session returns to idle when you interrupt Codex.
- `grenade setup` and `grenade install-hooks` now add Grenade's hooks to your Codex configuration on machines where Codex is installed, so you don't need to set them up by hand.

## 1.0.22 (2026-10-02)

- Small fixes and improvements.

## 1.0.21 (2026-10-02)

- Stopped sessions now reach older apps as finished instead of stopped. Mac 1.0.46 and 1.0.47 were released without support for the stopped state and would drop a stopped session, so they now see it as done. iPhone 1.0.26 and Mac 1.0.50 and later receive the stopped state as before.

## 1.0.20 (2026-10-02)

- A Claude Code turn that stops partway, either from an error or because its screen has been quiet with no spinner for 30 seconds, now shows as stopped instead of working forever.
- A stopped session stays marked stopped until you look at it, and sends a push notification saying it needs you.
- Running `setup` or `install-hooks` now also installs the hook that catches turns stopped by an error.
- Older apps that don't know about the stopped state show these sessions as done.

## 1.0.19 (2026-10-02)

- Sessions no longer shrink below 60 columns when every attached Mac terminal is narrower, such as a tab split into small panes in iTerm. Agent output stays readable on your phone instead of wrapping into a narrow column. Once any attached terminal is 60 columns or wider, the session follows the terminals again.

## 1.0.18 (2026-10-02)

- Each session now gets a short title. It uses the title Claude Code gives the session, and if Claude Code doesn't provide one, Grenade uses its own summary instead.

## 1.0.17 (2026-10-02)

- Your phone, Mac app, or Chrome can now list the folders inside a path on your computer, so you can browse to the folder you want when starting a new session.

## 1.0.16 (2026-10-02)

- Live terminal: a session's terminal now streams to your phone, Mac app, or Chrome as it runs. Opening it shows the existing scrollback and the current screen with the cursor in place, then keeps updating as the session writes output. Keys typed on a client go straight to the session.

## 1.0.15 (2026-10-02)

- You can now delete a past conversation. It moves to the macOS Trash, so you can restore it from there.
- Deleting is refused for a conversation that a Grenade session or another terminal still has open. Close it first, then delete.

## 1.0.14 (2026-10-02)

- Small fixes and improvements.

## 1.0.13 (2026-10-02)

- You can now list the Claude Code conversations saved on your computer from your phone, preview any one of them, and resume it. Resuming starts a copy of the conversation, so the original is never changed.
- Archiving a past conversation hides it in Grenade only. The conversation itself stays on your computer.
- A resumed conversation shows its history right away, before your first new prompt. Once the copy's transcript appears, the activity switches over to it in one update.
- Sessions that hit an error now show an error card in their activity right away.
- The control API has a new `POST /activity/test` endpoint. It adds a test error entry to a named session, or the first live session if you don't name one, so you can see the error card without causing a real failure.

## 1.0.12 (2026-10-02)

- A client can now give back the width it set for a session and stay connected. The session returns to automatic sizing, and a client never undoes a width set by another client.

## 1.0.11 (2026-10-01)

- Fixed sessions stuck as "working" when a prompt was cancelled before Claude wrote anything. They now go idle and show as stopped, and pressing Esc at an idle prompt no longer opens Rewind by mistake.

## 1.0.10 (2026-10-01)

- Stopping Claude Code from the phone or the Mac now ends the turn. The session goes idle and the activity log shows a stopped entry. This also works when you interrupt Claude Code directly with Esc or Ctrl-C. Older apps won't show the stopped entry.

## 1.0.9 (2026-10-01)

- Small fixes and improvements.

## 1.0.8 (2026-10-01)

- The Mac app's Restart button now restarts into a ready update right away, instead of waiting for every session to go idle.
- A restart request is refused with a "busy" response while a session is working or waiting for your answer. Send `force: true` in the request to restart anyway.
- A daemon you started by hand can't be restarted this way and gets a "cannot restart" response. Restart it yourself.

## 1.0.7 (2026-10-01)

- `grenade status` and the update notice now tell you to restart the daemon when it was started by hand and a newer version is installed. Before, they suggested it would switch over once no session was working, but a hand-started daemon keeps running the old version until you restart it. The Mac app shows the same information.

## 1.0.6 (2026-10-01)

- grenaded now installs new Grenade releases on its own, using the same package manager you installed it with (Homebrew or npm). It restarts into the new version once no session is busy.
- You can turn automatic installs off with `grenade update --auto off`, or by pinning Grenade in Homebrew with `brew pin grenade`.
- The Mac app's Update button now starts the install right away instead of only showing that a newer version exists.
- If an npm install folder needs sudo, grenaded reports that instead of trying the install, so you can update it yourself.
- If an automatic install fails, grenaded tries again after an hour.

## 1.0.5 (2026-10-01)

- Prompts sent from the phone or the Mac app are now confirmed once they reach the agent's terminal. If a prompt fails to send, you get an error for that specific prompt.
- If the connection drops and a prompt is sent again, the agent receives it only once. The daemon remembers recently sent prompts for 10 minutes, across reconnects.

## 1.0.4 (2026-10-01)

- iTerm2 is now optional. Sessions open in Terminal.app windows by default, and setup no longer offers to install iTerm2.
- If you want sessions in iTerm2 instead, setup's closing lines point you to the iTerm2 section of the docs.

## 1.0.3 (2026-10-01)

- Multi-line text sent to an agent now arrives as one block, so line breaks no longer submit each line on its own.

## 1.0.2 (2026-10-01)

- New sessions now always start their agent. Before, starting the daemon by hand from inside a tmux pane could restart that pane, killing whatever was running there, and leave the new session as a bare shell. The daemon no longer touches the tmux pane it was launched from.

## 1.0.1 (2026-10-01)

- The main relay is now https://relay.holdgrenade.com.

## 1.0.0 (2026-10-01)

- Small fixes and improvements.

## 0.1.13 (2026-10-01)

- Group order is now kept by the daemon, so every connected phone, Mac app, and Chrome window shows the same order.
- Your group order is saved to disk, so it persists across daemon restarts.
- New groups appear at the top of the list.
- Moving a session to another group leaves it right under the group it came from.
- Empty groups are removed automatically.

## 0.1.12 (2026-10-01)

- After a daemon restart, activity for existing sessions now shows up right away on your phone, instead of staying empty until each session's next event.

## 0.1.11 (2026-10-01)

- Small fixes and improvements.

## 0.1.10 (2026-09-30)

- The daemon now accepts connections from the Grenade Mac app, so you can use the Mac app with your agents.

## 0.1.9 (2026-09-30)

- The iPhone app now uses the bundle ID com.holdgrenade.grenade, so it installs as a separate app from the old com.adamchew.grenade build. Push notifications follow the new ID. The Mac daemon's launchd label is unchanged.

## 0.1.8 (2026-09-30)

- Fixed a bug where a prompt you sent could appear twice in the activity on your phone. Each prompt now shows once.

## 0.1.7 (2026-09-30)

- Agent sessions now get an iTerm2 tab as soon as iTerm2 is installed, even if grenaded was already running. Before, you had to restart grenaded after installing iTerm2 before any tab would open. With the default `--terminal auto`, grenaded checks for iTerm2 on each event and catches up on live sessions.
- `grenade setup` offers to install iTerm2 with Homebrew (`brew install --cask iterm2`). You can decline. Setup also ends by saying where your agent will appear and what the macOS Automation permission prompt is for.
- The README now explains iTerm2 tabs, groups, and the first-time permission prompt.

## 0.1.6 (2026-09-30)

- Small fixes and improvements.

## 0.1.5 (2026-09-30)

- Fixed Homebrew installs getting stuck on an older version when the npm publish step failed. Homebrew updates now go out on their own, and the npm package is published afterward on a best-effort basis, so an npm failure no longer holds back Homebrew users.

## 0.1.4 (2026-09-30)

- Typing `cd` with the `!` prefix now moves the session's folder as well. Grenade follows the change at the end of that turn instead of waiting for your next prompt.

## 0.1.3 (2026-09-30)

- The folder shown in a session's header now follows the agent when Claude Code changes directory, instead of staying at the folder where the session started.

## 0.1.2 (2026-09-30)

- Fixed replies sometimes not appearing in the activity until your next prompt. If Claude Code's Stop hook ran before the reply was written to the transcript, the reply now shows up on its own shortly after.

## 0.1.1 (2026-09-30)

- Claude Code sessions now carry their activity to the phone: the user's prompts and the agent's own replies, last 200 sentences per session. Tool calls and command output are left out. A phone that opens a session gets the recent history, then new messages as they arrive, and a prompt shows immediately before its transcript copy replaces it.
- The phone can now get push notifications when an agent needs an answer or has finished. A session that starts waiting sends one notification. Pushes are held while someone is using the Mac (input in the last 2 minutes, screen unlocked) and are dropped if the session stops waiting before they go out.
- New `grenade push` command with `on`, `off`, `auto`, `status`, and `test`. The default, `auto`, sends pushes only while this Mac is connected through a relay.
- New `grenade prompt test [session]` puts a test permission, question, plan, or all three on the phone, waits for an answer, and prints what was chosen.
- `grenade pair` now labels its two options "Option 1" (QR code) and "Option 2" (typed code), matching the names on the phone's pairing screen.
- Install with `brew install holdgrenade/tap/grenade`. The README also covers installing from the release tarball without Homebrew.
- The npm package is now `@holdgrenade/cli`. Nothing was published under the earlier name, so there is nothing to migrate from.
- Ignored files: `.env` files, key files, coverage reports, and tarballs are now excluded from git.

## 0.1.0 (2026-09-29)

- Agent sessions now run in tmux, can be grouped, and open in their own iTerm tab, with scrollback and attachments.
- Each session can get a one-sentence summary, and you can choose which model it answers with.
- Session status now comes from Claude Code hook events, and it shows why a session is waiting for you.
- Remote access works through a relay, and the local network connection is end-to-end encrypted too. Plain, unencrypted connections are refused.
- Pair a phone or Mac with a typed code or a QR code.
- Use `grenade devices` to list paired devices and `grenade unpair` to remove one.
