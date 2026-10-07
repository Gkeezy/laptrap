import { randomBytes } from 'crypto';
import {
  CarState,
  Obstacle,
  ObstacleType,
  Phase,
  PlayerPublic,
  POINTS_BY_PLACE,
  RoomState,
  InputState,
  CAR_COLORS,
  DEFAULT_TARGET_SCORE,
  MAX_PLAYERS,
  MIN_PLAYERS,
  OBSTACLE_TYPES,
} from '../shared/types.js';
import {
  clampToTrack,
  getSpawnPose,
  isValidPlacement,
  worldToProgress,
} from './track.js';

const TICK_MS = 1000 / 30;
const BOOST_MAX = 100;
const BOOST_COST = 35; // per second
const BOOST_RECHARGE = 18;

function genCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  const bytes = randomBytes(4);
  for (let i = 0; i < 4; i++) code += alphabet[bytes[i] % alphabet.length];
  return code;
}

export class Room {
  code: string;
  phase: Phase = 'lobby';
  targetScore: number;
  round = 0;
  hostId: string;
  players = new Map<string, PlayerPublic>();
  cars = new Map<string, CarState>();
  inputs = new Map<string, InputState>();
  obstacles: Obstacle[] = [];
  placingQueue: string[] = [];
  placingPlayerId: string | null = null;
  countdown = 0;
  winnerId: string | null = null;
  finishOrder: string[] = [];
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private countdownTimer: ReturnType<typeof setInterval> | null = null;
  private emit: (state: RoomState) => void;
  private obstacleSeq = 0;
  private raceStartedAt = 0;

  constructor(code: string, hostId: string, hostName: string, targetScore: number, emit: (s: RoomState) => void) {
    this.code = code;
    this.hostId = hostId;
    this.targetScore = targetScore;
    this.emit = emit;
    this.addPlayer(hostId, hostName);
  }

  static createCode(existing: Set<string>): string {
    for (let i = 0; i < 50; i++) {
      const c = genCode();
      if (!existing.has(c)) return c;
    }
    return genCode() + genCode().slice(0, 2);
  }

  addPlayer(id: string, name: string): { ok: boolean; error?: string } {
    if (this.phase !== 'lobby') return { ok: false, error: 'Game already started' };
    if (this.players.size >= MAX_PLAYERS) return { ok: false, error: 'Room is full' };
    if ([...this.players.values()].some((p) => p.name.toLowerCase() === name.toLowerCase())) {
      return { ok: false, error: 'Name taken' };
    }
    const colorIdx = this.players.size;
    const player: PlayerPublic = {
      id,
      name: name.slice(0, 16) || 'Racer',
      color: CAR_COLORS[colorIdx % CAR_COLORS.length],
      score: 0,
      ready: false,
      connected: true,
      isHost: id === this.hostId,
    };
    this.players.set(id, player);
    this.broadcast();
    return { ok: true };
  }

  reconnect(id: string): void {
    const p = this.players.get(id);
    if (p) {
      p.connected = true;
      this.broadcast();
    }
  }

  removePlayer(id: string): boolean {
    const p = this.players.get(id);
    if (!p) return this.players.size === 0;
    p.connected = false;

    if (this.phase === 'lobby') {
      this.players.delete(id);
      this.cars.delete(id);
      this.inputs.delete(id);
      if (id === this.hostId) this.promoteHost();
      this.broadcast();
      return this.players.size === 0;
    }

    // Mid-game: mark disconnected, promote host if needed
    if (id === this.hostId) this.promoteHost();

    // If placing and it was their turn, skip
    if (this.phase === 'placing' && this.placingPlayerId === id) {
      this.advancePlacing();
    }

    // If fewer than 2 connected, end
    const connected = [...this.players.values()].filter((x) => x.connected).length;
    if (connected < 1) return true;
    if (connected < MIN_PLAYERS && this.phase !== 'gameover') {
      this.phase = 'gameover';
      this.stopTick();
      this.winnerId = [...this.players.values()].find((x) => x.connected)?.id ?? null;
      this.broadcast();
    } else {
      this.broadcast();
    }
    return false;
  }

  private promoteHost(): void {
    const next = [...this.players.values()].find((p) => p.connected && p.id !== this.hostId);
    if (next) {
      this.hostId = next.id;
      for (const p of this.players.values()) p.isHost = p.id === this.hostId;
    }
  }

  setReady(id: string, ready: boolean): void {
    const p = this.players.get(id);
    if (!p || this.phase !== 'lobby') return;
    p.ready = ready;
    this.broadcast();
  }

