# the mog

Anonymous random chat with strangers, in text or video. Add interests to get matched with people who share them, and skip to the next person whenever you like.

## Features

- **Text chat and video chat**, each with its own queue.
- **Interest matching**: you're paired with whoever is waiting and shares the most of your interests. If nobody matches within a few seconds, you're paired with a random stranger (you can turn this fallback off).
- **Skip with Next.** Press `Esc` twice or click **Next** twice to move on. **Auto-next** finds a new stranger automatically when the other person leaves.
- **Typing indicator**, an online counter, and a tab-title alert for new messages when the tab is in the background.
- **Video goes directly between the two browsers (WebRTC).** It never passes through the server. You can mute your mic or turn your camera off.
- **Moderation**: you can report a stranger, and after a report you won't be matched with them again that session. When enough different people report someone, that address is banned for a while. Messages are rate-limited and length-capped.
- **Security headers**: a strict Content Security Policy is set (no inline scripts or styles). Chat text is only ever rendered as text, never as HTML.
- Works on phones, in dark mode, and with reduced motion.

## Run it

Requires Node.js 18 or newer.

```bash
npm install
npm start          # http://localhost:3000
npm run dev        # restarts on file changes
npm test           # unit + socket integration tests
```

To try it alone, open two browser windows, or one normal and one private window.

## Configuration

All settings are optional environment variables.

| Variable | Default | What it does |
| --- | --- | --- |
| `PORT` | `3000` | Port the HTTP server listens on |
| `HOST` | `0.0.0.0` | Address the server binds to |
| `ICE_SERVERS` | Google public STUN | JSON array of WebRTC ICE servers, e.g. `[{"urls":"turn:turn.example.com:3478","username":"u","credential":"p"}]` |
| `TRUST_PROXY` | `false` | Set to `true` behind a reverse proxy so bans use the `X-Forwarded-For` address |
| `INTEREST_FALLBACK_MS` | `8000` | How long someone with interests waits before being matched with anyone |
| `REPORT_THRESHOLD` | `3` | Number of different reporters needed to ban someone |
| `BAN_MINUTES` | `60` | How long a ban lasts |

## Deploying

- **HTTPS is required for video.** Browsers only allow camera access on `https://` or `localhost`. Put the app behind a TLS-terminating proxy (Caddy, nginx, or your platform's load balancer) and set `TRUST_PROXY=true`. The proxy must allow WebSocket upgrades on `/socket.io/`.
- **Add a TURN server for reliable video.** STUN alone connects most people, but some users are behind strict NATs or firewalls. For them, video only works through a TURN relay, such as [coturn](https://github.com/coturn/coturn) or a hosted service. Configure it with `ICE_SERVERS`. Text chat works either way.
- **Run a single process.** The matchmaking queue, reports and bans live in memory. To run several instances, move that state into a shared store and add the Socket.IO Redis adapter.
- `GET /healthz` returns `{ "ok": true }` for health checks. `GET /api/stats` returns the online and waiting counts.

## How it works

```
browser A ──socket.io──┐                 ┌──socket.io── browser B
                       ├── server.js ────┤   matchmaking, text relay,
                       │   (Express)     │   WebRTC signalling, reports
browser A ◀════════ WebRTC audio/video (peer-to-peer) ════════▶ browser B
```

| Path | Role |
| --- | --- |
| `server.js` | Entry point: reads env vars and starts the server |
| `src/server.js` | Express + Socket.IO. Handles the chat protocol, relay, signalling, rate limits, security headers |
| `src/matchmaker.js` | Per-mode queues and interest-based pairing (plain logic, no I/O) |
| `src/moderation.js` | Report counting and temporary bans |
| `public/` | The frontend: one page, plain HTML/CSS/JS, no build step |
| `test/` | `node:test` suites for matching, moderation and the socket protocol |

### Socket events

| Client → server | Server → client |
| --- | --- |
| `find { mode, interests, randomFallback, seq }` | `searching { interests, seq }` |
| `leave` | `matched { mode, common, initiator, seq }` |
| `message { text }` (ack `{ ok, error? }`) | `message { text }` |
| `typing <bool>` | `typing <bool>` |
| `signal { description \| candidate }` | `signal { … }` |
| `report { reason }` (ack) | `partner_left`, `banned { remainingMs }`, `online <count>` |

`seq` is a counter the client increments for each search. The server echoes it back, so the client can ignore a `matched` event for a search it already abandoned (for example, after clicking Stop and then New in quick succession).
