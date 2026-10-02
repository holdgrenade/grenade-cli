# grenade-cli

`grenaded` is the daemon that runs on the Mac. It owns tmux sessions that run AI coding agents, streams their screens to phones over WebSocket, accepts input, and turns Claude Code hook events into a status the phone can show. `grenade` is the CLI that talks to it. Phones on the same Wi‑Fi connect directly; anywhere else they reach it through a relay (`../grenade-relay`), end-to-end encrypted. Read `../grenade-protocol/PROTOCOL.md` first: every frame this daemon sends or accepts is defined there.

## Stack

Node 22+ (uses `fetch`, `import.meta.dirname`; `@types/node` stays on 22 so the types match the oldest Node we support), TypeScript strict ESM, `ws`, `bonjour-service`, `commander`, Zod schemas from `@grenade/protocol` (`file:../grenade-protocol`, so build that package first). Tests: vitest. tmux ≥ 3.2 must be on PATH (`brew install tmux`).

## Commands

```bash
npm install && npm run build     # → dist/, binary dist/cli.js
npm test                         # unit tests (no tmux needed)
npm run typecheck
npm run dev -- daemon            # run from source with tsx
npm link                         # `grenade` on PATH

grenade daemon [--port 7788] [--name X] [--no-advertise] [--no-summaries] [--no-relay] [--allow-plain-lan]   # foreground
grenade status | ls
grenade setup [--yes] [--no-hooks] [--no-service] [--no-relay] [--no-pair]   # the whole first run: requirements, hooks, start at login, relay, QR code
grenade pair [--no-wait]         # QR code (pairing offer) + typed code, then waits and names the phone that paired
grenade service install [-- <daemon options>] | remove | status   # grenaded as a launchd agent: starts at login, restarts when it dies
npm run release                  # release/holdgrenade-cli-<version>.tgz + packaging/homebrew/grenade.rb (nothing is published)
grenade devices                  # paired phones: id, name, platform, paired, last seen, connected now (Wi‑Fi / relay), "not encrypted"
grenade unpair <id or name>      # end one phone's pairing at once, on Wi‑Fi and relay; an ambiguous name lists the candidates
grenade unpair --all
grenade new <name> --cwd <dir> [--agent claude|codex|shell] [--with <session> | --alone]
grenade group <name> <with> [--at N]  # move <name> into <with>'s group (at position N, 1 = first); `group x x --at 1` reorders
grenade ungroup <name>           # move <name> out into a group of its own
grenade open <name>              # tmux attach; Ctrl-b d detaches
grenade kill <name>
grenade install-hooks [--print] [--remove] [--port 7788]   # edits ~/.claude/settings.json
grenade update [--check] [--now] # install the latest release with Homebrew or npm and restart grenaded into it
grenade update --auto on|off     # whether grenaded installs new releases by itself (on unless turned off)
grenade relay on [url] [--key K] # use a relay (default: the main relay, OFFICIAL_RELAY_URL); reloads a running daemon
grenade relay off                # forget the relay and this Mac's id there
grenade relay status             # url, relay id, online/offline, public + local IPs, phones piped through it
grenade push on [url] [--key K] [--at-mac S]   # send push notifications, also with remote access off; url = another relay's push route
grenade push auto                # the default: push while this Mac uses a relay for remote access, none otherwise
grenade push off | status | test # test sends a notification to every phone that registered
grenade prompt test [session] [--kind permission|question|plan|all] [--wait 120]   # a test card on the phone; prints what it answered
grenade --control-port 7790 <cmd>                          # talk to a daemon on another control port
```

