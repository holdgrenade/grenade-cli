# grenade-backend

The Mac side of Grenade: `grenaded` (daemon) and the `grenade` CLI. Runs your AI coding agents inside tmux, streams them to the Grenade phone app, and lets the phone type into them.

## Install

```bash
brew install adamkchew/grenade/grenade   # brings Node and tmux
grenade setup                            # hooks, start at login, relay, then a QR code for the phone
```

`grenade setup` asks before it changes anything and skips what is already done:

1. It checks for macOS, Node 22+, tmux 3.2+ and an agent, and offers `brew install tmux` when tmux is missing.
2. It shows the Claude Code hooks it would add to `~/.claude/settings.json` and adds them on a yes (`grenade install-hooks --remove` takes them out).
3. It installs a launchd agent, so `grenaded` starts at login and comes back if it stops (`grenade service remove`).
4. It offers the relay, for reaching the Mac from any network (`grenade relay off`).
5. It shows a QR code. Scan it in the Grenade app and the phone is paired, on any network when the relay is on.

`--yes` takes the suggested answer to every question; `--no-hooks`, `--no-service`, `--no-relay` and `--no-pair` leave a step out.

Without Homebrew, with Node 22+ and tmux 3.2+ already there: `npm install -g grenade-remote`, then `grenade setup`.

From the source:

```bash
brew install tmux
cd ../grenade-protocol && npm install && npm run build
cd ../grenade-backend && npm install && npm run build
npm link                 # puts `grenade` on your PATH
grenade setup
```

The tap and the npm package are not published yet. `npm run release` builds the tarball and the formula locally.

## Use

```bash
grenade service status   # is grenaded installed as a login agent, and running?
grenade daemon           # or run it in the foreground yourself
                         # with iTerm2 installed, every session also gets its own iTerm tab (--terminal none to turn off)

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
```

Away from home the phone reaches the daemon through a relay: both sides dial out to it, and everything between them is end-to-end encrypted, so the relay only learns which Macs are online and their IP addresses. With the relay on, a phone also pairs from anywhere: the QR code carries the Mac's key and a one-time secret, and both work once, for two minutes. The typed code pairs on the same Wi‑Fi only. Host your own relay with `../grenade-relay`.

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
