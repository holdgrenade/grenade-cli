# Changelog

What changed in each version of Grenade's CLI and daemon (`@holdgrenade/cli`), newest first. Every push to `main` is a release: CI's `bump` job (`.github/workflows/release.yml`) writes the released version's section from the commit subjects since the previous tag, and that section is the GitHub release's notes. A section written here by hand for the version being released is kept as it is, so write one when the commit subjects don't say enough.

## 1.0.73 (2026-10-09)

- CHANGELOG.md: every earlier version, from history

## 1.0.72 (2026-10-09)

- A CHANGELOG section for every release, its notes on the GitHub release

## 1.0.71 (2026-10-09)

- Hardening: web pages kept off /ws, a 4 MiB message cap, ~/.grenade 0700

## 1.0.70 (2026-10-09)

- Only Grenade's extension, and only loopback names, reach the control API

## 1.0.69 (2026-10-09)

- Every push releases: CI bumps the patch when a push did not

## 1.0.68 (2026-10-08)

- CLAUDE.md trimmed, reference moved to docs/

## 1.0.67 (2026-10-08)

- Activity: a reply that names an error is no longer an error card

## 1.0.66 (2026-10-08)

- refuse every Origin but the Chrome extension's
- eliot: treat Origin: null as a web page origin and refuse it

## 1.0.65 (2026-10-08)

- comments on published links, and the owner's name

## 1.0.63 (2026-10-08)

- a plan approved with a note (designed first) carries it after the plan

## 1.0.62 (2026-10-08)

- session.mode switches a Claude Code session into plan mode

## 1.0.61 (2026-10-08)

- publish a session's plan to a secret link (publish.plan), following every save
- a pasted prompt with a picture in it is sent, not left in Claude Code's box

## 1.0.60 (2026-10-08)

- plans: Session.plan, follow and edit a plan file, build it with the user's edits
- protocol 1.19 (the Chrome extension pairs as chrome); web pages are refused by the control API and POST /pair

## 1.0.59 (2026-10-07)

- attachments dropped together each get a file, and an error names its upload

## 1.0.58 (2026-10-07)

- remove the Wispr Flow voice provider (its API closed)

## 1.0.57 (2026-10-07)

- show pasted and mid-turn prompts in the activity at once, once

## 1.0.56 (2026-10-06)

- Pause pairing after wrong codes

## 1.0.55 (2026-10-06)

- several canvases per group (protocol 1.16.0)

## 1.0.54 (2026-10-06)

- the Talk thread is a feed of every session

## 1.0.53 (2026-10-06)

- publish a canvas whose session works inside its .grenade

## 1.0.52 (2026-10-05)

- typed Talk, answered by Claude Code or Codex on this computer

## 1.0.51 (2026-10-05)

- publish a canvas to a secret link

## 1.0.50 (2026-10-05)

- a session's context and the agents' plan limits
- the canvas tests take the computer's word from computerWord

## 1.0.49 (2026-10-04)

- the daemon serves a group's design canvas to the apps

## 1.0.48 (2026-10-04)

- the npm step publishes a version npm lacks even when the tap has it

## 1.0.47 (2026-10-04)

- a model switch from an app answers Claude Code's "Switch model?" itself

## 1.0.46 (2026-10-04)

- GET /agents says which agents this computer can run and whether each is signed in

## 1.0.45 (2026-10-04)

- the README says how to keep the API keys for Talk and dictation

## 1.0.44 (2026-10-04)

- Claude Code's "Switch model?" is a card an app can answer

## 1.0.43 (2026-10-04)

- voice providers' API keys are kept on this computer

## 1.0.42 (2026-10-03)

- an app can switch a Claude Code session's model

## 1.0.41 (2026-10-03)

- a group keeps the name an app gives it

## 1.0.40 (2026-10-03)

- the daemon tells the apps which system it runs on

## 1.0.39 (2026-10-03)

- the version follows 1.0.38 again

## 1.0.38 (2026-10-03)

- the Homebrew formula's homepage is the website

## 1.0.37 (2026-10-03)

- Linux copies install and update from the release's tarball; the words name a computer there

## 1.0.36 (2026-10-03)

- CLAUDE.md says how the tarball installs on Linux today
- a shell session runs the user's login shell when SHELL is unset; the Linux job runs on Arch
- the push smoke test runs only against a relay on this Mac

## 1.0.35 (2026-10-03)

- grenaded runs on Linux, as a systemd user service

## 1.0.34 (2026-10-03)

- the README says what Grenade is, where the apps are, and links to pages a visitor can open

## 1.0.33 (2026-10-03)

- a push carries the session's title, which the phone heads the notification with

## 1.0.32 (2026-10-03)

- a session with background tasks still running stays working

## 1.0.31 (2026-10-03)