Env: `GRENADE_HOME` (default `~/.grenade`) holds `tokens.json`, `sessions.json`, `groups.json` (the order groups are listed in), `daemon-id`, `daemon.log`, `relay.json`, `e2e-key`, `push.json` (push on or off, and the route), `push-devices.json` (the phones' push registrations, mode 0600) and `attachments/`. `GRENADE_LOG=debug` for verbose logs (iTerm tabs, Bonjour, hooks, ignored input to ended sessions). Info is for things a person cares about: start/stop, phones pairing and connecting, sessions started and ended. `NO_COLOR` turns off color. `TMUX_BIN` overrides the tmux path. `CLAUDE_BIN` overrides the claude path used for summaries; `GRENADE_SUMMARIES=off` turns summaries off. `GRENADE_DEVICE_IDLE_DAYS` is how long a phone may stay unseen before it is unpaired (default 90, 0 never).

## Layout

```
src/cli.ts                 commander CLI; every command except `daemon` and `open` goes through the control API
src/cli/controlClient.ts   `controlClient(port)`: one call to the control API; `DaemonNotRunningError`
src/cli/pairCommand.ts     `grenade pair`: prints `pairScreen`, then polls GET /pair-code until a phone paired or the code ran out
src/cli/serviceCommand.ts  `grenade service …`; `startService` (refuses while a hand-started daemon holds the ports, waits for the daemon to answer); pure `serviceLines`
src/cli/setupCommand.ts    `grenade setup`: five steps, each skipped when already done; asks before hooks and relay (no answer without a terminal, unless --yes)
src/pairing/offer.ts       pure: the pairing offer for this daemon (`offerFor`, `offerUrlFor`), PROTOCOL.md "Pairing offer (QR code)"
src/pairing/qrText.ts      pure: a URL as a QR code of half-block characters (`uqr`), forced white on black when it may use color
src/pairing/pairScreen.ts  pure: what `grenade pair` prints, "Option 1" (the QR code) and "Option 2" (the typed code), the names the phone's pairing screen uses; leaves the QR code out of a window it does not fit
src/pairing/pairingWatch.ts pure: what became of the last pair code (none, waiting, paired with which phone over which route, expired)
src/service/launchdPlist.ts pure: label, plist path, `renderPlist`, `servicePath` (the PATH the agent runs with), `stableProgram` (no versioned Cellar path)
src/service/launchctlOutput.ts pure: reads `launchctl print` (loaded, running, pid, last exit)
src/service/launchd.ts     installs, removes and inspects the agent: writes the plist, `launchctl bootstrap` / `bootout` / `print` in `gui/<uid>`
src/setup/requirements.ts  pure: what is missing (macOS, Node 22+, tmux 3.2+, an agent; iTerm2 is never asked for) and the command that fixes it; `findRequirements.ts` looks
src/setup/hooksNotice.ts   pure: `addedHooks(before, after)` and the text shown before `~/.claude/settings.json` is touched
src/setup/nextSteps.ts     pure: what setup ends on once the phone is paired: how to start an agent, that it opens in an iTerm2 tab or a Terminal window (and where the docs say how to use iTerm2)
src/setup/pushNotice.ts    pure: what setup says about push notifications (they follow remote access; to which relay the Mac posts them; how to turn them on alone)
src/setup/answer.ts, ask.ts pure `readYesNo`; `askYesNo` on the terminal
src/config.ts              paths under GRENADE_HOME, daemon id, default name, VERSION
src/log.ts                 leveled logger → stderr (local time, color on a TTY) + daemon.log (ISO time); plain sentences + `key=value`, `formatLine` is pure; `silentLogger` for tests
src/frames.ts              narrowed frame types (ScreenFrame) derived from the protocol unions
src/daemon/server.ts       startDaemon(): HTTP (/pair, /hooks/claude, /health) + WS (/ws) on :7788, control on 127.0.0.1:7789, the relay link; `makeConnection(out, close, {route, sealed})` builds the same Connection for a LAN socket and a relay pipe; ends pairings (`devices`, `closeConnectionsOf`) and unpairs idle phones hourly
src/daemon/wsHandler.ts    Connection: one per socket; hello/auth (refuses a plain `hello`), subscriptions, `unpair`, dispatch to registry (and `attachment` to the store); an `input` with an `id` is answered `input.sent`, or `error` with the `id`. Transport-agnostic.
src/daemon/sentInputs.ts   SentInputs: the `input` ids already typed (the last 1000, for 10 minutes), shared by every connection, so a prompt a phone sends again after a dropped connection is typed once (PROTOCOL.md "Sending prompts")
src/daemon/lanSocket.ts    LanSocket: one WebSocket from the Wi‑Fi; its first frame decides: the E2E handshake → `SealedPipe`, anything else → a plain Connection. No `ws` import
src/daemon/connections.ts  LiveConnections: the connections that said hello, by token; what `grenade devices` shows as connected and what an unpair closes
src/daemon/devices.ts      pure: `Device` (a paired phone without its token), `matchDevice` (id, name, unique prefix; never guesses), `ago`
src/daemon/pairCheck.ts    pure: the 4 check digits of a typed pairing code (`pairCheck`, `typedCode`, `spacedCode`)
src/daemon/loopback.ts     pure: `isLoopback(address)`, for routes only this Mac may call
src/daemon/control.ts      loopback JSON API for the CLI and the Mac app (status incl. `relayLink` and `update`, sessions CRUD, pair-code, devices: list and unpair, POST /relay/reload, GET /update, POST /update/check and /update/install)
src/daemon/pairing.ts      PairingCodes (pure: a 6-digit code and the 22-character secret of the pairing offer, minted together, 2 min, 5 tries shared, using one voids both; `liveSecret`, `onChange`) + TokenStore (grt_ tokens, tokens.json; each record has a device `id`, `lastSeen`, `sealed`; `revoke`, `revokeAll`, `revokeIdle`; onChange fires when the set of tokens changes)
src/relay/relayConfig.ts   relay.json {url, key?, id, secret}: load/save/remove; pure normalizeRelayUrl, relayWsUrl, relayConfigFor, applyRelayInfo
src/relay/e2eKey.ts        the daemon's long-term X25519 key (e2e-key, 0600), made on first start
src/relay/e2e.ts           pure crypto: daemonAccept / phoneStart handshake, SealedChannel (ChaCha20-Poly1305, counter nonces)
src/relay/access.ts        pure: accessKey / accessHash of a pairing token (what the relay checks, never the token)
src/relay/localIps.ts      pure: the Mac's IPv4 addresses from os.networkInterfaces()
src/relay/sealedPipe.ts    SealedPipe: one encrypted connection from a phone, whatever carries it; handshake, then open → Connection → seal. Text in, text out
src/relay/phonePipe.ts     PhonePipe: one relay conn; a SealedPipe whose text travels in the relay's `data` frames
src/relay/relayLink.ts     RelayLink: WebSocket to <relay>/v1/daemon; register, update, ping/pong, backoff, routes conns to pipes
src/daemon/hooks.ts        POST /hooks/claude?session=… → registry.applyHook; a UserPromptSubmit prompt goes to the Summarizer and the ActivityStore; transcript_path → registry.setTranscript (saved), registry.setModel and the TranscriptReader (activity and `setCwd`)
src/daemon/discovery.ts    Bonjour _grenade._tcp with TXT v/id/name; `dns-sd -R` (system mDNSResponder) on macOS so the address follows Wi‑Fi changes, bonjour-service elsewhere
src/daemon/http.ts         readBody / sendJson
src/attachments/attachmentName.ts  pure: the on-disk name of an upload (UTC stamp, sanitized name, extension from the mime type)
src/attachments/attachmentStore.ts createAttachmentStore(dir): writes <dir>/<sessionId>/<name>, never overwrites (-2, -3…)
src/tmux/tmux.ts           createTmux(): execFile wrapper (list, has, new, capture, sendText, sendKey, resize, releaseSize, kill)
src/tmux/parse.ts          pure: parse tmux output, buildScreen, slugify, key map, input command (types one line, pastes several), agent command
src/sessions/registry.ts   SessionRegistry: Session objects, status machine driver, screen cache, persistence, events
src/terminal/mirror.ts     TerminalMirror: one tab or window per live session in the chosen terminal (`auto | iterm | terminal | none`), `relayoutSteps` pure
src/terminal/iterm.ts      ITermAdapter: iTerm2 tabs and split panes (AppleScript via osascript), tagged with `user.grenadeSession`
src/terminal/appleTerminal.ts AppleTerminalAdapter: one Terminal.app window per session, the default without iTerm2
src/sessions/status.ts     pure status reducer (see below)
src/sessions/groups.ts     pure group rules: default group for a folder, joinable groups, group order (byGroupOrder, nextOrder, placeAt)
src/sessions/groupOrder.ts pure: the order groups are listed in (reconcileGroupOrder: new on top, newest first, gone dropped; placeUnder; moveGroup)
src/sessions/groupOrderStore.ts GroupOrderStore: that order for every client, follows the registry's `updated`/`removed`, `move` for `group.move`, event `changed` (a `groups` frame), groups.json
src/sessions/poller.ts     timers: 200 ms capture of subscribed sessions, 1 s sweep of all sessions
src/summary/summaryPrompt.ts  pure: model instructions, input (prompts + screen tail), cleanSummary of the reply
src/summary/summaryTiming.ts  pure: summaryDelay (wanted delay vs. one run per minute)
src/summary/claudeCli.ts   resolveClaudeBin + runClaudeSummary: `claude -p --model haiku`, stdin in, reply out
src/summary/summarizer.ts  Summarizer: listens to the registry, schedules runs, calls registry.setSummary
src/transcript/modelLabel.ts  pure: lastModelIn (model id of the last assistant reply in transcript JSONL), modelLabel ("claude-opus-5-5" → "Opus 5.5")
src/transcript/readModel.ts   readTranscriptModel: reads the last 256 KB of a transcript, returns the label
src/activity/transcriptReader.ts  TranscriptReader: reads a transcript from where it left off, whole lines only, one read at a time per file; the protocol's `activityEntriesIn` and `workingDirectoryIn` say what the lines mean
src/activity/catchUp.ts           CatchUp: reads a transcript again at growing delays after a `Stop` that showed no reply yet, until it does (`start`, `cancel`, `stop`)
src/activity/activityStore.ts     ActivityStore: the last 200 entries per session; `append` (from the transcript), `noteAsked` (a hook's prompt, shown at once; the transcript's copy of it is not sent again, and when the transcript puts it elsewhere the next frame is `full`), `forget`; event `activity` carries new entries as a frame
src/hooks/installHooks.ts  pure merge/remove of Grenade hooks into a Claude settings object: seven command hooks that report status, and the `PermissionRequest` HTTP hook (`promptHook`) that Claude Code holds open
src/daemon/promptHook.ts   POST /hooks/claude/prompt: `openPromptFromHook` (pure but for the store) and the HTTP wrapper that holds the response; `closePromptsByHook` for hooks that reach /hooks/claude
src/prompts/promptStore.ts PromptStore: the prompts Claude Code is showing, each with the callback that answers its held request; `open`, `answer`, `dropped`, `closeByHook`, `closeSession`; events `opened`, `closed`, `answered`
src/prompts/promptText.ts  pure: one line that says what a prompt asks, for its push
src/prompts/promptTests.ts PromptTests: test cards (`grenade prompt test`); `testPayload(kind)` is a payload as Claude Code sends it, `start` opens it in the store with nothing behind it, `result` resolves with the reply the phone's answer became
src/cli/promptCommand.ts   `grenade prompt test`; src/cli/promptAnswer.ts (pure) reads the answer off the hook reply, in words
src/push/pusher.ts         Pusher: listens to the registry, keeps pending pushes, seals one per registered phone and posts it; `register`/`unregister` for a Connection
src/push/pushPolicy.ts     pure: is a change an event (startedWaiting), wait / hold / send / drop (decide), how long a session was busy (trackBusy), worthPushing
src/push/pushContent.ts    pure: what a push says (pushContentFor, pushText, clip)
src/push/pushSeal.ts       pure crypto: sealPush (X25519 + HKDF + ChaCha20-Poly1305, one key per push), collapseId
src/push/macPresence.ts    is someone at the Mac: pure parsers for `ioreg` (idle time, screen lock) + readMacPresence
src/push/pushGateway.ts    postPush: one HTTPS POST to <relay>/v1/push; outcomeOf (pure) maps the answer to sent / unregistered / retry / refused
src/push/pushConfig.ts     push.json {enabled?, url?, key?, atMacSeconds?}: load/save; pure pushMode (on / off / auto), pushGatewayFor, pushConfigOn, atMacMs
src/push/pushDevices.ts    PushDevices: push-devices.json (0600), one registration per paired phone, keyed by device id; prune
src/push/startPush.ts      startPush(): builds the Pusher from the files and the daemon's registry, tokens and key
src/cli/pushCommand.ts     `grenade push on | off | status | test`; statusLines and testLine are pure
src/cli/updateCommand.ts   `grenade update` (`--check`, `--now`, `--auto on|off`): installs with the installer of this copy, then restarts the agent
src/update/versions.ts     pure: compare versions, the latest from the tap's formula or npm's answer, `installerFor` (absolute brew/npm paths from the command's real path), `InstallState`, notice and status lines
src/update/updateChecker.ts UpdateChecker: asks for the latest every 6 h, installs it itself (auto) or on `installNow`, retries a failure after 1 h, restarts into a newer version on disk once nothing is busy
src/update/installer.ts    runInstall: runs brew or npm asynchronously with a time limit; `pinned`, `needsAdmin`; installError (pure) puts a failure in a few words
src/update/autoSetting.ts  ~/.grenade/update.json `{ "auto": false }` turns automatic installs off; read at every check
src/update/installedVersion.ts, underLaunchd.ts  the version on disk behind the command; whether this is the launchd agent
scripts/smoke.mjs          end-to-end check against a running daemon (needs tmux)
scripts/push-smoke.mjs     acts as a phone that registers for pushes, then asks for a test push; refuses to run against a daemon that pushes through the main relay
scripts/relay-smoke.mjs    acts as a phone through a relay: presence, E2E handshake, sealed hello → welcome
scripts/pair-smoke.mjs     acts as a phone that scanned the QR code: reads the offer, pairs with its secret on this Mac or `--via relay`, says hello
scripts/release.mjs        `npm run release`: bundles CLI, daemon, protocol and libraries into one file (esbuild), packs the tarball, writes the formula
packaging/homebrew/        formula.mjs (the template, pure) and grenade.rb (generated; goes into the tap as Formula/grenade.rb)
scripts/formula-from-tarball.mjs  writes packaging/homebrew/grenade.rb from a tarball already on the GitHub release (its sha256), what the workflow puts in the tap
.github/workflows/release.yml  on every push to main: tests; if `version` is not in the tap yet, `npm run release`, tag, GitHub release, the formula from the released tarball to the tap, then npm (best effort)
test/                      vitest; wsHandler.test.ts replays every ../grenade-protocol/fixtures/client.*.json
```

## How a session works

1. `registry.create()` expands a leading `~` in `cwd` (`expandCwd` in `parse.ts`) and refuses a folder that is not a directory with `BadCwdError` (sent to the phone as `bad_frame`), because tmux silently falls back to `$HOME` for a missing `-c`. Then it runs `tmux new-session -d -s gr-<slug> -c <cwd> -e GRENADE_SESSION=gr-<slug> -x 120 -y 40`, sets its options and `respawn-pane -k` starts `<claude|codex|$SHELL>`, all in one tmux command. Every command after `new-session` names its target (`-t =gr-<slug>:`), and tmux runs without `TMUX` and `TMUX_PANE` (`tmuxEnv`): a daemon started by hand inside a tmux pane inherits `TMUX_PANE`, and an untargeted `respawn-pane -k` would restart that pane with the agent, killing whatever ran there, and leave the new session a bare shell.
2. The poller captures the visible pane (`capture-pane -p -e` + `display-message` for cursor/size, one tmux command). Never add `-S` to pull scrollback into the frame: Claude Code repaints its transcript in place on each width change and every earlier paint stays in tmux history, so the rows above the pane repeat what the pane shows and the phone drew them twice. Older rows go out only on a `history` request. `registry.updateScreen()` hashes the joined lines and emits a `screen` frame only when it changed, with `seq` incremented. `lastLine` is the last non-empty line.
3. `Connection` forwards `screen` frames only for sessions the client subscribed to, and every `session.updated` / `session.removed`.
4. Input: `send-keys -l -- <text>` then `send-keys Enter` when `submit` is true. Named keys map in `parse.ts`.
5. Size: sessions start at 120×40, then the phone sends `resize` with the columns its view fits and the daemon runs `resize-window -x <cols>`. That puts the window in manual size, so it stays phone-width while the phone watches. The agent gets SIGWINCH and redraws at the new width, and the next capture reports it. When the last subscriber leaves (unsubscribe or socket close), `registry.unsubscribe` runs `resize-window -A` (`releaseSize`) so the window fits the attached iTerm tab again. While the phone holds a narrow width, the Mac terminal shows the area outside the window blank, because sessions set `fill-character` to a space (tmux's default is dots); adopted sessions get it from `applySessionOptions`.
6. A restarted daemon calls `registry.adopt()`: every live `gr-*` tmux session is picked up, metadata from `sessions.json`.

tmux target syntax matters: `=id` is an exact session match (has-session, kill-session); pane commands need `=id:` (capture-pane, send-keys, display-message). Plain `id` prefix-matches and can hit the wrong session.

## Groups

Sessions that belong together share an opaque `group` id (`g-` + 6 hex). A group only changes how sessions are shown; each member is still its own tmux session with its own status, screen and size. Putting agents in panes of one tmux session would break per-session capture and phone-width `resize`, so do not.

- `registry.create()` takes an optional `group` (must have another live member, else `UnknownGroupError` → `bad_frame`). Without it the session joins the oldest live session in the same `cwd`, else gets a new id.
- Members have an `order` (position in the group, lowest first; gaps allowed). A new or adopted session without one goes last (`nextOrder`). Always sort with `byGroupOrder` (order, then oldest, then id), never by `createdAt` alone.
- `registry.setGroup(id, group | null, index?)`: `null` moves it into a new group of its own at order 0 (no-op if it is already alone). A group plus `index` places it there (clamped; default last) and renumbers the whole group 0..n-1; its own group plus `index` is a reorder. Emits `updated` for every member whose group or order changed, then one `regrouped(session, from)` (the mirror listens to that; `from === session.group` means a reorder).
- Groups and order are saved in `sessions.json`. On `adopt()`, sessions saved before groups existed are grouped by folder, oldest first.
- Control API: `PUT /sessions/:id/group {group, index?}`. The CLI's `--with`/`group` look up the other session's group first.
- The order the groups themselves are listed in (PROTOCOL.md "Group order") is the daemon's too, so a group moved on the phone moves in the Mac app and on every other phone. `GroupOrderStore` keeps it: a group that appears goes to the top, a session moved out lands right under the group it left (it remembers each session's last group to tell), a group with no session left is dropped, and without a saved order the groups are listed newest first. Saved in `groups.json` beside `sessions.json` (none when sessions are in memory only). `Connection` sends `groups` after `sessions` on `hello` and forwards every `changed`; `group.move` answers with `groups` to everyone, or to the sender alone when nothing moved.

## Terminal mirror (`src/terminal/mirror.ts`)

Every live session gets a tab or window running `tmux attach-session -t =<id>`, so all agents are visible on the Mac at once. iTerm2 is optional: without it each session opens in a Terminal.app window of its own (`appleTerminal.ts`; groups do not split there and nothing moves on a regroup). With it (`iterm.ts`) a group is one tab of split panes, as below.

- Panes of a group run left to right in group order. `split vertically` puts the new pane to the right, so a pane always splits the member before it.
- `created` → open a tab in the current iTerm window (a window is made if none), or, when another member of its group already has a pane, split the nearest earlier member's pane (`splitPaneScript`; falls back to a tab if the pane was closed by hand).
- `regrouped` → moved out: close its pane, open it as a tab. Moved in last: close its pane, split the group's last pane. Moved in elsewhere, or reordered: `relayoutSteps` (pure) closes the group's panes and splits them again in order, keeping the first pane (and so the tab's place) when that member stays first. iTerm's AppleScript cannot move a pane, so reordering is always close-and-reopen; the tmux sessions are untouched. `removed` (kill) → tmux ends the agent first, then the tab is closed. `updated` with status `gone` → the tab is closed.
- On daemon start, tabs are opened for adopted sessions that have none, in group order so each group's first session gets the tab; existing tabs are found by their tag, never by title (tmux rewrites titles).
- Tabs are tagged with the iTerm session variable `user.grenadeSession = <id>`. The AppleScript builders are pure and tested; `ITermMirror` runs one `osascript` at a time through a queue, and a failed script never blocks the next.
- The tab runs the absolute tmux path (`resolveTmuxBin`) because an iTerm command session has no shell profile. With iTerm's default profile the tab also closes by itself when the attach exits, so the close script often reports 0 closed; that is fine.
- Default `auto`: iTerm2 tabs whenever iTerm2 is installed, else Terminal.app windows (`/Applications/iTerm.app` or `~/Applications/iTerm.app`), and `isITermInstalled` is asked again at every event, so iTerm2 installed after the daemon started (a fresh Mac, `grenade setup` first) needs no restart: at the next event the mirror catches up once (`catchUp`: lists the tagged tabs, opens one for every live session without) and goes on as usual. A catch-up that fails (iTerm not allowed to be controlled, say) is tried again at the next event. `--terminal iterm` insists, `--terminal terminal` keeps Terminal.app, `--terminal none` or `GRENADE_TERMINAL=none` turns it off. Detaching a tab with Ctrl-b d leaves the session running; closing a tab by hand does too. Only `grenade kill` ends an agent.

## Attachments (`src/attachments/`)

A phone hands the agent a screenshot with an `attachment` frame (PROTOCOL.md "Attachments"): the bytes come base64 inside the frame, so the same E2E channel carries them through a relay. `Connection` checks the session exists, decodes, refuses more than `ATTACHMENT_MAX_BYTES` (2 MiB, `bad_frame`), and `AttachmentStore.save` writes `~/.grenade/attachments/<sessionId>/<yyyyMMdd-HHmmss>-<name>` (`--attachments` is not an option; tests pass `attachmentsDir`). The reply `attachment.saved` carries the absolute path and the phone puts it into its next `input` prompt; the agent reads the file by path. The daemon never deletes attachments.

## How status is derived (`src/sessions/status.ts`)

Pure reducer over events `{hook, output, seen, gone}`; the registry feeds it timestamps.

- New session starts `working`.
- Heuristic (any agent until a hook speaks): screen changed → `working`; no change for 1.5 s while `working` → `waiting`.
- Hooks (Claude Code, via `grenade install-hooks`): `UserPromptSubmit`/`PreToolUse`/`PostToolUse` → `working`, `Stop` → `waiting`, `SessionEnd` → `idle`. A `Notification` → `waiting` only when its `notification_type` says the agent is blocked (`permission_prompt`, `elicitation_dialog`, …; `waitingForClaudeHook` in the protocol); `idle_prompt` and the rest change nothing, because they arrive a minute after the agent stopped and used to raise a session the user had already seen. `PermissionRequest` → `waiting` too. Once a hook has been seen (`hookDriven`), screen changes no longer move status.
- Why it waits: the reducer keeps `waitingFor` (`answer` for a question or permission prompt, `done` for a finished turn or a stable screen) and the Session shows it only while `waiting` (`shownWaitingFor`). A new reason on a waiting session counts from now and emits `updated`. The reason survives `idle` as "what the user has seen": a hook that repeats it (the `Notification` that follows a `PermissionRequest`) leaves the session `idle`. `working` forgets it.
- `seen` (client is looking): `waiting` → `idle`. `waiting` for 10 min → `idle`.
- tmux session missing on the 1 s sweep → `gone`, terminal. The cached screen stays servable.

Model: every applied hook with a `transcript_path` makes the daemon read the tail of that transcript and set the session's `model` to the label of the last assistant reply (`<synthetic>` replies are skipped). It changes after a `/model` switch once the next reply lands, is saved in `sessions.json`, and is absent for Codex and shell sessions. A failed read is logged at debug and leaves the old model.

Folder: a session's `cwd` follows the agent. Neither the hook payload's `cwd` nor tmux's `pane_current_path` moves when Claude Code's shell runs `cd` (both stay at the process's folder), but Claude Code stamps every line it writes to the transcript with its shell's `cwd`, so the same transcript read that feeds the activity applies `workingDirectoryIn` (protocol) and calls `registry.setCwd`, which persists it and emits `updated`. A `cd` by the Bash tool shows with the next hook; a `cd` typed as a `!` command shows at the `Stop` of that turn (the `environment` line Claude Code writes for a change comes only with the next prompt, which is why the stamp is read, not that line). Codex and shell sessions keep the folder they started in.

Only sessions launched by Grenade have `GRENADE_SESSION` in their environment; hook posts without `?session=` are answered 202 and ignored.

## Prompts (`src/prompts/`, `src/daemon/promptHook.ts`)

Read PROTOCOL.md "Prompt hook" and "Prompts" first. A phone can answer a permission request, a question (`AskUserQuestion`) and a plan (`ExitPlanMode`) with one tap.

- Claude Code runs its `PermissionRequest` hook the moment it shows one of those, and shows it in the terminal at the same time. Ours is an HTTP hook to `POST /hooks/claude/prompt` that stays open for up to 12 hours (`PROMPT_HOOK_TIMEOUT_S`). The first answer wins, terminal or hook.
- The route applies the event through `handleClaudeHook` like any hook (so status, `waitingFor` and push need nothing special), opens the prompt in the `PromptStore`, and keeps the response. The store emits `opened`; every `Connection` forwards it as a `prompt` frame, and a phone that says `hello` later gets the open ones after `sessions`.
- `prompt.answer` → `PromptStore.answer` → `hookReplyFor` (protocol) builds the reply, the held response is sent, `closed` with `answered` goes to every phone, and the session is set `working`.
- Answered in the terminal: a "no" or an interrupt makes Claude Code drop the request at once (`res.on("close")` → `dropped`); a "yes" leaves the request open, and the `PostToolUse` that follows closes the prompt (`closePromptsByHook`), which answers the request with an empty 200. `Stop`, `UserPromptSubmit` and `SessionEnd` close everything the session had open.
- Every answer of the route is a 200. An empty one leaves the prompt to the terminal; anything else would show up in Claude Code as a hook error. That is also what a session the daemon does not know gets, and a Claude Code that Grenade did not start.
- A question and a plan only accept an `allow` that hands `tool_input` back as `updatedInput`; a bare `allow` leaves the dialog open. `fixtures/prompt.examples.json` pins every reply, and `test/promptStore.test.ts` replays it.
- Replies never carry `updatedPermissions`: an answer from the phone counts once.
- Open prompts are in memory only. `stop()` calls `closeAll()` first, because a held request would keep the HTTP server from closing.
- `grenade prompt test` puts a test card on a session (the named one, else the first that is running) through `POST /prompts/test` on the control API and waits on `GET /prompts/test/:id`. It goes through the same store, frames and reply builder as a real prompt; only the held hook request is missing, so no agent is asked and nothing runs. It does not change the session's status and sends no push, and the hooks of the session's agent do not close it (`test` in the store), so it can sit on a session that is busy.
- To try it without touching the running daemon or `~/.claude/settings.json`: write `mergeHooks({}, 7799).settings` to a file, put a `claude` wrapper that adds `--settings <file>` first on `PATH`, point `TMUX_BIN` at a wrapper that runs `tmux -L <name>`, and start a daemon with its own `GRENADE_HOME` on other ports.

## Summaries (`src/summary/`)

Each session carries `summary`, one sentence on what it is working on, shown on the phone's list. The daemon writes it with Haiku through the `claude` CLI, so it uses the Mac's Claude Code login and needs no API key.

- Triggers: status becomes `working` (run 8 s later, so the screen shows the task), status becomes `waiting` (run now), and a `UserPromptSubmit` prompt (kept, last three per session). A pending run absorbs later triggers.
- Limits: one run per session per minute (`summaryDelay`), one run at a time overall, and no run when the model input (prompts + last 60 screen lines) hashes the same as last time. A failed run clears the hash so the next trigger retries; only the first failure in a row is a warning.
- The call is `claude -p --model haiku --tools "" --setting-sources "" --strict-mcp-config --no-session-persistence --system-prompt …`, run in the temp folder with `GRENADE_SESSION` removed. No settings means no hooks, so a summary never reports status for itself. Do not use `--bare`: it skips the keychain, so a subscription login stops working.
- A run takes about 2–6 s, and the first run after boot can take 30 s. The timeout is 60 s.
- `summary` is saved in `sessions.json` and restored on `adopt()`. Off: `--no-summaries`, `GRENADE_SUMMARIES=off`, or no `claude` found (logged once at start).

## Activity (`src/activity/`)

Read PROTOCOL.md "Activity" first. The phone's plain view of a session is what the agent said and was asked, in the words of its transcript, with no tool calls and no output.

- Source: the `transcript_path` every Claude Code hook carries. On each hook the `TranscriptReader` reads the file from where it left off (whole lines only, so a line still being written waits for the next hook) and `activityEntriesIn` from the protocol picks the lines that count; the same read gives `workingDirectoryIn` the session's current folder. The same rule pins `fixtures/transcript.examples.jsonl` to `fixtures/daemon.activity.json`, so what counts is decided in the protocol, not here.
- A `Stop` hook can run before Claude Code has written the reply to the transcript (seen in one run of three with `claude -p`), and in a turn without tool calls no later hook reads it, so the reply used to reach the phone only with the next prompt. When a Stop's read brings no `said` entry, `CatchUp` reads the transcript again after 250 ms, 500 ms, 1 s, 2 s, 3 s and 5 s until one arrives; any hook of the session, or its removal, cancels it.
- `ActivityStore` keeps the last 200 entries per session in memory only. The transcript path of each session's last hook is saved in `sessions.json` (`registry.setTranscript`, never sent to a phone), and a starting daemon reads every saved transcript from its beginning (`registry.transcripts()`), so the history is back before a phone subscribes instead of after the session's next hook. Daemon updates restart it often, and an idle session used to show the empty "Waiting for your first prompt" card until it was prompted again. A session that has had no hook since 0.1.12 has no saved path and waits for its next hook. A removed session is forgotten.
- A `UserPromptSubmit` hook's `prompt` goes into the store at once (`noteAsked`), because Claude Code writes the prompt to the transcript after the hook. When the transcript's copy arrives, the hook's entry gives way to it, so the entry sits where the transcript has it. Slash commands and text that starts with `<` are not the user talking and are skipped.
- `Connection` sends the store's entries with `full: true` when a phone subscribes to a Claude session, and forwards each new batch while it stays subscribed. Codex and shell sessions have no transcript and get no `activity` frame.

## Push notifications (`src/push/`)

Read PROTOCOL.md "Push notifications" first. The phone is told that an agent needs it or has finished while the app is suspended or not running. The Mac holds no push key: it seals each push to the phone and posts it to a relay's push route, which hands it to Apple.

- Registering: a phone sends `push.register` after every `welcome`; `Connection` passes it to `Pusher.register` with the token of its `hello`, and the answer is `push.state`. One registration per paired phone, keyed by the device id `grenade devices` shows (`deviceIdFor(token)`), kept in `push-devices.json`. It goes with `push.unregister`, when the pairing ends (`TokenStore.onChange` → `pairingsChanged` prunes), and when the route answers 410.
- Events: `Pusher` listens to the registry's `updated`. A session that starts `waiting`, or waits for something else than before, is one event (`answer` or `done`, its `waitingFor`). An agent without hooks must have been busy 30 s for its `done` to count (`worthPushing`), with pauses under 10 s counted as the same stretch (`trackBusy`), so a quick shell command does not push.
- Pending: the push waits 3 s (`PUSH_GRACE_MS`), is held while someone is at the Mac, and is dropped as soon as the session is no longer that `waiting` (`decide`). A timer ticks once a second only while something is pending.
- At the Mac: `ioreg -c IOHIDSystem` gives the time since the last keyboard or mouse input, `ioreg -n Root` the screen lock. Input within 2 minutes (`--at-mac`, 0 never holds) and not locked means at the Mac. Neither needs a permission. A reading is reused for 5 s; one that fails counts as away. The lock key was not seen on a locked screen while writing this (it needs a locked Mac); the idle time was.
- Text: for `answer` the `message` of the hook that made it wait (`noteAsked`, called from the hook route), for `done` the session's `summary`, else `lastLine`. 200 characters at most.
- Sealing: `sealPush` makes a fresh X25519 key per push and mixes in the daemon's long-term key, so only the phone can read it and only this Mac can have written it. `test/pushPure.test.ts` reproduces `fixtures/push.vectors.json`.
- Opt-in without a relay: `push.json` without `enabled` is `auto` (`pushMode`), which sends pushes only while this Mac uses a relay for remote access. A Mac that talks to no relay must never start to because of push; only `grenade push on` (`enabled: true`) makes it post to the main relay. Keep it that way: it is Adam's decision.
- Route: `pushGatewayFor` answers null for `off` and for `auto` without a relay; otherwise the URL in `push.json`, else the relay this Mac uses for remote access (with its registration key), else the main relay. With remote access off that is one HTTPS request per push and no link.
- Phones are told: `Connection` watches the pusher (`Pusher.watch`) and passes on a new `push.state` when pushes start or stop being sent (`deliveryMayHaveChanged`, called after `POST /push/reload` and `POST /relay/reload`), so a phone in the background knows at once whether to notify by itself. `503` / `502` / no answer get one more try after 5 s if the session still waits.
- Off: `grenade push off` (`push.json` `enabled: false`), or `auto` with remote access off. Phones are told `delivery: "off"` and notify by themselves while they run.
- `grenade push test` sends every registered phone a push with `event: "test"`; `grenade push status` shows the route, the phones and what became of the last push.

## Network changes

The Mac may hop Wi‑Fi while the daemon runs. On macOS the service is registered with `dns-sd -R`, so mDNSResponder owns the SRV/A records and answers with the current address (and the current `<host>.local` name, which macOS renumbers per network: `-3`, `-4`…). The JS `bonjour-service` fallback snapshots interfaces at publish time and keeps advertising a dead address after a change; it is only used off-macOS. The phone matches the daemon by the `id` TXT key, never by name or address, and re-resolves while it is disconnected.

## Paired phones and encryption

Read PROTOCOL.md "Unpairing", "On the local network" and "Older clients and daemons", and `../grenade-protocol/SECURITY.md` for what this is meant to stop.

- **One encrypted protocol on both routes.** A Wi‑Fi socket (`LanSocket`) and a relay pipe (`PhonePipe`) both run a `SealedPipe`: the handshake of `src/relay/e2e.ts`, then sealed frames into an ordinary `Connection`. `Connection` knows whether it is `sealed` and which `route` it came by, nothing more.
- **Plain is refused.** A `hello` on an unsealed connection gets `unsupported_protocol` (never `unauthorized`: that makes a phone forget the Mac) and close 4001; plain `POST /pair` gets 426. `--allow-plain-lan` accepts both for phones that have not been updated, logs a warning per connection, and still refuses a token whose record is `sealed` (it paired or connected encrypted once), so nothing on the network can push a phone back to plain.
- **Ending a pairing** is always the same three steps, in `server.ts`: `TokenStore.revoke*` deletes the token and fires `onChange` (the relay link sends `update {access}` without it), then `closeConnectionsOf` tells every live connection of that token `error unauthorized` and closes it. It is reached from the control API (`grenade unpair`), from a phone's `unpair` frame (that connection gets `unpaired` instead), and from the hourly idle check (90 days unseen).
- **`grenade relay off`, or a move to another relay,** goes through `RelayLink.leave()`: it empties this Mac's access list on the relay it leaves, so that relay admits none of its phones afterwards.
- **Hooks are local.** `POST /hooks/claude` and `POST /hooks/claude/prompt` answer loopback addresses only (`isLoopback`); the port listens on every interface. Any new route on :7788 that only processes on this Mac should call must do the same.
- **The typed pairing code** is the 6-digit code plus `pairCheck(code, daemon key)`. The daemon only ever verifies the 6 digits; the check digits are for the phone, which compares them with the key from Bonjour before it sends anything. The TXT record carries `e2e=1` and `key=`.
- `lastSeen` moves on every `hello` and when a connection ends (`TokenStore.touch`, which is not an `onChange`).

## Remote access (`src/relay/`)

Read PROTOCOL.md "Remote access (relay)" first. Off until `grenade relay on [url]`; the main relay is `OFFICIAL_RELAY_URL` (`https://relay.holdgrenade.com`), and anyone can host `grenade-relay`.

- Config: `relay.json` holds `url`, an optional registration `key`, this Mac's relay `id` (`r_` + 32 hex) and `secret` (64 hex). `relay on` with the same URL keeps id and secret (and the key unless a new one is given); a different URL gets a new identity. `relay off` deletes the file. The CLI writes the file, then `POST /relay/reload` makes the daemon re-read it and restart the link.
- Identity shown to phones: `info.key` (base64 X25519 public key from `e2e-key`) is always in the pair reply and `welcome`; `info.relay = {url, id}` is set in place while a relay is configured, so the next welcome carries it.
- `RelayLink` dials `wss://<relay>/v1/daemon` (`Bearer <key>` when set) and sends `register` with name, version, `localIps`, and `access` = `accessHash(token)` of every paired token. It sends `update {access}` when a phone pairs (`TokenStore.onChange`) and `update {localIps}` when the Mac's IPv4 addresses change (checked every 10 s). Ping every 15 s; no pong for 30 s → terminate and reconnect (1, 2, 5, 10, 30 s). `error unauthorized` / `id_taken` (or a 401/403 upgrade) → state `error`, one warning with the fix, retry every 60 s.
- Each `open {conn}` gets a `PhonePipe`. First phone frame must be `{e2e:1,e}`; the pipe answers with its ephemeral key and derives the keys (`daemonAccept`). After that every frame is opened with `SealedChannel` and fed to a normal `Connection`, whose output is sealed back as `data`. A bad handshake, a frame that does not open, or no handshake in 10 s closes the pipe with 4400. The token check, hello timeout and everything else are the LAN `Connection`'s.
- When the link drops, every pipe is closed (the relay closes the phones with 4503). Status (`GET /status` → `relayLink`, `grenade relay status`): `state` off | connecting | online | error, `since`, `publicIp` (as the relay saw it), `localIps`, `lastError`, `phones`.

## First run (`src/cli/`, `src/setup/`, `src/service/`, `src/pairing/`)

Two steps for a user: install (`brew install holdgrenade/tap/grenade`) and `grenade setup`.

- **What ships** is `npm run release`: esbuild bundles `src/cli.ts` with `@grenade/protocol` and every library into `release/holdgrenade-cli-<version>/dist/cli.js`, beside a `package.json` without dependencies. That is how the `file:../grenade-protocol` dependency leaves the workspace: inside the bundle. The Homebrew formula (`depends_on "node"`, `"tmux"`) and `npm install -g @holdgrenade/cli` both install that tarball. Development still runs from `dist/` built by `tsc`.
- **Setup** runs five steps and skips each one that is done: requirements (offers `brew install tmux`; iTerm2 is optional and never offered), hooks, launchd agent, relay, pairing. After pairing it prints `nextSteps`: how to start an agent, and that it opens in an iTerm2 tab or a Terminal window, with a link to the docs' iTerm2 section. It changes `~/.claude/settings.json` and turns the relay on only after a yes on the terminal or with `--yes`; without a terminal and without `--yes` both are left alone. It never stops a daemon that runs in a terminal: it says how to move it to launchd and goes on.
- **The agent** is `~/Library/LaunchAgents/com.adamchew.grenade.daemon.plist`, loaded into `gui/<uid>` (the login session, which has the Keychain that `claude -p` needs). `RunAtLoad`, `KeepAlive` on a failed exit only, `ThrottleInterval` 10 s, and `AbandonProcessGroup` so tmux outlives the daemon. Its `PATH` is the one of the terminal that installed it: launchd's own is bare, and agents started in tmux inherit the daemon's. `GRENADE_*`, `TMUX_BIN`, `TMUX_TMPDIR`, `CLAUDE_BIN` and `CLAUDE_CONFIG_DIR` that are set at install time go into the plist too. What the daemon prints before its logger is up lands in `~/.grenade/launchd.log`.
- **Pairing** (PROTOCOL.md "Pairing offer (QR code)" and "Pairing inside the encrypted channel"): `POST /pair-code` mints code and secret and answers with `typed` and `offer`. `Connection.handlePair` takes a sealed `pair` with either, on the LAN socket or a relay pipe, through `ConnectionDeps.pair` → `pairPhone` in `server.ts`, which issues the token with `sealed: true`. While the secret is live its access hash is in the list the relay link uploads (`accessHashes` in `server.ts`); `PairingCodes.onChange` and a timer at the end of the two minutes send the list again. `pair` outside the encrypted channel is answered `unsupported_protocol` and is not counted as a try.

## Updates (`src/update/`)

- **Where "latest" comes from is what installs it.** A Homebrew copy reads the tap's formula, an npm copy npm's registry (`NPM_LATEST_URL`), so a copy is never offered a version its installer cannot deliver (npm is stuck at 0.1.0 while the account is suspended: npm copies then see nothing). A copy built from source (`installerFor` → null) is never installed over; `grenade update` says to pull and rebuild.
- **The daemon installs by itself** unless `grenade update --auto off`: when a check finds a newer release it runs `<prefix>/bin/brew update` + `brew upgrade grenade`, or `npm install -g @holdgrenade/cli@latest` with the npm beside the global folder (`<prefix>/bin/npm`, else beside the node running it), always by absolute path because launchd's PATH has neither. `HOMEBREW_NO_INSTALL_CLEANUP` and `HOMEBREW_NO_AUTO_UPDATE` are set. It is asynchronous and limited to 10 minutes. Then the existing rule restarts into it once no session is busy.
- **It stays out of the way:** `brew pin grenade` is honoured (`pinned`, not tried again for that version); an npm global folder this user cannot write gives `needsAdmin` with the `sudo` command, never a sudo attempt; a failure (brew busy, offline) is `failed` with a short reason (`installError`) and tried again after an hour while auto is on.
- **Side effect to know:** `brew upgrade grenade` also upgrades outdated dependencies, `node` and `tmux`. That is why `--auto off` and `brew pin` exist; npm copies replace only Grenade.
- **Restart now:** `POST /update/restart` (`restartNow`) runs what is on disk at once, for the Mac app's Restart on a ready version: 409 `busy` while a session works or waits for an answer unless `{ "force": true }` (the app asks first), 409 `cannot_restart` for a daemon started by hand.
- **The Mac app** shows the state (`GET /update`: `method`, `auto`, `install`, and `restarts`, false for a daemon started by hand, which never switches to a newer version on disk by itself) at the foot of its sidebar and its Update and Try Again buttons call `POST /update/install`, which starts the install whether auto is on or not and answers at once with `installing`.

## Invariants

- Never block the event loop on tmux: every tmux call is `execFile` with a 3 s timeout. Poll ticks skip if the previous one is still running.
- The daemon never reads a frame it did not validate: every inbound message goes through `parseClientFrame`; every outbound frame is typed `DaemonFrame`.
- The control API binds to `127.0.0.1` only. The WebSocket requires the encryption handshake, then a paired token before anything else, and closes after 5 s without a first frame or without `hello`.
- A token never crosses a network in the clear: `hello` and `pair` are only accepted on a sealed connection (unless `--allow-plain-lan`). Never log a token, a pairing code or a pairing secret; log the device `id`.
- Nothing readable crosses the relay: every frame after the handshake goes through `SealedChannel`. The relay gets access hashes, never tokens. Never add a feature that needs the relay to read a frame.
- A device token, a push key and a pairing token never reach a log line: a phone is named by its device id (`p_…`). `test/pusher.test.ts` checks it.
- Pure modules (`pushPolicy.ts`, `pushContent.ts`, `pushSeal.ts`, `status.ts`, `parse.ts`, `installHooks.ts`, `modelLabel.ts`, `summaryPrompt.ts`, `summaryTiming.ts`, `PairingCodes`, `e2e.ts`, `access.ts`, `localIps.ts`) take no I/O and no clock; inject `now`.
- Files in `GRENADE_HOME` are the only things written to disk (`relay.json` and `e2e-key` with mode 0600, uploads under `attachments/`), plus `~/.claude/settings.json` (`$CLAUDE_CONFIG_DIR/settings.json` when that is set) on `install-hooks` and on a yes in `setup`, which merge and never clobber, and `~/Library/LaunchAgents/com.adamchew.grenade.daemon.plist` on `service install`.

## Adding a frame

1. Define it in `../grenade-protocol` (PROTOCOL.md, `src/index.ts`, a fixture), rebuild that package (`npm run build` there, then `npm install` here to refresh the link).
2. Handle it in `Connection.dispatch` (client frame) or emit it from the registry (daemon frame).
3. `wsHandler.test.ts` will fail until the new client fixture dispatches without `bad_frame`.

## Testing

`npm test` is hermetic (no tmux, temp dirs; `daemon.test.ts` runs the whole daemon over loopback sockets on free ports). For the real thing:

```bash
export TMUX_TMPDIR=$(mktemp -d /tmp/gr.XXXX)   # its own tmux server, so it never adopts the live gr-* sessions (keep the path short: it holds a socket)
GRENADE_HOME=/tmp/grenade-smoke node dist/cli.js --control-port 7790 daemon --port 7799 --no-advertise --terminal none --no-relay &
node scripts/smoke.mjs --port 7799 --control-port 7790     # expects "SMOKE OK"; pairs and talks encrypted, checks plain is refused, unpairs itself
kill %1; tmux kill-server
```

Never test against the daemon on 7788/7789 while someone is using it from a phone, and never restart it on new code without thinking about the phones paired with it: a phone app that predates encryption is refused on Wi‑Fi unless the daemon runs with `--allow-plain-lan`.

Through a relay (run `grenade-relay` locally on :8787, see its README):

```bash
GRENADE_HOME=/tmp/grenade-relay-smoke node dist/cli.js --control-port 7790 daemon --port 7799 --no-advertise --terminal none &
node dist/cli.js --control-port 7790 relay on http://127.0.0.1:8787
node scripts/relay-smoke.mjs --port 7799 --control-port 7790   # pairs locally, then goes through the relay; expects "RELAY SMOKE OK"
```

As a phone that scanned the QR code (add `--via relay` with a relay set):

```bash
node scripts/pair-smoke.mjs --control-port 7790               # expects "PAIR SMOKE OK"
```

The release and the launchd agent, without touching the daemon you use (its own state, ports, label and tmux server):

```bash
npm run release && npm install -g --prefix /tmp/grenade-try ./release/holdgrenade-cli-*.tgz   # `./` matters: npm reads a bare path as a GitHub repo
export GRENADE_HOME=/tmp/grenade-try/home TMUX_TMPDIR=$(mktemp -d) CLAUDE_CONFIG_DIR=/tmp/grenade-try/claude; unset TMUX
/tmp/grenade-try/bin/grenade --control-port 7790 service install --label com.adamchew.grenade.daemon.test -- --port 7799 --no-advertise --terminal none
/tmp/grenade-try/bin/grenade --control-port 7790 setup --label com.adamchew.grenade.daemon.test
/tmp/grenade-try/bin/grenade --control-port 7790 service remove --label com.adamchew.grenade.daemon.test
```

Push notifications, with a relay of your own that has no push key (so nothing reaches Apple). Take ports nobody else uses, and a tmux socket of its own (`TMUX_TMPDIR`) so the test daemon does not adopt your sessions:

```bash
(cd ../grenade-relay && PORT=8799 GRENADE_RELAY_PUSH_UPSTREAM=off npm start) &
GRENADE_HOME=/tmp/grenade-push-smoke TMUX_TMPDIR=/tmp/grenade-push-smoke node dist/cli.js --control-port 7790 daemon --port 7799 --no-advertise --terminal none --no-relay &
GRENADE_HOME=/tmp/grenade-push-smoke node dist/cli.js --control-port 7790 push on http://127.0.0.1:8799
node scripts/push-smoke.mjs --port 7799 --control-port 7790 --expect push_unavailable   # expects "PUSH SMOKE OK"
```

Before driving a test daemon through its control port, check it is yours (`GET /status` → `id` equals `$GRENADE_HOME/daemon-id`): another daemon may hold the port, and the CLI would talk to that one.

Manual: `grenade daemon`, `grenade new demo --cwd ~ --agent shell`, `grenade open demo` in another terminal, then `grenade pair` and connect the phone.

## Known gaps

- Screens are plain text (no ANSI colors); `capture-pane -e` would need an ANSI renderer on the phone.
- `-J` joins wrapped lines, so the cursor row is approximate when long lines wrap.
- The socket on the Wi‑Fi is still `ws://`; the frames in it are end-to-end encrypted. Sizes and timing are visible on the network, and `GET /health` and Bonjour tell anyone on it the Mac's name, id, version and public key.
- `tokens.json` holds the tokens themselves (mode 0600). Storing only their hashes would stop a copy of the file from acting as a phone; whoever can read the file can read `e2e-key` beside it too, so it would not change who can get in.
- A typed code pairs on the same Wi‑Fi only. Away from it a phone pairs with the QR code, which needs the relay to be on.
- Two ways in, one tarball: the tap (`holdgrenade/homebrew-tap`, `../homebrew-tap`) installs the asset of the GitHub release `v<version>` of this repo, and npm has the same file as `@holdgrenade/cli` (the scope is the npm org `holdgrenade`; plain `grenade` is taken there). **A release is a version bump on `main`:** every change to the CLI bumps `version` in `package.json` in the same commit, and `.github/workflows/release.yml` does the rest on the push: tests, `npm run release`, tag `v<version>`, the GitHub release with `release/holdgrenade-cli-<version>.tgz`, then the formula committed to the tap with the sha256 of the tarball downloaded back from that release (`scripts/formula-from-tarball.mjs`), so the tap always matches what brew fetches, even on a rerun. **Homebrew is the release; npm is best effort:** `npm publish` is the last step and cannot fail the run (npm is not usable for now, so `@holdgrenade/cli` stays at 0.1.0; when it is, trusted publishing for it — GitHub Actions, this repo, `release.yml` — makes the step work with no token and no second factor). A push whose version the tap already has only runs the tests; every release step skips what an earlier run did, so a rerun is safe. The workflow needs two repository secrets, each a fine-grained personal access token that reaches one repo: `GH_GRENADE_PROTOCOL_TOKEN` reads `grenade-protocol`, `GH_HOMEBREW_TAP_TOKEN` writes `homebrew-tap` (GitHub refuses secret names that start with `GITHUB_`). The same steps still work by hand, in that order; check `gh run list --workflow release.yml` before doing any of it by hand.
- `grenade-protocol` is a private repo, so nobody outside can build this one from the source; the release tarball has the protocol inside.
- `grenade setup` installs the hooks for port 7788 and the agent without daemon options; a daemon on other ports is set up by hand (`install-hooks --port`, `service install -- --port …`).
- Codex status is heuristic only until Codex gets hooks.
