# grenade-cli

The Mac side of Grenade: `grenaded` (daemon) and the `grenade` CLI. Runs your AI coding agents inside tmux, streams them to the Grenade phone app, and lets the phone type into them.

## Install

```bash
brew install holdgrenade/tap/grenade   # brings Node and tmux
grenade setup                            # hooks, start at login, relay, then a QR code for the phone
```

`grenade setup` asks before it changes anything and skips what is already done:

1. It checks for macOS, Node 22+, tmux 3.2+ and an agent, and offers `brew install tmux` when tmux is missing. iTerm2 is not needed (see below).
2. It shows the Claude Code hooks it would add to `~/.claude/settings.json` and adds them on a yes (`grenade install-hooks --remove` takes them out).
3. It installs a launchd agent, so `grenaded` starts at login and comes back if it stops (`grenade service remove`).
4. It offers the relay, for reaching the Mac from any network (`grenade relay off`). Push notifications follow that answer: on with the relay, off without it, and setup says which.
5. It shows a QR code. Scan it in the Grenade app and the phone is paired, on any network when the relay is on.

`--yes` takes the suggested answer to every question; `--no-hooks`, `--no-service`, `--no-relay` and `--no-pair` leave a step out.

Without Homebrew, with Node 22+ and tmux 3.2+ already there: `npm install -g @holdgrenade/cli`, then `grenade setup`.

From the source:

```bash
brew install tmux
cd ../grenade-protocol && npm install && npm run build
cd ../grenade-cli && npm install && npm run build
npm link                 # puts `grenade` on your PATH
grenade setup
```

`npm run release` builds the tarball and the Homebrew formula locally. Homebrew and npm install that same tarball.

## Use

```bash
grenade service status   # is grenaded installed as a login agent, and running?
grenade daemon           # or run it in the foreground yourself (--terminal none: no iTerm tabs)

grenade new grenade --cwd ~/projects/grenade --agent claude
grenade open grenade     # attach your terminal to it (Ctrl-b d to detach)
grenade pair             # QR code for the phone, and a code to type (6 digits, then 4 that let the phone check it is talking to this Mac)
grenade devices          # the phones paired with this Mac
grenade unpair <phone>   # end a phone's pairing at once (or: grenade unpair --all)
grenade ls
grenade kill grenade

grenade relay on         # reach this Mac from any network via the main Grenade relay (or: grenade relay on <your relay>)
grenade relay status     # online? public and local IPs, phones connected through it
grenade relay off

grenade push status      # push notifications: on or off, through which relay, which phones asked for them
grenade push test        # send every registered phone a test notification
grenade push on          # send them also with remote access off, through the main relay
grenade push off         # send none (grenade push auto: on while remote access is on, the default)
```

### On the Mac

Every session is a tmux session (`gr-<name>`), so it survives any window closing; only `grenade kill` ends it. The daemon opens a window per session in Terminal.app, so all your agents are on screen at once. `grenade open <name>` attaches any other terminal, and `--terminal none` opens nothing.

`grenade new` in a folder that already has a live session joins that session's **group**: `--alone` starts a group of its own, `--with <session>` joins a specific one. `grenade group` and `grenade ungroup` move sessions later; the phone does the same by drag and drop.

#### iTerm2 (optional)

iTerm2 is not needed, but with it installed the daemon uses it instead of Terminal.app: a tab per group, its sessions as split panes side by side in group order, following every move.

- `brew install --cask iterm2`. Installing it after setup is enough: the next session opens in a tab, and every live session gets one then. No restart.
- The first time, macOS may ask whether grenaded (it says `node`) may control iTerm2. Allow it, or no tab appears. If you clicked Don't Allow: System Settings › Privacy & Security › Automation.
- Closing a tab or detaching (Ctrl-b d) leaves the agent running.
- `--terminal terminal` keeps Terminal.app even with iTerm2 installed.

Away from home the phone reaches the daemon through a relay: both sides dial out to it, and everything between them is end-to-end encrypted, so the relay only learns which Macs are online and their IP addresses. With the relay on, a phone also pairs from anywhere: the QR code carries the Mac's key and a one-time secret, and both work once, for two minutes. The typed code pairs on the same Wi‑Fi only. Host your own relay with `../grenade-relay`.

Push notifications tell the phone that an agent needs an answer or has finished, even while the app is closed. They follow remote access: with `grenade relay on` they are on and go through that relay; with remote access off they are off and the Mac talks to no relay. `grenade push on` turns them on by themselves, through the main relay. The Mac seals each one so that only your phone can read it, and the relay hands it to Apple. That relay learns the Mac's public IP address, the phone's device token and the time, never the session or the text. A push waits while you are at the Mac (keyboard or mouse used in the last two minutes; `grenade push on --at-mac 0` to never wait) and is dropped once you have answered.

The daemon listens on `:7788` (WebSocket at `/ws`) and advertises itself as `_grenade._tcp` so the phone finds it on the same Wi‑Fi. State lives in `~/.grenade/`.

On the Wi‑Fi the phone and the Mac speak the same end-to-end encryption as through the relay, so nobody else on the network can read a session or take a token. A phone app that predates this is refused; while you update it, `grenade daemon --allow-plain-lan` lets it in. A phone you have not used for 90 days is unpaired. What this does and does not protect against is in `../grenade-protocol/SECURITY.md`.

## Develop

```bash
npm test                 # unit tests
npm run dev -- daemon    # run from source
node scripts/smoke.mjs   # end-to-end against a running daemon
node scripts/pair-smoke.mjs --control-port 7790   # a phone that scanned the QR code
npm run release          # the tarball and the Homebrew formula, locally
```

See `CLAUDE.md` for the architecture and `../grenade-protocol/PROTOCOL.md` for the wire format.
