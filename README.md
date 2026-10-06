# grenade-cli

The computer's side of [Grenade](https://www.holdgrenade.com): `grenaded` (daemon) and the `grenade` CLI, for macOS and Linux. Runs your AI coding agents inside tmux, streams them to the Grenade phone app, and lets the phone type into them.

Grenade lets you watch and answer the AI coding agents running in terminals on your Mac or your Linux computer (Claude Code, Codex, or a plain shell) from your phone or from a Mac app: every session in one list with a status (needs an answer, finished, working, idle), the live terminal, Claude Code's permissions, questions and plans as cards, and a mic to talk into. On the same Wi‑Fi the phone talks to the computer directly; from anywhere else it goes through a relay. Both ways are end-to-end encrypted, and there is no account.

[Website](https://www.holdgrenade.com) · [Install](https://www.holdgrenade.com/install) · [Guide](https://www.holdgrenade.com/guide) · [Security](https://www.holdgrenade.com/security)

## Install

On a Mac:

```bash
brew install holdgrenade/tap/grenade   # brings Node and tmux
grenade setup                            # start at login, relay, then a QR code for the phone
```

On Linux (see [Linux](#linux) below):

```bash
curl -fsSL https://www.holdgrenade.com/install.sh | sh   # needs Node 22+; no sudo
grenade setup
```

`grenade setup` asks before it changes anything and skips what is already done:

1. It checks for macOS or Linux, Node 22+, tmux 3.2+ and an agent, and offers to install tmux when it is missing (`brew install tmux`; on Linux with pacman, apt-get or dnf). iTerm2 is not needed (see below).
2. It installs a launchd agent (on Linux a systemd user service), so `grenaded` starts at login and comes back if it stops (`grenade service remove`).
3. It offers the relay, for reaching the computer from any network (`grenade relay off`). Push notifications follow that answer: on with the relay, off without it, and setup says which.
4. It shows a QR code. Scan it in the Grenade app and the phone is paired, on any network when the relay is on.

Setup touches no agent's settings. Grenade starts Claude Code and Codex with its hooks (`claude --settings …`, `codex -c hooks.…`), so the phone knows when they work and wait. Claude Code also starts with a status line of Grenade's, which tells grenaded how full the conversation is and how much of your Pro or Max plan is used, and then runs your own status line, if you have one, so your line looks as before (a change to it applies to sessions started after). The first Codex session asks once to trust them; the phone shows it as a card, so tap Trust there or pick "Trust all and continue" in the terminal.

`--yes` takes the suggested answer to every question; `--no-hooks`, `--no-service`, `--no-relay` and `--no-pair` leave a step out.

On a Mac without Homebrew, with Node 22+ and tmux 3.2+ already there: `npm install -g @holdgrenade/cli`, then `grenade setup`.

Then get an app and scan the QR code: [Grenade: Agent Remote](https://apps.apple.com/app/grenade-agent-remote/id6818136871) for iPhone (iOS 17 or later), or [the Mac app](https://downloads.holdgrenade.com/mac/Grenade.dmg) (macOS 26 or later).

From the source, which needs the `grenade-protocol` repo checked out next to this one (it is not public, so today this works for the maintainers only):

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
grenade daemon           # or run it in the foreground yourself

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

grenade voice            # your API keys for Talk and dictation: the providers, and which hold a key
grenade voice key openai # keep a key on this Mac: asked for without showing it, checked with the provider (also: gemini, wispr-flow)
grenade voice forget openai

grenade talk "ask the relay one to bump its version"   # typed Talk: an agent on this Mac sends it to the right session
grenade talk log         # today's Talk thread
grenade talk agent codex # which agent answers typed Talk (claude or codex; with none named, which one does)

grenade update           # install the latest version now (grenaded also does it by itself)
grenade update --auto off  # stop grenaded installing new versions by itself (grenade update --auto on: back)
```

Grenade keeps itself up to date: grenaded checks for a new version every few hours, installs it with Homebrew or npm (whichever installed it; on Linux it downloads the release and checks its sha256), and switches over once no session is working; your sessions keep running. With Homebrew this also upgrades its `node` and `tmux` when they are outdated. `brew pin grenade` or `grenade update --auto off` stops it.

### Linux

`grenaded` runs on Linux with systemd, Node 22+ and tmux 3.2+. It is tested on Arch Linux (which Omarchy is), x86_64.

- **Install.** `install.sh` reads the release Homebrew installs (the tap's formula), downloads that tarball from this repo's releases, checks its sha256, unpacks it into `~/.local/share/grenade` and links `~/.local/bin/grenade`. No sudo, no npm. Running it again updates; `grenade update` and grenaded itself do the same steps. Remove it with `grenade service remove; rm -rf ~/.local/share/grenade ~/.local/bin/grenade`.
- **Start at login.** A systemd user service, `~/.config/systemd/user/grenade.service`, handled with `systemctl --user` (`grenade service status`). It runs while you are logged in; `loginctl enable-linger $USER` keeps it running after you log out, on a machine nobody sits at.
- **Firewall.** A firewall that refuses incoming connections (ufw on Omarchy and Ubuntu) keeps a phone on the same Wi‑Fi out until you allow the port: `sudo ufw allow 7788/tcp`. `grenade setup` says so when ufw is on. Through the relay the phone gets in without it.
- **Watching sessions.** On the phone, or in any terminal with `grenade open <name>`. `grenade terminal` (iTerm2, Terminal.app) and the Mac app are for a Mac.
- **Not there yet.** A push notification is never held back while you are at the computer: on a Mac it waits while the keyboard or mouse was used in the last two minutes.

### On the Mac

Every session is a tmux session (`gr-<name>`), so it survives any window closing; only `grenade kill` ends it. Watch them in the Grenade Mac app or on the phone; no terminal window opens by itself. `grenade open <name>` attaches any terminal, and `grenade terminal` opens every session in one for you:

```bash
grenade terminal iterm      # every session in iTerm2: a tab per group, its sessions side by side
grenade terminal terminal   # every session in a Terminal.app window of its own
grenade terminal auto       # iTerm2 when it is installed, else Terminal.app
grenade terminal none       # the default: no windows
grenade terminal            # what is set
```

It takes effect at once, also for sessions already running, and stays across restarts and updates (`~/.grenade/terminal.json`). The first time, macOS may ask whether grenaded (it says `node`) may control iTerm2 or Terminal: allow it, or no window appears. If you clicked Don't Allow: System Settings › Privacy & Security › Automation.

`grenade new` in a folder that already has a live session joins that session's **group**: `--alone` starts a group of its own, `--with <session>` joins a specific one. `grenade group` and `grenade ungroup` move sessions later; the phone does the same by drag and drop.

#### iTerm2

With `grenade terminal iterm` (or `auto` and iTerm2 installed) a group is one tab, its sessions as split panes side by side in group order, following every move. `brew install --cask iterm2` first. Closing a tab or detaching (Ctrl-b d) leaves the agent running.

Away from home the phone reaches the daemon through a relay: both sides dial out to it, and everything between them is end-to-end encrypted, so the relay only learns which Macs are online and their IP addresses. With the relay on, a phone also pairs from anywhere: the QR code carries the Mac's key and a one-time secret, and both work once, for two minutes. The typed code pairs on the same Wi‑Fi only. You can host your own relay: [Self-host a relay](https://www.holdgrenade.com/relay).

Push notifications tell the phone that an agent needs an answer or has finished, even while the app is closed. They follow remote access: with `grenade relay on` they are on and go through that relay; with remote access off they are off and the Mac talks to no relay. `grenade push on` turns them on by themselves, through the main relay. The Mac seals each one so that only your phone can read it, and the relay hands it to Apple. That relay learns the Mac's public IP address, the phone's device token and the time, never the session or the text. A push waits while you are at the Mac (keyboard or mouse used in the last two minutes; `grenade push on --at-mac 0` to never wait) and is dropped once you have answered.

Talk (a spoken conversation about your sessions, in the Mac app and the iPhone app) and dictation with Wispr Flow (the iPhone's mic) run at a provider, under your own API key: OpenAI or Google's Gemini for Talk, Wispr Flow for dictation. The key is kept on this Mac, in `~/.grenade/voice-keys.json` (readable by you only), and never on a phone. `grenade voice key openai` asks for the key without showing it (or reads it from stdin: `grenade voice key openai < key.txt`), checks it with the provider, and keeps it; `gemini` and `wispr-flow` work the same way. Pasting a key in an app's settings hands it to this Mac in the same way. Each time an app opens a connection to the provider it asks grenaded for a pass that lasts about a minute (fifteen for dictation), so the app never holds the key, and what you say goes straight from the app to the provider, never through grenaded or a relay. `grenade voice` lists the providers and shows a kept key masked (`sk-…a1b2`); `grenade voice forget <provider>` removes it at once (to make the key itself worthless, revoke it at the provider). The apps use this from the Mac app 1.0.78 and the iPhone app 1.0.53; earlier ones kept the key themselves.

Typed Talk is Talk without a voice key: you type what you want done, and Claude Code or Codex, already signed in on this Mac, answers it with Grenade's tools only (list and read sessions, work out which one you mean, send it a prompt, start one in a project). It runs headless on this Mac for each message, in a private folder, with no shell and no file editing of its own. Which session you mean is decided by fixed rules, the same ones spoken Talk uses; when they are not sure, it asks you which, and nothing is sent until you answer. It sends a prompt only where you asked, never answers a permission, a question or a plan for you, and treats what sessions write as data, never as instructions. `grenade talk "<words>"` says it and prints what follows: what was sent where, what it asks, its answer; the thread is kept a day at a time in `~/.grenade/talk/` (readable by you only), and later rows say when a session it sent to needs you or has finished. The first agent installed answers (Claude Code, then Codex) until `grenade talk agent` chooses another. Codex 0.160.0 cannot use the tools from `codex exec` (its code-mode host times out); a newer Codex can.

The daemon listens on `:7788` (WebSocket at `/ws`) and advertises itself as `_grenade._tcp` so the phone finds it on the same Wi‑Fi. State lives in `~/.grenade/`.

On the Wi‑Fi the phone and the Mac speak the same end-to-end encryption as through the relay, so nobody else on the network can read a session or take a token. A phone app that predates this is refused; while you update it, `grenade daemon --allow-plain-lan` lets it in. A phone you have not used for 90 days is unpaired. What this does and does not protect against is on [holdgrenade.com/security](https://www.holdgrenade.com/security).

## Develop

```bash
npm test                 # unit tests
npm run dev -- daemon    # run from source
node scripts/smoke.mjs   # end-to-end against a running daemon
node scripts/pair-smoke.mjs --control-port 7790   # a phone that scanned the QR code
npm run release          # the tarball and the Homebrew formula, locally
```

See `CLAUDE.md` for the architecture. The wire format is `PROTOCOL.md` in `grenade-protocol`, which is not public.

The workflow runs the tests and `scripts/smoke.mjs` in an Arch Linux container, then the tests on macOS, before a release.

## Help

Something does not work, in any part of Grenade (this CLI, an app, the relay): [open an issue](https://github.com/holdgrenade/grenade-cli/issues). A security problem: [report it privately](https://github.com/holdgrenade/grenade-cli/security/advisories/new).

MIT license, see `LICENSE`.
