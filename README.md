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

## Track & hazards

- Starter is a **straight line**; **START** is fixed, **FINISH** follows the farthest tip.
- **No side rails** — drive off the asphalt and you’re out for the round (DNF).
- Place **utility** traps (barrier, ice, boost, ramp, oil) or **death** traps (bomb, spikes, mine).
- **Ramps** launch you into the air.

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
2. **Race** — drive from the fixed **START** line to the **FINISH** line (finish sits at the farthest tip of the main path and moves when you extend the track)
3. **Results** — points by place
4. **Build (simultaneous, ~25s)** — click to **select** one trap *or* track piece, then **click the map** to place it (exactly one item per player per round). Skip if you want.
5. Starter map is a **straight line** of 4 pieces with open sockets at both ends. Add curves to grow toward a loop; when a loop closes, start/finish share a gate.
6. Win at target score **and** finish 1st that race

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
