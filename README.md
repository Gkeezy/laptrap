# Laptrap

Browser multiplayer **trap-racing** game. Race one lap, earn points, then place obstacles (barriers, ice, boost pads, ramps, oil slicks) for the next race. First to the target score who finishes **1st** wins.

Original game — not affiliated with any Steam title.

## Quick start (local)

```bash
npm install
npm run build
npm start
```

Open **http://localhost:3000**

### Development (hot reload)

```bash
npm install
npm run dev
```

- Client: http://localhost:5173 (proxies Socket.io to the server)
- Server: http://localhost:3000

## Create Room / share link

1. Host opens the site → enters a name → **Create Room**.
2. URL becomes `/?room=ABCD` (4-character code).
3. Copy the share link from the lobby (or just send the URL).
4. Friends open that **exact URL** to join (2–4 players).
5. Everyone clicks **Ready**; host clicks **Start Race**.

If the host disconnects, another connected player is promoted to host.

## Controls

| Action | Keyboard | Mobile |
|--------|----------|--------|
| Accelerate | W / ↑ | ▲ |
| Brake / reverse | S / ↓ | ▼ |
| Steer | A/D or ←/→ | ◀ ▶ |
| Boost | Space | BOOST |
| Place obstacle | Click track + **Place** (or Enter) | Same |
| Skip place | Esc / Skip | Skip |

## Game loop

1. **Lobby** — join, ready, host starts.
2. **Countdown** → **Racing** — one lap on an oval track.
3. **Results** — points: 1st=3, 2nd=2, 3rd=1, 4th=0.
4. **Placing** — each finisher (in finish order) places one obstacle.
5. Repeat until someone reaches the **target score** (default 9) **and** finishes 1st that race → **Game Over**.

## Deploy

### Render (recommended free tier)

1. Push this repo to GitHub.
2. Go to [render.com](https://render.com) → **New → Web Service**.
3. Connect the `laptrap` repo.
4. Render detects `render.yaml`, or set manually:
   - **Build:** `npm install && npm run build`
   - **Start:** `node dist-server/server/index.js`
   - **Health check:** `/api/health`
5. Deploy → open the `*.onrender.com` URL → Create Room → share `/?room=CODE`.

### Docker

```bash
docker build -t laptrap .
docker run -p 3000:3000 -e PORT=3000 laptrap
```

### Railway

New project from GitHub repo → set start command `node dist-server/server/index.js` → deploy.

### Share tonight without cloud deploy

Run locally, then expose with a tunnel:

```bash
npm start
# other terminal:
npx cloudflared tunnel --url http://localhost:3000
# or: ngrok http 3000
```

Send friends the tunnel URL + `/?room=CODE` (or create the room first and share the full link).

> **Note:** GitHub Pages cannot host the Socket.io server. Use Render/Railway/Docker or a tunnel.

## Stack

- **Client:** Vite, TypeScript, Three.js
- **Server:** Node, Express, Socket.io (authoritative rooms / phases / scores / placements)
- Single process serves the Vite build + WebSockets

## License

MIT — original code and art (procedural low-poly). No third-party game assets.
