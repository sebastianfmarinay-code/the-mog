# the mog

Random chat with strangers, combined with disappearing photo snaps. Meet someone new over text or video, send them a snap they can only see once, and if you get along, add each other as friends. After that you can keep chatting, keep a daily streak, and post stories.

## Features

### Meet (random chat)
- **Text or video chat with random strangers**, with separate queues for each.
- **Interest matching**: you're paired with whoever shares the most of your interests. If nobody matches after a few seconds, you're paired with anyone (you can turn this off).
- **Next** (press `Esc` twice) skips to someone new. **Auto** finds a new stranger automatically when the other person leaves. Also: a typing indicator, an online counter, and a **Report** button.
- **Snaps to strangers**: send the person you're chatting with a disappearing photo.
- **Filters on video**: the stranger sees your filtered video. **Pixel** hides your face.
- **Add friend**: if you both tap it, you see each other's usernames and they move into Chats.

### Camera
- Full-screen camera with live filters: Golden, Mono, Dream, Noir, Arctic, Thermal, VHS, Twin and Pixel. Swipe sideways or use the arrow keys to switch filters; press Space to take a snap.
- **Editor**:
  - add a caption bar (drag it up or down)
  - add emoji stickers (drag to move, tap to resize, drag onto the bin to delete)
  - draw with a pen (undo available)
  - set how long the snap shows: 1, 3, 5 or 10 seconds
  - save the snap to your device
- **Send to…** any mix of friends, the stranger you're chatting with, and your story.

### Chats
- **Friend list**: shows who's online, **🔥 streaks** (⏳ when today's snap is still needed), and markers for new snaps, new chats, and whether your last snap or chat was delivered, opened or seen.
- **Snaps open once.** The image is deleted from the server as soon as it's viewed.
- **Messages disappear** once they've been seen and you leave the chat. Your sent messages show *Delivered* and then *Seen*.
- Add friends by username; accept or decline requests; unfriend.

### Stories
- Post a snap to **My story**. Friends can see it for 24 hours, then it's deleted.
- Tap a friend to watch their story: tap right or left to skip, hold to pause. On your own story you can see who viewed each snap and delete it.

### Profile
- No email and no password: pick an emoji avatar, a colour and a username. You stay signed in on that browser.
- The 18+ and house-rules agreement is shown once, at sign-up.

### Under the hood
- Video and audio go **directly between the two browsers** (WebRTC). They never pass through the server.
- Uploaded snaps are checked to be real JPEG, PNG or WebP files, capped at 1.5 MB, and only reach the people they were sent to. Unopened snaps expire after 30 days.
- **Rate limits** on messages, snaps and friend requests.
- **Safety:** reports from several different people trigger a temporary ban. The site sends a strict Content Security Policy, and chat text is never rendered as HTML.
- **Phone-first layout** with a bottom tab bar; desktop gets a side rail. Supports dark mode, and you can add it to your phone's home screen.

## Run it

You need Node.js 18 or newer.

```bash
npm install
npm start          # http://localhost:3000
npm run dev        # restarts on file changes
npm test           # 40 tests: matching, accounts, friends, snaps, stories, streaks
```

To try it on your own, open two different browsers (or one normal and one private window). Each gets its own profile, so you can match with yourself, add yourself as a friend, and swap snaps.

Accounts, friends and unopened snaps are saved in a `data/` folder next to `server.js`. Delete that folder to start fresh.

### On Android (Termux)

```bash
pkg install git nodejs
git clone https://github.com/sebastianfmarinay-code/the-mog.git
cd the-mog
npm install
npm start
```

Then open http://localhost:3000 in Chrome on the same phone. The camera only works on `localhost` or over `https://`.

## Configuration

All settings are optional environment variables.

| Variable | Default | What it does |
| --- | --- | --- |
| `PORT` | `3000` | Port the server listens on |
| `HOST` | `0.0.0.0` | Address the server binds to |
| `DATA_DIR` | `./data` | Where accounts, friendships, unopened snaps and stories are saved |
| `ICE_SERVERS` | Google public STUN | JSON array of WebRTC ICE servers, e.g. `[{"urls":"turn:turn.example.com:3478","username":"u","credential":"p"}]` |
| `TRUST_PROXY` | `false` | Set to `true` behind a reverse proxy so bans use the real client address |
| `INTEREST_FALLBACK_MS` | `8000` | How long someone with interests waits before being matched with anyone |
| `REPORT_THRESHOLD` | `3` | Number of different reporters needed to ban someone |
| `BAN_MINUTES` | `60` | How long a ban lasts |

## Deploying

- **HTTPS is required** for the camera anywhere other than `localhost`. Put the app behind a TLS proxy (Caddy, nginx, or your host's load balancer) that allows WebSocket upgrades on `/socket.io/`, and set `TRUST_PROXY=true`.
- **Add a TURN server for reliable video.** Some people are behind strict networks and need one, such as [coturn](https://github.com/coturn/coturn) or a hosted service. Set it with `ICE_SERVERS`. Snaps and text don't need it.
- **Run a single process.** The random-chat queue lives in memory, and accounts are stored in one JSON file. That's fine for a small site. For more traffic, move the data to a database and add the Socket.IO Redis adapter.
- **Back up the data folder.** `DATA_DIR` holds everyone's accounts. Profiles have no password, so losing the folder means everyone loses their username and friends.
- `GET /healthz` is a health check. `GET /api/stats` shows how many people are online and waiting.

## How it works

```
browser ──socket.io──► server.js ◄──socket.io── browser
             │  matchmaking · chat relay · WebRTC signalling
             │  accounts · friends · snaps · stories · streaks
             ▼
          data/db.json + data/media/   (snaps deleted once opened, stories after 24h)

browser ◄════════ WebRTC video/audio (peer-to-peer) ════════► browser
```

| Path | Role |
| --- | --- |
| `server.js` | Entry point: reads env vars and starts the server |
| `src/server.js` | Express + Socket.IO. Random chat, relay, signalling, rate limits, security headers |
| `src/social.js` | Accounts, friends, friend chat, snaps, stories, presence |
| `src/store.js` | Persistence (JSON file + image folder) and the streak rules |
| `src/matchmaker.js` | Interest-based pairing for random chat |
| `src/moderation.js` | Reports and temporary bans |
| `src/media.js`, `src/avatars.js` | Image upload checks; allowed avatar emoji and colours |
| `public/js/` | Frontend ES modules, no build step: `meet`, `camera`/`filters`, `camtab`, `editor`, `viewer`, `chats`, `stories`, `profile`, `main` |
| `test/` | `node:test` suites |

**Streak rule:** a day counts once you and a friend have each sent the other at least one snap that day (UTC). Consecutive days build the streak. Miss a day and it resets.
