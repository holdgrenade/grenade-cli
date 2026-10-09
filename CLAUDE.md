# grenade-cli

`grenaded` is the daemon that runs on the Mac, and on Linux (see "Linux" below; "the Mac" in this file means the computer it runs on). It owns tmux sessions that run AI coding agents, streams their screens to phones over WebSocket, accepts input, and turns Claude Code and Codex hook events into a status and an activity the phone can show. `grenade` is the CLI that talks to it. Phones on the same Wi‑Fi connect directly; anywhere else they reach it through a relay (`../grenade-relay`), end-to-end encrypted. Read `../grenade-protocol/PROTOCOL.md` first: every frame this daemon sends or accepts is defined there.

This is a public repo: no secrets, no private paths, no personal data, and no word of where the main relay is hosted, in files or commit messages.

## Stack

Node 22+ (uses `fetch`, `import.meta.dirname`; `@types/node` stays on 22 so the types match the oldest Node we support), TypeScript strict ESM, `ws`, `bonjour-service`, `commander`, Zod schemas from `@grenade/protocol` (`file:../grenade-protocol`, so build that package first). Tests: vitest. tmux ≥ 3.2 must be on PATH (`brew install tmux`; on Linux the distribution's package).

## Commands

```bash
npm install && npm run build     # → dist/, binary dist/cli.js
npm test                         # unit tests (no tmux needed)
npm run typecheck
npm run dev -- daemon            # run from source with tsx
npm link                         # `grenade` on PATH

grenade daemon [--port 7788] [--name X] [--no-advertise] [--no-summaries] [--no-relay] [--allow-plain-lan]   # foreground
grenade status | ls
grenade setup [--yes] [--no-service] [--no-relay] [--no-pair]   # the whole first run: requirements, start at login, relay, QR code (--no-hooks is accepted and does nothing)
grenade pair [--no-wait]         # QR code (pairing offer) + typed code, then waits and names the phone that paired
grenade service install [-- <daemon options>] | remove | status   # grenaded as a launchd agent (a systemd user service on Linux): starts at login, restarts when it dies
npm run release                  # release/holdgrenade-cli-<version>.tgz + packaging/homebrew/grenade.rb (nothing is published)
grenade devices                  # paired phones: id, name, platform, paired, last seen, connected now (Wi‑Fi / relay), "not encrypted"
grenade unpair <id or name>      # end one phone's pairing at once, on Wi‑Fi and relay; an ambiguous name lists the candidates
grenade unpair --all
grenade new <name> --cwd <dir> [--agent claude|codex|shell] [--with <session> | --alone]
grenade group <name> <with> [--at N]  # move <name> into <with>'s group (at position N, 1 = first); `group x x --at 1` reorders
grenade ungroup <name>           # move <name> out into a group of its own
grenade open <name>              # tmux attach; Ctrl-b d detaches
grenade kill <name>
grenade install-hooks [--print] [--remove] [--port 7788]   # optional: the hooks in ~/.claude/settings.json too, for a claude typed by hand in a Grenade shell; --remove also cleans ~/.codex/hooks.json
grenade update [--check] [--now] # install the latest release with Homebrew, npm or (Linux) the release's tarball, and restart grenaded into it
grenade update --auto on|off     # whether grenaded installs new releases by itself (on unless turned off)
grenade terminal [iterm|terminal|auto|none]   # also open every session in a Mac terminal (none, the default, unless set); no kind: what is set
grenade relay on [url] [--key K] # use a relay (default: the main relay, OFFICIAL_RELAY_URL); reloads a running daemon
grenade relay off                # forget the relay and this Mac's id there
grenade relay status             # url, relay id, online/offline, public + local IPs, phones piped through it
grenade push on [url] [--key K] [--at-mac S]   # send push notifications, also with remote access off; url = another relay's push route
grenade push auto                # the default: push while this Mac uses a relay for remote access, none otherwise
grenade push off | status | test # test sends a notification to every phone that registered
grenade publish                  # canvases published to secret links: address, state, boards, what each shows
grenade publish off <link>       # take a link down (its address or token); the page stops working at once
grenade prompt test [session] [--kind permission|question|plan|all] [--wait 120]   # a test card on the phone; prints what it answered
grenade talk "<words>"           # typed Talk: says the words as a `talk.say`, prints the rows that follow until the turn ends
grenade talk log                 # today's Talk thread (also `grenade talk` with no words)
grenade talk agent [claude|codex] # which agent answers typed Talk; with one, choose it
grenade --control-port 7790 <cmd>                          # talk to a daemon on another control port
```

Env: `GRENADE_HOME` (default `~/.grenade`) holds `tokens.json`, `pairing-pause.json` (the count of wrong pairing tries and the running pause, mode 0600), `sessions.json`, `groups.json` (the order groups are listed in), `daemon-id`, `daemon.log`, `relay.json`, `e2e-key`, `push.json` (push on or off, and the route), `push-devices.json` (the phones' push registrations, mode 0600), `push-boards.json` (the phones' Mac boards, mode 0600), `terminal.json` (which terminal sessions open in, `grenade terminal`), `published.json` (canvases published to secret links, each with its key, mode 0600), `talk/` (typed Talk: `YYYY-MM-DD.jsonl` per day, mode 0600 in a 0700 folder, and `work/`, the folder its agent runs in), `talk.json` (which agent answers typed Talk, and the day's agent conversation) and `attachments/`. `GRENADE_SHARE_URL` points publishing at another share host (a local `wrangler dev` of `grenade-website/workers/share`, `http://localhost:8787`). `GRENADE_LOG=debug` for verbose logs (iTerm tabs, Bonjour, hooks, ignored input to ended sessions). Info is for things a person cares about: start/stop, phones pairing and connecting, sessions started and ended. `NO_COLOR` turns off color. `TMUX_BIN` overrides the tmux path. `CLAUDE_BIN` overrides the claude path used for summaries and typed Talk, `CODEX_BIN` the codex path typed Talk runs; `GRENADE_SUMMARIES=off` turns summaries off. `GRENADE_DEVICE_IDLE_DAYS` is how long a phone may stay unseen before it is unpaired (default 90, 0 never).

## Install and release

Two ways in, one tarball: `brew install holdgrenade/tap/grenade` or `npm install -g @holdgrenade/cli`, then `grenade setup`; the command is `grenade` either way. On Linux, `curl -fsSL https://www.holdgrenade.com/install.sh | sh` (`docs/linux.md`). The tap (`holdgrenade/homebrew-tap`, `../homebrew-tap`) installs the asset of the GitHub release `v<version>` of this repo, and npm has the same file as `@holdgrenade/cli` (the npm org `holdgrenade`; plain `grenade` is taken there). Never edit the formula in the tap: `npm run release` writes it here.

**Every push to `main` is a release, and CI bumps the version:** don't bump `version` by hand for a patch. The released version always has a section in `CHANGELOG.md`: the `bump` job writes it from the commits since the previous tag (`release-notes.mjs` in `holdgrenade/.github`: Claude's notes for its readers, or the plain subjects when it has no key; in the same bot commit, also for a version a commit set by hand), unless a section for that version was written by hand, and the GitHub release's notes are that section. Write the section yourself when the subjects don't say enough; the model reads your commit subjects and bodies, so say in them what changed for a reader. `.github/workflows/release.yml` first runs its `bump` job: when the pushed version is tagged already, it commits the next patch to `main` (a commit named just the version, by github-actions), and the jobs after it build that commit. A commit that sets a new version itself (a minor or major) ships that number. So `main` on GitHub is one commit ahead of yours after every push: pull before you commit again (`git pull --rebase origin main` replays your unpushed commits on top of it). Then the workflow does the rest: tests, `npm run release`, tag `v<version>`, the GitHub release with `release/holdgrenade-cli-<version>.tgz`, then the formula committed to the tap with the sha256 of the tarball downloaded back from that release (`scripts/formula-from-tarball.mjs`), so the tap always matches what brew fetches, even on a rerun. **Homebrew is the release; npm is best effort:** `npm publish` is the last step and cannot fail the run (npm is not usable for now, so `@holdgrenade/cli` stays at 0.1.0; when it is, trusted publishing for it — GitHub Actions, this repo, `release.yml` — makes the step work with no token and no second factor). A rerun of a run whose version is not tagged yet releases that version without a new bump; a rerun after its tag, or `gh workflow run release.yml`, bumps again. The npm step publishes a version from its GitHub release whenever npm lacks it; every release step skips what an earlier run did, so a rerun is safe. The workflow needs two repository secrets, each a fine-grained personal access token that reaches one repo: `GH_GRENADE_PROTOCOL_TOKEN` reads `grenade-protocol`, `GH_HOMEBREW_TAP_TOKEN` writes `homebrew-tap` (GitHub refuses secret names that start with `GITHUB_`). The same steps still work by hand, in that order; check `gh run list --workflow release.yml` before doing any of it by hand.

`grenade-protocol` is a private repo, so nobody outside can build this one from the source; the release tarball has the protocol inside.

## Ports and names

- WebSocket and HTTP on `7788`, all interfaces; the control API on `127.0.0.1:7789`, for the CLI only (`--control-port` for another). An HTTP route on `:7788` that only this computer should call checks for loopback.
- Bonjour service type `_grenade._tcp` (`dns-sd -R` on a Mac, `avahi-publish` on Linux).
- tmux sessions owned by Grenade are named `gr-<slug>`.
- State in `GRENADE_HOME` (default `~/.grenade`), listed under "Env" above.
- Push notifications go sealed to `POST /v1/push` on a relay; only the main relay holds the APNs key, and a self-hosted relay passes pushes on to it (`docs/push.md`).

## Read before you touch it

Each subsystem is written up in `docs/`. Read the one for the code you change, and keep it true in the same commit.

| Working on | Read |
| --- | --- |
| Adding, moving or finding a file in `src/` | `docs/layout.md` |
| Groups: membership, order, names, group order | `docs/groups.md` |
| Linux: systemd service, tmux scope, avahi, ufw, the tarball install | `docs/linux.md` |
| Terminal mirror (iTerm2, Terminal.app), width floor, live terminal, attachments | `docs/terminal.md` |
| Status, models, prompts, summaries, activity, conversations, usage | `docs/status-and-activity.md` |
| Push notifications, the Mac board | `docs/push.md` |
| Voice providers and keys, typed Talk | `docs/talk-and-voice.md` |
| Canvas, publishing to secret links, comments | `docs/canvas-and-publishing.md` |
| Network changes, pairing and encryption, the relay | `docs/connections.md` |
| First run (`grenade setup`, service, pairing), updates | `docs/setup-and-updates.md` |
| Smoke runs against a real daemon, relay, pairing, the release, push | `docs/testing.md` |

## How a session works

1. `registry.create()` expands a leading `~` in `cwd` (`expandCwd` in `parse.ts`) and refuses a folder that is not a directory with `BadCwdError` (sent to the phone as `bad_frame`), because tmux silently falls back to `$HOME` for a missing `-c`. Then it runs `tmux new-session -d -s gr-<slug> -c <cwd> -e GRENADE_SESSION=gr-<slug> -x 120 -y 40`, sets its options and `respawn-pane -k` starts `<claude|codex|$SHELL>`, all in one tmux command. Claude Code and Codex start with Grenade's hooks for the daemon's port (`agentCommand` with `AgentFlags`: `claude --settings '<JSON>'`, `codex -c 'hooks.<Event>=[…]' … --no-alt-screen`), so no agent's settings are ever written for a session to report. Codex runs inline (`--no-alt-screen`, also after `fork`), like Claude Code: on its alternate screen it left tmux no scrollback (`history_size` 0), so neither the `history` frames nor the phone's live terminal could scroll back, and a drag on the phone selected instead; the flag changes no hook, so Codex does not ask to trust them again. As for the rest, a `claude` typed by hand in a shell session has hooks only if `install-hooks` put them in `~/.claude/settings.json`. Every command after `new-session` names its target (`-t =gr-<slug>:`), and tmux runs without `TMUX` and `TMUX_PANE` (`tmuxEnv`): a daemon started by hand inside a tmux pane inherits `TMUX_PANE`, and an untargeted `respawn-pane -k` would restart that pane with the agent, killing whatever ran there, and leave the new session a bare shell.
2. The poller captures the visible pane (`capture-pane -p -e` + `display-message` for cursor/size, one tmux command). Never add `-S` to pull scrollback into the frame: Claude Code repaints its transcript in place on each width change and every earlier paint stays in tmux history, so the rows above the pane repeat what the pane shows and the phone drew them twice. Older rows go out only on a `history` request. `registry.updateScreen()` hashes the joined lines and emits a `screen` frame only when it changed, with `seq` incremented. `lastLine` is the last non-empty line.
3. `Connection` forwards `screen` frames only for sessions the client subscribed to, and every `session.updated` / `session.removed`.
4. Input: `send-keys -l -- <text>` then `send-keys Enter` when `submit` is true; text with a line break, and any text for a Codex session, goes in as one bracketed paste (`inputCommand`). Codex takes fast typing followed by Enter for a paste (its "paste burst") and turns that Enter into a newline, so a typed one-line prompt sat in its box unsent until Enter was pressed again; a paste says what it is and the Enter after it sends. After a paste, Enter waits until the pane has changed and then held still (`waitForSettle`, about 0.35 s, 2 s at most): Claude Code reads a picture path in pasted text (a Chrome `<picked-element>`'s `screenshot:`, an attachment) into an `[Image #n]` in the background, and an Enter sent straight after the paste was lost while it did, leaving the prompt in its box unsent (reproduced with a 330 KB screenshot: every prompt left unsent without the wait, none with it). Named keys map in `parse.ts`.
5. Size: sessions start at 120×40, then the phone sends `resize` with the columns its view fits and the daemon runs `resize-window -x <cols>`. That puts the window in manual size, so it stays phone-width while the phone watches. The agent gets SIGWINCH and redraws at the new width, and the next capture reports it. A client gives the width back with `resize` `cols: null` (the Mac app, leaving terminal mode): `registry.releaseSize` runs `resize-window -A` so the window fits the attached iTerm tab again, but only for the connection that sized it last (`sizedBy`), so it never undoes a phone's width. When the last subscriber leaves (unsubscribe or socket close), `registry.unsubscribe` does the same whoever sized it. While the phone holds a narrow width, the Mac terminal shows the area outside the window blank, because sessions set `fill-character` to a space (tmux's default is dots); adopted sessions get it from `applySessionOptions`.
6. A restarted daemon calls `registry.adopt()`: every live `gr-*` tmux session is picked up, metadata from `sessions.json`.

tmux target syntax matters: `=id` is an exact session match (has-session, kill-session); pane commands need `=id:` (capture-pane, send-keys, display-message). Plain `id` prefix-matches and can hit the wrong session.

## Linux

grenaded runs on Linux as a systemd user service (started for Omarchy, Arch x86_64), from the same tarball. The daemon says which system it runs on (`os` in its `daemon` object), which only chooses the word the apps use: "Mac" or "computer". What differs, and what is missing (holding a push while someone is at the computer), is in `docs/linux.md`. Two rules: the tmux server is started through `systemd-run --user --scope`, never any other way, or stopping the service kills every agent; and the installer's steps exist twice, in `grenade-website/public/install.sh` and `src/update/tarballInstall.ts`: change both.

## Invariants

- Never block the event loop on tmux: every tmux call is `execFile` with a 3 s timeout. Poll ticks skip if the previous one is still running.
- The daemon never reads a frame it did not validate: every inbound message goes through `parseClientFrame`; every outbound frame is typed `DaemonFrame`.
- The control API binds to `127.0.0.1` only. The WebSocket requires the encryption handshake, then a paired token before anything else, and closes after 5 s without a first frame or without `hello`. Its upgrade is refused to a web page (`fromWebPage` on the Origin, as on every HTTP route), and it takes messages up to `WS_MAX_MESSAGE_BYTES` (4 MiB, the relay's cap; a sealed 2 MiB attachment is about 3.75 MB).
- `GRENADE_HOME` is 0700 (`ensureDir` closes one an older version made), attachments 0700/0600, the log 0600, and `tokens.json` is written to a temp file and renamed in, never in place. A tmux error never carries tmux's command line (`tmuxFailure`): it holds the typed text, and the error is logged and sent to the phone.
- A token never crosses a network in the clear: `hello` and `pair` are only accepted on a sealed connection (unless `--allow-plain-lan`). Never log a token, a pairing code or a pairing secret; log the device `id`.
- Nothing readable crosses the relay: every frame after the handshake goes through `SealedChannel`. The relay gets access hashes, never tokens. Never add a feature that needs the relay to read a frame.
- A device token, a board's push token, a push key and a pairing token never reach a log line: a phone is named by its device id (`p_…`). `test/pusher.test.ts` checks it.
- A voice provider's API key and the tokens made with it never reach a log line, a frame (a key goes out masked only) or the control API. A key leaves this computer in one place, `mintToken`, to its own provider over HTTPS.
- Pure modules (`pushPolicy.ts`, `boardPolicy.ts`, `pushContent.ts`, `pushSeal.ts`, `status.ts`, `parse.ts`, `installHooks.ts`, `modelLabel.ts`, `claudeModelPicker.ts`, `modelChoice.ts`, `screenDialog.ts`, `codexDialogs.ts`, `claudeDialogs.ts`, `canvasAccess.ts`, `boardListing.ts`, `claudeStatusLine.ts`, `codexUsage.ts`, `voiceKey.ts`, the provider files (`openai.ts`, `gemini.ts`), `talkRouter.ts`, `talkFeed.ts`, `talkGuard.ts` (randomness only in `newTurn`'s defaults), `talkSessions.ts`, `talkProjects.ts`, `talkPrompt.ts`, `talkAgents.ts`, `talkToolDefs.ts`, `agentReady.ts`, `summaryPrompt.ts`, `summaryTiming.ts`, `PairingCodes`, `e2e.ts`, `access.ts`, `localIps.ts`) take no I/O and no clock; inject `now`.
- The canvas is read, never written: `src/canvas/` opens nothing for writing and makes no folder.
- Files in `GRENADE_HOME` are the only things written to disk (`relay.json`, `e2e-key`, `voice-keys.json`, `talk.json` and the day files in `talk/` with mode 0600, uploads under `attachments/`), plus `~/.claude/settings.json` (`$CLAUDE_CONFIG_DIR/settings.json` when that is set) on `install-hooks` (and a refresh of Grenade's own entries in `setup`), which merge and never clobber, `~/.codex/hooks.json` when CLI 1.0.23's entries are taken out, and `~/Library/LaunchAgents/com.adamchew.grenade.daemon.plist` (on Linux `~/.config/systemd/user/grenade.service`) on `service install`. On Linux a deleted conversation moves into `~/.local/share/Trash`.

## Adding a frame

1. Define it in `../grenade-protocol` (PROTOCOL.md, `src/index.ts`, a fixture), rebuild that package (`npm run build` there, then `npm install` here to refresh the link).
2. Handle it in `Connection.dispatch` (client frame) or emit it from the registry (daemon frame).
3. `wsHandler.test.ts` will fail until the new client fixture dispatches without `bad_frame`.

## Testing

`npm test` is hermetic (no tmux, temp dirs; `daemon.test.ts` runs the whole daemon over loopback sockets on free ports). Smoke runs against a real daemon, a relay, pairing, the release and push are in `docs/testing.md`.

Never test against the daemon on 7788/7789 while someone is using it from a phone, and never restart it on new code without thinking about the phones paired with it. Give a test daemon its own `GRENADE_HOME`, ports and tmux socket (`TMUX_TMPDIR`), and before driving it through a control port check it is yours (`GET /status` → `id` equals `$GRENADE_HOME/daemon-id`).

## Known gaps

- Screens are plain text (no ANSI colors); `capture-pane -e` would need an ANSI renderer on the phone.
- `-J` joins wrapped lines, so the cursor row is approximate when long lines wrap.
- The socket on the Wi‑Fi is still `ws://`; the frames in it are end-to-end encrypted. Sizes and timing are visible on the network, and `GET /health` and Bonjour tell anyone on it the Mac's name, id, version and public key.
- `tokens.json` holds the tokens themselves (mode 0600). Storing only their hashes would stop a copy of the file from acting as a phone; whoever can read the file can read `e2e-key` beside it too, so it would not change who can get in.
- A typed code pairs on the same Wi‑Fi only. Away from it a phone pairs with the QR code, which needs the relay to be on.
- A daemon passes its own port in the hooks it starts agents with, so a daemon on other ports needs nothing for them; `grenade setup` installs the launchd agent without daemon options (`service install -- --port …` by hand).
- Codex status is heuristic until its hooks are trusted in Codex (and for a Codex older than 0.160, which has no hooks).
