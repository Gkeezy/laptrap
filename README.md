# Laptrap

Browser multiplayer **trap-racing** game. Race a lap on a **buildable** track, earn points, then everyone **simultaneously** places traps *or* track pieces. First to the target score who finishes **1st** wins.

Original game — not affiliated with any Steam title.

## Quick start (local)

```bash
npm install
npm run build
npm start
```

Open **http://localhost:3000**

### Development

```bash
npm install
npm run dev
```

## Create Room / share link

1. Host → **Create Room** → URL becomes `/?room=ABCD`
2. Share that link (2–**10** players)
3. Ready up; host starts

## Controls

| Action | Keyboard | Mobile |
|--------|----------|--------|
| Accelerate | W / ↑ | ▲ |
| Brake | S / ↓ | ▼ |
| Steer | A/D or ←/→ | ◀ ▶ |
| Boost | Space | BOOST |
| Place | Click + **Place** / Enter | Same |
| Skip place | Esc | Skip |

## Game loop

1. **Lobby** — up to 10 players
2. **Race** — one lap on the current track graph
3. **Results** — points by place (5/4/3/2/1/1/…)
4. **Build (simultaneous)** — ~25s timer; each player places **one** trap **or** track piece (straight / curve L / curve R) on a green socket, or skips. When everyone is done (or timer ends) → next race
5. Track **grows** when a new piece chain reconnects as a longer detour; shorter reconnects act as shortcuts
6. Win at target score (default 15) **and** finish 1st that race

## Deploy

### Render

Connect `Gkeezy/laptrap` → build `npm install && npm run build` → start `node dist-server/server/index.js` → health `/api/health`

### Docker

```bash
docker build -t laptrap .
docker run -p 3000:3000 -e PORT=3000 laptrap
```

### Share tonight

```bash
npm start
npx cloudflared tunnel --url http://localhost:3000
```

## Stack

Vite + TypeScript + Three.js client · Express + Socket.io rooms · ~20 Hz car snapshots with client interpolation

## License

MIT
