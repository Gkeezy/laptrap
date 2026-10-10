# Laptrap

Browser multiplayer **fruit foot-race** with traps. You play one of 10 little low-poly **running fruits** (apple, banana, orange, strawberry, watermelon slice, pineapple, grapes, lemon, cherry, pear). Run from START to FINISH on a **buildable** track, earn points, then everyone grabs one item from a **shared pick pool** (first click wins) and places it **at the same time**: traps go **anywhere on the map**, track pieces snap on. First to the target score who finishes **1st** wins.

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

Movement is tuned like running: quick acceleration, quick stop, and **eased steering** (input ramps in over about 0.25s; turn rate is 1.9 rad/s standing, down to 1.3 rad/s at top speed). **Space = jump** (replaces the old car boost). A hop clears barriers and spikes, and a jump over the edge that lands back on the asphalt is fine.

## Track & hazards

- Starter is a **straight line of 4 tiles** (each tile 22 long, so 88 units end to end) on **16-wide** asphalt (was 4 × 16 on 10-wide). The spawn grid is 5 lanes × 2 rows just past START, and the no-trap zone covers it (6 behind START to 18.5 ahead, 11 to each side). **START** is fixed, **FINISH** follows the farthest tip.
- **Track tiles** (geometry shared by server and client in `shared/pieces.ts`, so sockets, finish tracking, fall-off and progress always agree):

  | Tile | | What it does |
  |---|---|---|
  | Straight | ➖ | wide straight |
  | Curve L / R | ↩️ ↪️ | wide 90° turn (radius 20) |
  | Narrow | 🥢 | 6-wide straight, risky |
  | Plank Bridge | 🪵 | 33 long and only 3.5 wide |
  | Jump Gap | 🕳️ | ~7-unit hole in the middle: jump it (Space) |
  | S-Bend | 🐍 | chicane that shifts the course 10 units left |
  | Zigzag | 〽️ | wiggly 10-wide tile |
  | Fork | 🍴 | splits around a central hole and rejoins |
- **No side rails**: run off the asphalt and you actually **fall**. Once you drop **5 units below the track** you’re out for the round (DNF). Air time from jumps and ramps over the track never counts as falling.
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
3. **Results**: points by place. A race ends when everyone has finished or is out; once the first runner finishes, the rest have **15s** before they DNF (hard cap 120s).
4. **Pick (~15s)**: the server deals a random **shared pool of (players + 2)** items, a mix of traps and track pieces, always with at least 2 track pieces so the course keeps growing. Everyone sees the same pool; **click one to claim it**. First click wins (server-authoritative), and claimed cards show the taker's fruit and name. Anyone who hasn't picked when the timer ends gets a random leftover.
5. **Place (simultaneous, ~25s, ends early when all have placed)**: everyone places their claimed item: traps anywhere (R rotates), track tiles on a green socket. Esc skips.

### Map camera (PICK + PLACE)

Each build phase opens on a view from behind/above START looking down the course, so **FINISH is ahead (top of screen)** and the whole course is framed.

| Action | Control |
|---|---|
| Pan | Right-drag, or WASD / arrow keys |
| Zoom | Mouse wheel |
| Rotate / tilt | Q / E, or middle-drag (or Shift/Ctrl/Alt + right-drag) |
| Recenter | F (or C), or the ⟲ Recenter button |
| Place | Left-click (reserved; never pans) |
6. Starter map is a **straight line** of 4 pieces with open sockets at both ends. Add curves to grow toward a loop; when a loop closes, start/finish share a gate.
7. Win at target score **and** finish 1st that race

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