- sessions open in no terminal unless asked; grenade terminal turns it on

## 1.0.30 (2026-10-03)

- the Mac board, a phone's Live Activity kept current by board pushes
- CLAUDE.md: the note on Codex inline sits with the agent commands

## 1.0.29 (2026-10-02)

- Codex runs inline, so its terminal scrolls back

## 1.0.28 (2026-10-02)

- Codex conversations are listed and resumed; agents are data

## 1.0.27 (2026-10-02)

- a prompt sent to Codex is sent, not left in its box

## 1.0.26 (2026-10-02)

- the README says the Codex trust question is a card on the phone

## 1.0.25 (2026-10-02)

- Codex's startup dialogs are cards on the phone

## 1.0.24 (2026-10-02)

- every agent starts with its hooks; setup writes none

## 1.0.23 (2026-10-02)

- Codex sessions get activity and hook status

## 1.0.22 (2026-10-02)

- built on @grenade/protocol 1.0.0

## 1.0.21 (2026-10-02)

- send stopped turns only to iPhone 1.0.26 and Mac 1.0.50 and later

## 1.0.20 (2026-10-02)

- a turn that stopped partway is stopped, not working forever

## 1.0.19 (2026-10-02)

- never let a window follow the Mac terminals below 60 columns

## 1.0.18 (2026-10-02)

- a short title for each session: Claude Code's own title, else the summarizer's

## 1.0.17 (2026-10-02)

- answer `folders` with the folders inside a path, for browsing to a new session's folder

## 1.0.16 (2026-10-02)

- live terminal: stream a session's terminal to a client through tmux control mode

## 1.0.15 (2026-10-02)

- delete a past conversation: it goes to the macOS Trash

## 1.0.14 (2026-10-02)

- release the conversations feature after the merge with 1.0.13

## 1.0.13 (2026-10-02)

- list, preview, archive and resume past Claude Code conversations
- errored activity entries and activity test injection

## 1.0.12 (2026-10-02)

- a client can give a session's width back and stay subscribed

## 1.0.11 (2026-10-01)

- a prompt stopped before Claude wrote anything ends the turn too

## 1.0.10 (2026-10-01)

- a Stop from the phone or the Mac ends the turn

## 1.0.9 (2026-10-01)

- a release to try updating end to end

## 1.0.8 (2026-10-01)

- POST /update/restart runs a ready version now, for the Mac app's Restart

## 1.0.7 (2026-10-01)

- the update status says whether grenaded can restart itself

## 1.0.6 (2026-10-01)

- grenaded installs new versions by itself, and the Mac app can ask it to

## 1.0.5 (2026-10-01)

- prompts are acknowledged, and one sent again is typed once

## 1.0.4 (2026-10-01)

- iTerm2 is optional; setup no longer offers to install it

## 1.0.3 (2026-10-01)

- multi-line input is pasted, so its line breaks reach the agent

## 1.0.2 (2026-10-01)

- a new session always starts its agent

## 1.0.1 (2026-10-01)

- the main relay is https://relay.holdgrenade.com

## 1.0.0 (2026-10-01)

- Version bump only.

## 0.1.13 (2026-10-01)

- the daemon keeps the group order for every client

## 0.1.12 (2026-10-01)

- activity survives a daemon restart

## 0.1.11 (2026-10-01)

- Updates

## 0.1.10 (2026-09-30)

- the daemon accepts the Mac app (platform macos)

## 0.1.9 (2026-09-30)

- Move the iOS app to bundle id com.holdgrenade.grenade

## 0.1.8 (2026-09-30)

- A prompt no longer shows twice in the activity

## 0.1.7 (2026-09-30)

- iTerm2 tabs work without a restart, and setup offers iTerm2

## 0.1.6 (2026-09-30)

- npm publish takes a path, not a GitHub repo

## 0.1.5 (2026-09-30)

- Homebrew is the release; npm is best effort

## 0.1.4 (2026-09-30)

- Follow a cd typed as a ! command too

## 0.1.3 (2026-09-30)

- Show the folder the agent is in, not only where it started

## 0.1.2 (2026-09-30)

- Show the reply in the activity when Stop beats the transcript
- One secret per repo the release workflow reaches
- Secrets named after the repo each one reaches

## 0.1.1 (2026-09-30)

- Send a session's activity: what the agent said and was asked
- Push notifications: tell the phone when an agent needs it or is done
- grenade prompt test, and pairing options named as on the phone
- Install from holdgrenade/tap; ignore secrets and build output
- Rename grenade-backend to grenade-cli
- Release 0.1.0 through the Homebrew tap
- The npm package is @holdgrenade/cli
- TypeScript 7, and the latest ws types
- Release from GitHub Actions on a version bump

## 0.1.0 (2026-09-29)

- grenaded and the grenade CLI