  startGame(requesterId: string): { ok: boolean; error?: string } {
    if (requesterId !== this.hostId) return { ok: false, error: 'Only host can start' };
    if (this.phase !== 'lobby') return { ok: false, error: 'Not in lobby' };
    const connected = [...this.players.values()].filter((p) => p.connected);
    if (connected.length < MIN_PLAYERS) return { ok: false, error: `Need at least ${MIN_PLAYERS} players` };
    if (!connected.every((p) => p.ready || p.id === this.hostId)) {
      // Allow host to start if all others ready; host auto-ready
      const othersReady = connected.filter((p) => p.id !== this.hostId).every((p) => p.ready);
      if (!othersReady) return { ok: false, error: 'All players must be ready' };
    }
    for (const p of this.players.values()) p.ready = true;
    this.round = 0;
    this.obstacles = [];
    this.beginRace();
    return { ok: true };
  }

  private beginRace(): void {
    this.round += 1;
    this.finishOrder = [];
    this.winnerId = null;
    this.placingQueue = [];
    this.placingPlayerId = null;
    this.phase = 'countdown';
    this.countdown = 3;

    let i = 0;
    for (const p of this.players.values()) {
      if (!p.connected) continue;
      const spawn = getSpawnPose(i++);
      const startProg = worldToProgress(spawn.x, spawn.z);
      this.cars.set(p.id, {
        id: p.id,
        x: spawn.x,
        z: spawn.z,
        yaw: spawn.yaw,
        speed: 0,
        boost: BOOST_MAX,
        finished: false,
        finishPlace: null,
        lapProgress: startProg,
        checkpoint: Math.floor(startProg * 4) % 4,
        laps: 0,
        spinning: 0,
        icy: 0,
      });
      this.inputs.set(p.id, { forward: false, back: false, left: false, right: false, boost: false });
    }

    this.broadcast();
    this.clearCountdown();
    this.countdownTimer = setInterval(() => {
      this.countdown -= 1;
      if (this.countdown <= 0) {
        this.clearCountdown();
        this.phase = 'racing';
        this.countdown = 0;
        this.raceStartedAt = Date.now();
        this.startTick();
        this.broadcast();
      } else {
        this.broadcast();
      }
    }, 1000);
  }

  private clearCountdown(): void {
    if (this.countdownTimer) {
      clearInterval(this.countdownTimer);
      this.countdownTimer = null;
    }
  }

  setInput(id: string, input: InputState): void {
    if (this.phase !== 'racing') return;
    if (!this.cars.has(id)) return;
    this.inputs.set(id, {
      forward: !!input.forward,
      back: !!input.back,
      left: !!input.left,
      right: !!input.right,
      boost: !!input.boost,
    });
  }

  private startTick(): void {
    this.stopTick();
    let last = Date.now();
    this.tickTimer = setInterval(() => {
      const now = Date.now();
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      this.simulate(dt);
      this.broadcast();
    }, TICK_MS);
  }

  private stopTick(): void {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
  }

