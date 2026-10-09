# Connections

Network changes, paired phones and encryption, remote access through a relay.

Part of `grenade-cli`: its rules and invariants are in the repo's `CLAUDE.md`.

## Network changes

The Mac may hop Wi‑Fi while the daemon runs. On macOS the service is registered with `dns-sd -R`, so mDNSResponder owns the SRV/A records and answers with the current address (and the current `<host>.local` name, which macOS renumbers per network: `-3`, `-4`…). The JS `bonjour-service` fallback snapshots interfaces at publish time and keeps advertising a dead address after a change; it is only used off-macOS. The phone matches the daemon by the `id` TXT key, never by name or address, and re-resolves while it is disconnected.

## Paired phones and encryption

Read PROTOCOL.md "Unpairing", "On the local network" and "Older clients and daemons", and `../grenade-protocol/SECURITY.md` for what this is meant to stop.

- **One encrypted protocol on both routes.** A Wi‑Fi socket (`LanSocket`) and a relay pipe (`PhonePipe`) both run a `SealedPipe`: the handshake of `src/relay/e2e.ts`, then sealed frames into an ordinary `Connection`. `Connection` knows whether it is `sealed` and which `route` it came by, nothing more.
- **Plain is refused.** A `hello` on an unsealed connection gets `unsupported_protocol` (never `unauthorized`: that makes a phone forget the Mac) and close 4001; plain `POST /pair` gets 426. `--allow-plain-lan` accepts both for phones that have not been updated, logs a warning per connection, and still refuses a token whose record is `sealed` (it paired or connected encrypted once), so nothing on the network can push a phone back to plain.
- **Ending a pairing** is always the same three steps, in `server.ts`: `TokenStore.revoke*` deletes the token and fires `onChange` (the relay link sends `update {access}` without it), then `closeConnectionsOf` tells every live connection of that token `error unauthorized` and closes it. It is reached from the control API (`grenade unpair`), from a phone's `unpair` frame (that connection gets `unpaired` instead), and from the hourly idle check (90 days unseen).
- **`grenade relay off`, or a move to another relay,** goes through `RelayLink.leave()`: it empties this Mac's access list on the relay it leaves, so that relay admits none of its phones afterwards.
- **Hooks are local.** `POST /hooks/claude` and `POST /hooks/claude/prompt` answer loopback addresses only (`isLoopback`); the port listens on every interface. Any new route on :7788 that only processes on this Mac should call must do the same. **Web pages are refused too** (for the Chrome extension): the control API on 127.0.0.1:7789 and every HTTP route on :7788 but `GET /health` answer `403 forbidden` to a request with any `Origin` but the Chrome extension's (`fromWebPage` in `loopback.ts`), because a page in a browser on this Mac reaches loopback too. It lists what passes, not what is refused: no Origin (the CLI, the apps and the hooks send none) and a single `chrome-extension://<id>`. Everything else, `http:`, `https:`, the `null` of a sandboxed frame or a `file:` page, counts as a page. The extension pairs as `platform: "chrome"` (protocol 1.19.0).
- **The typed pairing code** is the 6-digit code plus `pairCheck(code, daemon key)`. The daemon only ever verifies the 6 digits; the check digits are for the phone, which compares them with the key from Bonjour before it sends anything. The TXT record carries `e2e=1` and `key=`.
- `lastSeen` moves on every `hello` and when a connection ends (`TokenStore.touch`, which is not an `onChange`).

## Remote access (`src/relay/`)

Read PROTOCOL.md "Remote access (relay)" first. Off until `grenade relay on [url]`; the main relay is `OFFICIAL_RELAY_URL` (`https://relay.holdgrenade.com`), and anyone can host `grenade-relay`.

- Config: `relay.json` holds `url`, an optional registration `key`, this Mac's relay `id` (`r_` + 32 hex) and `secret` (64 hex). `relay on` with the same URL keeps id and secret (and the key unless a new one is given); a different URL gets a new identity. `relay off` deletes the file. The CLI writes the file, then `POST /relay/reload` makes the daemon re-read it and restart the link.
- Identity shown to phones: `info.key` (base64 X25519 public key from `e2e-key`) is always in the pair reply and `welcome`; `info.relay = {url, id}` is set in place while a relay is configured, so the next welcome carries it.
- `RelayLink` dials `wss://<relay>/v1/daemon` (`Bearer <key>` when set) and sends `register` with name, version, `localIps`, and `access` = `accessHash(token)` of every paired token. It sends `update {access}` when a phone pairs (`TokenStore.onChange`) and `update {localIps}` when the Mac's IPv4 addresses change (checked every 10 s). Ping every 15 s; no pong for 30 s → terminate and reconnect (1, 2, 5, 10, 30 s). `error unauthorized` / `id_taken` (or a 401/403 upgrade) → state `error`, one warning with the fix, retry every 60 s.
- Each `open {conn}` gets a `PhonePipe`. First phone frame must be `{e2e:1,e}`; the pipe answers with its ephemeral key and derives the keys (`daemonAccept`). After that every frame is opened with `SealedChannel` and fed to a normal `Connection`, whose output is sealed back as `data`. A bad handshake, a frame that does not open, or no handshake in 10 s closes the pipe with 4400. The token check, hello timeout and everything else are the LAN `Connection`'s.
- When the link drops, every pipe is closed (the relay closes the phones with 4503). Status (`GET /status` → `relayLink`, `grenade relay status`): `state` off | connecting | online | error, `since`, `publicIp` (as the relay saw it), `localIps`, `lastError`, `phones`.
