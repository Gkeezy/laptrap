# Laptrap

Browser multiplayer **fruit foot-race** with traps. You play one of 10 little low-poly **running fruits** (apple, banana, orange, strawberry, watermelon slice, pineapple, grapes, lemon, cherry, pear). Run from START to FINISH on a **buildable** track, earn points, then everyone **simultaneously** places a trap (**anywhere on the map**) *or* a track piece. First to the target score who finishes **1st** wins.

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

## Runners

Each player gets a unique fruit (assigned on join, shown in the lobby and scoreboard). Fruits are built from Three.js primitives (original art) and have little legs with a speed-scaled **run cycle**, body **bounce + squash/stretch**, an **idle** breathing pose, and a **jump** pose (legs tucked, arms up).

Movement is tuned like running: quick acceleration, quick stop, snappy turning even at low speed. **Space = jump** (replaces the old car boost). A hop clears barriers and spikes, but you still have to land on the asphalt.

## Track & hazards

- Starter is a **straight line**; **START** is fixed, **FINISH** follows the farthest tip.
- **No side rails**: run off the asphalt and you’re out for the round (DNF).
- Place **utility** traps (barrier, ice, speed pad, ramp, oil) or **death** traps (bomb, spikes, mine).
- **Traps go anywhere**: the ghost follows your mouse, the ring turns green when the spot is valid, left-click places, R rotates. The server rejects spots outside the map (±200), inside the START/spawn zone, or within 3 units of another trap.
- **Ramps** launch you into the air.

## Controls

| Action | Keyboard | Mobile |
|--------|----------|--------|
| Run | W / ↑ | ▲ |
| Back up | S / ↓ | ▼ |
| Turn | A/D or ←/→ | ◀ ▶ |
| Jump | Space | JUMP |
| Place | Pick item, left-click map (R rotates trap) | Tap |
| Skip place | Esc | Skip |

## Game loop

1. **Lobby** — up to 10 players
2. **Run**: race on foot from the fixed **START** line to the **FINISH** line (finish sits at the farthest tip of the main path and moves when you extend the track)
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

Vite + TypeScript + Three.js client · Express + Socket.io rooms · client-authoritative local runner + 12 Hz snapshots with 100 ms interpolation for remote runners

## License

MIT