  private simulate(dt: number): void {
    const cars = [...this.cars.values()];

    for (const car of cars) {
      if (car.finished) continue;
      const input = this.inputs.get(car.id) ?? {
        forward: false, back: false, left: false, right: false, boost: false,
      };

      if (car.spinning > 0) {
        car.spinning -= dt;
        car.yaw += 8 * dt;
        car.speed *= Math.max(0, 1 - 1.5 * dt);
      } else {
        const turnRate = 2.8 + Math.min(Math.abs(car.speed) * 0.06, 1.4);
        if (input.left) car.yaw += turnRate * dt;
        if (input.right) car.yaw -= turnRate * dt;

        const accel = 32;
        const brake = 45;
        const maxSpeed = 48;
        const drag = car.icy > 0 ? 0.4 : 1.2;

        if (input.forward) car.speed += accel * dt;
        if (input.back) car.speed -= brake * dt;

        let boosting = false;
        if (input.boost && car.boost > 0 && car.speed > 4) {
          car.boost = Math.max(0, car.boost - BOOST_COST * dt);
          car.speed += 28 * dt;
          boosting = true;
        }
        if (!boosting) car.boost = Math.min(BOOST_MAX, car.boost + BOOST_RECHARGE * dt);

        if (car.icy > 0) {
          car.icy -= dt;
          car.yaw += (Math.sin(Date.now() / 120 + car.id.length) * 0.8) * dt;
        }

        // Exponential drag toward coast
        car.speed *= Math.max(0, 1 - drag * dt);
        if (!input.forward && !input.back && !boosting) {
          car.speed *= Math.max(0, 1 - 3 * dt);
        }
        car.speed = Math.max(-14, Math.min(maxSpeed + (boosting ? 20 : 0), car.speed));
      }

      // Forward vector: yaw 0 faces +Z
      const fx = Math.sin(car.yaw);
      const fz = Math.cos(car.yaw);
      car.x += fx * car.speed * dt;
      car.z += fz * car.speed * dt;

      // Walls — slide along ring instead of killing speed
      const beforeX = car.x;
      const beforeZ = car.z;
      const clamped = clampToTrack(car.x, car.z);
      if (clamped.x !== beforeX || clamped.z !== beforeZ) {
        car.x = clamped.x;
        car.z = clamped.z;
        // Cancel only the outward radial component of velocity
        const r = Math.hypot(car.x, car.z) || 1;
        const nx = car.x / r;
        const nz = car.z / r;
        const radialVel = (fx * nx + fz * nz) * car.speed;
        if (radialVel > 0 && r > 30) car.speed *= 0.92;
        else if (radialVel < 0 && r < 26) car.speed *= 0.92;
        // Nudge yaw toward tangent so arcade driving recovers
        const a = Math.atan2(car.z, car.x);
        const want = Math.atan2(-Math.sin(a), Math.cos(a));
        let dy = want - car.yaw;
        while (dy > Math.PI) dy -= Math.PI * 2;
        while (dy < -Math.PI) dy += Math.PI * 2;
        car.yaw += dy * 0.08;
      }

      // Obstacles
      for (const ob of this.obstacles) {
        const dx = car.x - ob.x;
        const dz = car.z - ob.z;
        const dist = Math.hypot(dx, dz);
        if (dist > 3.5) continue;
        switch (ob.type) {
          case 'barrier':
            if (dist < 2.2) {
              // push out
              const nx = dx / (dist || 1);
              const nz = dz / (dist || 1);
              car.x = ob.x + nx * 2.2;
              car.z = ob.z + nz * 2.2;
              car.speed *= -0.3;
            }
            break;
          case 'ice':
            if (dist < 2.8) car.icy = Math.max(car.icy, 1.2);
            break;
          case 'boost':
            if (dist < 2.5) car.speed = Math.max(car.speed, 38);
            break;
          case 'ramp':
            if (dist < 2.5) car.speed = Math.max(car.speed, car.speed + 8);
            break;
          case 'oil':
            if (dist < 2.4) car.spinning = Math.max(car.spinning, 1.0);
            break;
        }
      }
    }

    // Car-car bumps
    for (let i = 0; i < cars.length; i++) {
      for (let j = i + 1; j < cars.length; j++) {
        const a = cars[i];
        const b = cars[j];
        if (a.finished || b.finished) continue;
        const dx = b.x - a.x;
        const dz = b.z - a.z;
        const d = Math.hypot(dx, dz);
        if (d < 2.4 && d > 0.01) {
          const nx = dx / d;
          const nz = dz / d;
          const overlap = 2.4 - d;
          a.x -= nx * overlap * 0.5;
          a.z -= nz * overlap * 0.5;
          b.x += nx * overlap * 0.5;
          b.z += nz * overlap * 0.5;
          const av = a.speed;
          a.speed = a.speed * 0.7 + b.speed * 0.15;
          b.speed = b.speed * 0.7 + av * 0.15;
        }
      }
    }

    // Lap / finish
    for (const car of cars) {
      if (car.finished) continue;
      const prog = worldToProgress(car.x, car.z);
      const prev = car.lapProgress;
      const prevCheckpoint = car.checkpoint;

      // Forward wrap across start/finish — use checkpoint from BEFORE sector update
      const wrappedForward = prev - prog > 0.5;
      if (wrappedForward && prevCheckpoint >= 2) {
        car.laps += 1;
        car.checkpoint = 0;
        if (car.laps >= 1) {
          car.finished = true;
          car.speed = 0;
          car.finishPlace = this.finishOrder.length + 1;
          this.finishOrder.push(car.id);
          this.checkRaceEnd();
        }
      } else {
        // Advance sector checkpoints only forward
        const sector = Math.floor(prog * 4) % 4;
        const expected = (car.checkpoint + 1) % 4;
        if (sector === expected) {
          car.checkpoint = sector;
        }
      }
      car.lapProgress = prog;
    }

    if (this.raceStartedAt && Date.now() - this.raceStartedAt > 90000) {
      const unfinished = [...this.cars.values()].filter((c) => !c.finished);
      unfinished.sort((a, b) => b.laps - a.laps || b.lapProgress - a.lapProgress);
      for (const c of unfinished) {
        c.finished = true;
        c.speed = 0;
        c.finishPlace = this.finishOrder.length + 1;
        this.finishOrder.push(c.id);
      }
      this.raceStartedAt = 0;
      this.endRace();
    }
  }

  private checkRaceEnd(): void {
    const active = [...this.cars.values()].filter((c) => {
      const p = this.players.get(c.id);
      return p?.connected;
    });
    if (active.every((c) => c.finished) || this.finishOrder.length >= active.length) {
      this.endRace();
    }
    // Also end if only one left unfinished for too long — give them last place after all others done
    // Already handled by every finished.
  }

