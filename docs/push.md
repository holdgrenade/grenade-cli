# Push notifications and the Mac board

Part of `grenade-cli`: its rules and invariants are in the repo's `CLAUDE.md`.

## Push notifications (`src/push/`)

Read PROTOCOL.md "Push notifications" first. The phone is told that an agent needs it or has finished while the app is suspended or not running. The Mac holds no push key: it seals each push to the phone and posts it to a relay's push route, which hands it to Apple.

- Registering: a phone sends `push.register` after every `welcome`; `Connection` passes it to `Pusher.register` with the token of its `hello`, and the answer is `push.state`. One registration per paired phone, keyed by the device id `grenade devices` shows (`deviceIdFor(token)`), kept in `push-devices.json`. It goes with `push.unregister`, when the pairing ends (`TokenStore.onChange` → `pairingsChanged` prunes), and when the route answers 410.
- Events: `Pusher` listens to the registry's `updated`. A session that starts `waiting`, or waits for something else than before, is one event (`answer` or `done`, its `waitingFor`). An agent without hooks must have been busy 30 s for its `done` to count (`worthPushing`), with pauses under 10 s counted as the same stretch (`trackBusy`), so a quick shell command does not push.
- Pending: the push waits 3 s (`PUSH_GRACE_MS`), is held while someone is at the Mac, and is dropped as soon as the session is no longer that `waiting` (`decide`). A timer ticks once a second only while something is pending.
- At the Mac: `ioreg -c IOHIDSystem` gives the time since the last keyboard or mouse input, `ioreg -n Root` the screen lock. Input within 2 minutes (`--at-mac`, 0 never holds) and not locked means at the Mac. Neither needs a permission. A reading is reused for 5 s; one that fails counts as away. The lock key was not seen on a locked screen while writing this (it needs a locked Mac); the idle time was.
- Text: for `answer` the `message` of the hook that made it wait (`noteAsked`, called from the hook route), for `done` the session's `summary`, else `lastLine`. 200 characters at most.
- Title: the content carries the session's `title` as `sessionTitle` next to `sessionName`; the phone heads the notification with it, and with the name while a session has no title yet.
- Sealing: `sealPush` makes a fresh X25519 key per push and mixes in the daemon's long-term key, so only the phone can read it and only this Mac can have written it. `test/pushPure.test.ts` reproduces `fixtures/push.vectors.json`.
- Opt-in without a relay: `push.json` without `enabled` is `auto` (`pushMode`), which sends pushes only while this Mac uses a relay for remote access. A Mac that talks to no relay must never start to because of push; only `grenade push on` (`enabled: true`) makes it post to the main relay. Keep it that way: it is Adam's decision.
- Route: `pushGatewayFor` answers null for `off` and for `auto` without a relay; otherwise the URL in `push.json`, else the relay this Mac uses for remote access (with its registration key), else the main relay. With remote access off that is one HTTPS request per push and no link.
- Phones are told: `Connection` watches the pusher (`Pusher.watch`) and passes on a new `push.state` when pushes start or stop being sent (`deliveryMayHaveChanged`, called after `POST /push/reload` and `POST /relay/reload`), so a phone in the background knows at once whether to notify by itself. `503` / `502` / no answer get one more try after 5 s if the session still waits.
- Off: `grenade push off` (`push.json` `enabled: false`), or `auto` with remote access off. Phones are told `delivery: "off"` and notify by themselves while they run.
- `grenade push test` sends every registered phone a push with `event: "test"`; `grenade push status` shows the route, the phones and what became of the last push.

## Mac board (`src/push/board*.ts`)

Read PROTOCOL.md "Mac board" first. A phone's Live Activity shows every session on this Mac; while the app is suspended the daemon keeps it current with board pushes on the same push route. A board push cannot be sealed, so it carries only an opaque key per session (`boardKey`: HMAC under that phone's pairing token), a status and a time; `test/board.test.ts` reproduces `fixtures/board.examples.json`. The daemon says `board: 1` in `welcome` and `paired`.

- Registering: `board.register` → `BoardPusher.register` with the token of the `hello`, answered `board.state` (`delivery` as in `push.state`). One board per paired phone, keyed by device id, kept in `push-boards.json` with the board last sent (so a restart neither alerts again nor misses a change). It goes with `board.unregister`, the end of the pairing (`pairingsChanged`), a 410 from the route, and after its `end`.
- The phone draws the board itself when it registers, so a registration starts with that board as sent and pushes nothing until the board changes.
- When: on every registry `updated`/`removed` each phone's board is rebuilt (`boardStateFor` over `registry.list()`, the `sessions` frame order) and `observe`d. A change waits 2 s from when it was first seen (`BOARD_DEBOUNCE_MS`), two pushes to one phone are never closer than 5 s (`BOARD_MIN_INTERVAL_MS`), and a change undone in the meantime sends nothing (`boardStep`). One `setTimeout` for the earliest thing due; no ticking.
- Alert: `newlyAsking` against the board the route last took, and nobody at the Mac (`Pusher.atMac`, the same reading that holds a notification). Only the alert is held, never the push.
- End: 15 min (`BOARD_QUIET_END_MS`) with nothing but idle sessions (or none) sends `event: "end"` once and forgets the board.
- Failures: 410 forgets the board; `retry` (502/503/no answer) gets one more try after the min interval; anything else is a failure and the board waits for the next change. A board that failed is not counted as sent, so its question still alerts next time.
- With push off (`gateway()` null) nothing is sent and `board.state` says `delivery: "off"`.
