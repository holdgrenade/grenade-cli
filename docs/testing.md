# Testing against a real daemon

Smoke runs with tmux, a relay, pairing, the release and push.

Part of `grenade-cli`: its rules and invariants are in the repo's `CLAUDE.md`.

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