  private endRace(): void {
    this.stopTick();
    // Assign places for unfinished
    const unfinished = [...this.cars.values()]
      .filter((c) => !c.finished)
      .sort((a, b) => b.lapProgress - a.lapProgress);
    for (const c of unfinished) {
      c.finished = true;
      c.finishPlace = this.finishOrder.length + 1;
      this.finishOrder.push(c.id);
    }

    // Award points
    this.finishOrder.forEach((id, idx) => {
      const p = this.players.get(id);
      if (p) p.score += POINTS_BY_PLACE[idx] ?? 0;
    });

    this.phase = 'results';
    this.broadcast();

    // After short results, check win or go to placing
    setTimeout(() => {
      if (this.phase !== 'results') return;
      const winner = [...this.players.values()].find((p) => p.score >= this.targetScore);
      if (winner) {
        // Must finish 1st this race to win — check if they got 1st
        if (this.finishOrder[0] === winner.id) {
          this.phase = 'gameover';
          this.winnerId = winner.id;
          this.broadcast();
          return;
        }
        // Someone reached target but didn't finish 1st — continue (or simplify: first to target wins)
        // Spec says: "they must finish 1st next race to win (or simplify: first to target wins)"
        // We'll use: first to reach target AND finish 1st in that race, OR if already at/above and get 1st later.
        // Actually re-read: "then they must finish 1st next race to win"
        // So if they hit target mid-results without being 1st this race, they need 1st next time.
      }

      // Anyone at target who got 1st this round wins
      const first = this.finishOrder[0];
      const fp = first ? this.players.get(first) : null;
      if (fp && fp.score >= this.targetScore) {
        this.phase = 'gameover';
        this.winnerId = fp.id;
        this.broadcast();
        return;
      }

      // Placing phase — finish order places obstacles
      this.placingQueue = [...this.finishOrder];
      this.phase = 'placing';
      this.placingPlayerId = this.placingQueue[0] ?? null;
      this.broadcast();

      // Auto-skip disconnected placers
      this.ensurePlacerConnected();
    }, 3500);
  }

  private ensurePlacerConnected(): void {
    while (this.placingPlayerId) {
      const p = this.players.get(this.placingPlayerId);
      if (p?.connected) break;
      this.advancePlacing();
    }
  }

  placeObstacle(
    id: string,
    type: ObstacleType,
    x: number,
    z: number,
    yaw: number,
  ): { ok: boolean; error?: string } {
    if (this.phase !== 'placing') return { ok: false, error: 'Not placing phase' };
    if (id !== this.placingPlayerId) return { ok: false, error: 'Not your turn' };
    if (!OBSTACLE_TYPES.includes(type)) return { ok: false, error: 'Invalid type' };
    if (!isValidPlacement(x, z)) return { ok: false, error: 'Invalid position' };
    // Limit total obstacles
    if (this.obstacles.length >= 24) return { ok: false, error: 'Too many obstacles' };

    this.obstacles.push({
      id: `ob-${++this.obstacleSeq}`,
      type,
      x,
      z,
      yaw,
      placedBy: id,
    });
    this.advancePlacing();
    return { ok: true };
  }

  skipPlace(id: string): void {
    if (this.phase !== 'placing') return;
    if (id !== this.placingPlayerId) return;
    this.advancePlacing();
  }

  private advancePlacing(): void {
    this.placingQueue.shift();
    this.placingPlayerId = this.placingQueue[0] ?? null;
    if (!this.placingPlayerId) {
      this.beginRace();
    } else {
      this.ensurePlacerConnected();
      this.broadcast();
    }
  }

  rematch(id: string): void {
    if (this.phase !== 'gameover') return;
    if (id !== this.hostId) return;
    for (const p of this.players.values()) {
      p.score = 0;
      p.ready = false;
    }
    this.obstacles = [];
    this.round = 0;
    this.finishOrder = [];
    this.winnerId = null;
    this.placingQueue = [];
    this.placingPlayerId = null;
    this.cars.clear();
    this.phase = 'lobby';
    this.stopTick();
    this.clearCountdown();
    this.broadcast();
  }

  getState(): RoomState {
    return {
      code: this.code,
      phase: this.phase,
      players: [...this.players.values()],
      cars: [...this.cars.values()],
      obstacles: this.obstacles,
      targetScore: this.targetScore,
      round: this.round,
      placingPlayerId: this.placingPlayerId,
      placingQueue: this.placingQueue,
      countdown: this.countdown,
      winnerId: this.winnerId,
      finishOrder: this.finishOrder,
      hostId: this.hostId,
    };
  }

  broadcast(): void {
    this.emit(this.getState());
  }

  destroy(): void {
    this.stopTick();
    this.clearCountdown();
  }
}
