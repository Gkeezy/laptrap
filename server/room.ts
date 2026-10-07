import { randomBytes } from 'crypto';
import {
  CarState,
  Obstacle,
  ObstacleType,
  TrackPieceType,
  Phase,
  PlayerPublic,
  POINTS_BY_PLACE,
  RoomState,
  CarsUpdate,
  InputState,
  CAR_COLORS,
  DEFAULT_TARGET_SCORE,
  MAX_PLAYERS,
  MIN_PLAYERS,
  OBSTACLE_TYPES,
  TRACK_PIECE_TYPES,
  PLACE_DURATION_SEC,
} from '../shared/types.js';
import {
  TrackWorld,
  clampToTrack,
  createStarterTrack,
  getSpawnPose,
  isValidObstaclePlacement,
  placeTrackPiece,
  worldToProgress,
} from './track.js';

const SIM_HZ = 30;
const BROADCAST_HZ = 20;
const TICK_MS = 1000 / SIM_HZ;
const BROADCAST_MS = 1000 / BROADCAST_HZ;
const BOOST_MAX = 100;
const BOOST_COST = 30;
const BOOST_RECHARGE = 20;

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
  track: TrackWorld;
  countdown = 0;
  placeTimeLeft = 0;
  winnerId: string | null = null;
  finishOrder: string[] = [];
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private broadcastTimer: ReturnType<typeof setInterval> | null = null;
  private countdownTimer: ReturnType<typeof setInterval> | null = null;
  private placeTimer: ReturnType<typeof setInterval> | null = null;
  private emitState: (state: RoomState) => void;
  private emitCars: (update: CarsUpdate) => void;
  private obstacleSeq = 0;
  private raceStartedAt = 0;
  private prevDist = new Map<string, number>();
  private prevWp = new Map<string, number>();
  private maxWpReached = new Map<string, number>();

  constructor(
    code: string,
    hostId: string,
    hostName: string,
    targetScore: number,
    emitState: (s: RoomState) => void,
    emitCars: (u: CarsUpdate) => void,
  ) {
    this.code = code;
    this.hostId = hostId;
    this.targetScore = targetScore;
    this.emitState = emitState;
    this.emitCars = emitCars;
    this.track = createStarterTrack();
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
    if (this.players.size >= MAX_PLAYERS) return { ok: false, error: 'Room is full (10)' };
    if ([...this.players.values()].some((p) => p.name.toLowerCase() === name.toLowerCase())) {
      return { ok: false, error: 'Name taken' };
    }
    const colorIdx = this.players.size;
    this.players.set(id, {
      id,
      name: name.slice(0, 16) || 'Racer',
      color: CAR_COLORS[colorIdx % CAR_COLORS.length],
      score: 0,
      ready: false,
      connected: true,
      isHost: id === this.hostId,
      hasPlaced: false,
    });
    this.broadcast();
    return { ok: true };
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

    if (id === this.hostId) this.promoteHost();

    if (this.phase === 'placing') {
      p.hasPlaced = true;
      this.checkPlacingDone();
    }

    const connected = [...this.players.values()].filter((x) => x.connected).length;
    if (connected < 1) return true;
    if (connected < MIN_PLAYERS && this.phase !== 'gameover') {
      this.phase = 'gameover';
      this.stopSim();
      this.clearPlaceTimer();
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
    const othersReady = connected.filter((p) => p.id !== this.hostId).every((p) => p.ready);
    if (!othersReady) return { ok: false, error: 'All players must be ready' };
    for (const p of this.players.values()) p.ready = true;
    this.round = 0;
    this.obstacles = [];
    this.track = createStarterTrack();
    this.beginRace();
    return { ok: true };
  }

  private beginRace(): void {
    this.clearPlaceTimer();
    this.round += 1;
    this.finishOrder = [];
    this.winnerId = null;
    this.placeTimeLeft = 0;
    this.phase = 'countdown';
    this.countdown = 3;
    this.prevDist.clear();
    this.prevWp.clear();
    this.maxWpReached.clear();

    let i = 0;
    for (const p of this.players.values()) {
      p.hasPlaced = false;
      if (!p.connected) continue;
      const spawn = getSpawnPose(this.track, i++);
      const prog = worldToProgress(this.track, spawn.x, spawn.z, spawn.wpIndex);
      this.cars.set(p.id, {
        id: p.id,
        x: spawn.x,
        z: spawn.z,
        yaw: spawn.yaw,
        speed: 0,
        boost: BOOST_MAX,
        finished: false,
        finishPlace: null,
        lapProgress: prog.progress,
        checkpoint: Math.floor(prog.progress * 4) % 4,
        laps: 0,
        spinning: 0,
        icy: 0,
      });
      this.prevDist.set(p.id, prog.dist);
      this.prevWp.set(p.id, spawn.wpIndex);
      this.maxWpReached.set(p.id, spawn.wpIndex);
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
        this.startSim();
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

  private startSim(): void {
    this.stopSim();
    let last = Date.now();
    this.tickTimer = setInterval(() => {
      const now = Date.now();
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      this.simulate(dt);
    }, TICK_MS);

    this.broadcastTimer = setInterval(() => {
      this.emitCars(this.getCarsUpdate());
    }, BROADCAST_MS);
  }

  private stopSim(): void {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    if (this.broadcastTimer) {
      clearInterval(this.broadcastTimer);
      this.broadcastTimer = null;
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
        car.yaw += 6 * dt;
        car.speed *= Math.max(0, 1 - 1.2 * dt);
      } else {
        const turnRate = 2.6 + Math.min(Math.abs(car.speed) * 0.05, 1.2);
        if (input.left) car.yaw += turnRate * dt;
        if (input.right) car.yaw -= turnRate * dt;

        const accel = 30;
        const brake = 42;
        const maxSpeed = 46;
        const drag = car.icy > 0 ? 0.35 : 1.0;

        if (input.forward) car.speed += accel * dt;
        if (input.back) car.speed -= brake * dt;

        let boosting = false;
        if (input.boost && car.boost > 0 && car.speed > 4) {
          car.boost = Math.max(0, car.boost - BOOST_COST * dt);
          car.speed += 26 * dt;
          boosting = true;
        }
        if (!boosting) car.boost = Math.min(BOOST_MAX, car.boost + BOOST_RECHARGE * dt);

        if (car.icy > 0) {
          car.icy -= dt;
          car.yaw += Math.sin(Date.now() / 140 + car.id.length) * 0.5 * dt;
        }

        car.speed *= Math.max(0, 1 - drag * dt);
        if (!input.forward && !input.back && !boosting) {
          car.speed *= Math.max(0, 1 - 2.8 * dt);
        }
        car.speed = Math.max(-12, Math.min(maxSpeed + (boosting ? 18 : 0), car.speed));
      }

      const fx = Math.sin(car.yaw);
      const fz = Math.cos(car.yaw);
      car.x += fx * car.speed * dt;
      car.z += fz * car.speed * dt;

      const clamped = clampToTrack(this.track, car.x, car.z);
      if (clamped.hit) {
        car.x = clamped.x;
        car.z = clamped.z;
        car.speed *= 0.94;
      }

      for (const ob of this.obstacles) {
        const dx = car.x - ob.x;
        const dz = car.z - ob.z;
        const dist = Math.hypot(dx, dz);
        if (dist > 3.5) continue;
        switch (ob.type) {
          case 'barrier':
            if (dist < 2.2) {
              const nx = dx / (dist || 1);
              const nz = dz / (dist || 1);
              car.x = ob.x + nx * 2.2;
              car.z = ob.z + nz * 2.2;
              car.speed *= -0.25;
            }
            break;
          case 'ice':
            if (dist < 2.8) car.icy = Math.max(car.icy, 1.1);
            break;
          case 'boost':
            if (dist < 2.5) car.speed = Math.max(car.speed, 36);
            break;
          case 'ramp':
            if (dist < 2.5) car.speed += 6 * dt * 10;
            break;
          case 'oil':
            if (dist < 2.4) car.spinning = Math.max(car.spinning, 0.85);
            break;
        }
      }
    }

    // Soft car-car separation (less thrash)
    for (let i = 0; i < cars.length; i++) {
      for (let j = i + 1; j < cars.length; j++) {
        const a = cars[i];
        const b = cars[j];
        if (a.finished || b.finished) continue;
        const dx = b.x - a.x;
        const dz = b.z - a.z;
        const d = Math.hypot(dx, dz);
        if (d < 2.2 && d > 0.01) {
          const nx = dx / d;
          const nz = dz / d;
          const push = (2.2 - d) * 0.35;
          a.x -= nx * push;
          a.z -= nz * push;
          b.x += nx * push;
          b.z += nz * push;
          const avg = (a.speed + b.speed) * 0.5;
          a.speed = a.speed * 0.85 + avg * 0.1;
          b.speed = b.speed * 0.85 + avg * 0.1;
        }
      }
    }

    // Lap progress: monotonic waypoint index along main path
    const wpCount = this.track.waypoints.length || 1;
    for (const car of cars) {
      if (car.finished) continue;
      const hint = this.prevWp.get(car.id) ?? 0;
      const prog = worldToProgress(this.track, car.x, car.z, hint);
      const prevIdx = hint;
      const maxReached = this.maxWpReached.get(car.id) ?? 0;

      // Detect wrap: were near end, now near start, and had reached far enough
      const nearEnd = prevIdx >= wpCount * 0.7 || maxReached >= wpCount * 0.7;
      const nearStart = prog.wpIndex <= wpCount * 0.15;
      const wrapped = nearEnd && nearStart && prog.wpIndex < prevIdx;

      if (wrapped) {
        car.laps += 1;
        car.checkpoint = 0;
        this.maxWpReached.set(car.id, prog.wpIndex);
        if (car.laps >= 1) {
          car.finished = true;
          car.speed = 0;
          car.finishPlace = this.finishOrder.length + 1;
          this.finishOrder.push(car.id);
          this.checkRaceEnd();
        }
      } else {
        this.maxWpReached.set(car.id, Math.max(maxReached, prog.wpIndex));
        car.checkpoint = Math.floor((prog.wpIndex / wpCount) * 4) % 4;
      }

      car.lapProgress = prog.progress;
      this.prevDist.set(car.id, prog.dist);
      this.prevWp.set(car.id, prog.wpIndex);
    }

    if (this.raceStartedAt && Date.now() - this.raceStartedAt > 120000) {
      const unfinished = [...this.cars.values()]
        .filter((c) => !c.finished)
        .sort((a, b) => b.laps - a.laps || b.lapProgress - a.lapProgress);
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
    const active = [...this.cars.values()].filter((c) => this.players.get(c.id)?.connected);
    if (active.length > 0 && active.every((c) => c.finished)) {
      this.endRace();
    }
  }

  private endRace(): void {
    this.stopSim();
    const unfinished = [...this.cars.values()]
      .filter((c) => !c.finished)
      .sort((a, b) => b.laps - a.laps || b.lapProgress - a.lapProgress);
    for (const c of unfinished) {
      c.finished = true;
      c.finishPlace = this.finishOrder.length + 1;
      this.finishOrder.push(c.id);
    }

    this.finishOrder.forEach((id, idx) => {
      const p = this.players.get(id);
      if (p) p.score += POINTS_BY_PLACE[idx] ?? 0;
    });

    this.phase = 'results';
    this.broadcast();

    setTimeout(() => {
      if (this.phase !== 'results') return;
      const first = this.finishOrder[0];
      const fp = first ? this.players.get(first) : null;
      if (fp && fp.score >= this.targetScore) {
        this.phase = 'gameover';
        this.winnerId = fp.id;
        this.broadcast();
        return;
      }
      this.beginPlacing();
    }, 3000);
  }

  private beginPlacing(): void {
    this.phase = 'placing';
    this.placeTimeLeft = PLACE_DURATION_SEC;
    for (const p of this.players.values()) {
      p.hasPlaced = !p.connected;
    }
    this.broadcast();
    this.clearPlaceTimer();
    this.placeTimer = setInterval(() => {
      this.placeTimeLeft -= 1;
      if (this.placeTimeLeft <= 0) {
        this.placeTimeLeft = 0;
        this.finishPlacing();
      } else {
        this.broadcast();
      }
    }, 1000);
  }

  private clearPlaceTimer(): void {
    if (this.placeTimer) {
      clearInterval(this.placeTimer);
      this.placeTimer = null;
    }
  }

  private checkPlacingDone(): void {
    const need = [...this.players.values()].filter((p) => p.connected);
    if (need.length > 0 && need.every((p) => p.hasPlaced)) {
      this.finishPlacing();
    } else {
      this.broadcast();
    }
  }

  private finishPlacing(): void {
    this.clearPlaceTimer();
    if (this.phase !== 'placing') return;
    this.beginRace();
  }

  private markPlaced(id: string): void {
    const p = this.players.get(id);
    if (p) p.hasPlaced = true;
    this.checkPlacingDone();
  }

  placeObstacle(
    id: string,
    type: ObstacleType,
    x: number,
    z: number,
    yaw: number,
  ): { ok: boolean; error?: string } {
    if (this.phase !== 'placing') return { ok: false, error: 'Not placing phase' };
    const p = this.players.get(id);
    if (!p?.connected) return { ok: false, error: 'Not in room' };
    if (p.hasPlaced) return { ok: false, error: 'Already placed this round' };
    if (!OBSTACLE_TYPES.includes(type)) return { ok: false, error: 'Invalid type' };
    if (!isValidObstaclePlacement(this.track, x, z)) return { ok: false, error: 'Must place on track' };
    if (this.obstacles.length >= 40) return { ok: false, error: 'Too many obstacles' };

    this.obstacles.push({
      id: `ob-${++this.obstacleSeq}`,
      type,
      x,
      z,
      yaw,
      placedBy: id,
    });
    this.markPlaced(id);
    return { ok: true };
  }

  placeTrack(id: string, type: TrackPieceType, socketId: string): { ok: boolean; error?: string } {
    if (this.phase !== 'placing') return { ok: false, error: 'Not placing phase' };
    const p = this.players.get(id);
    if (!p?.connected) return { ok: false, error: 'Not in room' };
    if (p.hasPlaced) return { ok: false, error: 'Already placed this round' };
    if (!TRACK_PIECE_TYPES.includes(type)) return { ok: false, error: 'Invalid piece' };

    const result = placeTrackPiece(this.track, type, socketId, id);
    if (!result.ok) return result;
    this.markPlaced(id);
    return { ok: true };
  }

  skipPlace(id: string): void {
    if (this.phase !== 'placing') return;
    const p = this.players.get(id);
    if (!p || p.hasPlaced) return;
    this.markPlaced(id);
  }

  rematch(id: string): void {
    if (this.phase !== 'gameover') return;
    if (id !== this.hostId) return;
    for (const p of this.players.values()) {
      p.score = 0;
      p.ready = false;
      p.hasPlaced = false;
    }
    this.obstacles = [];
    this.track = createStarterTrack();
    this.round = 0;
    this.finishOrder = [];
    this.winnerId = null;
    this.cars.clear();
    this.phase = 'lobby';
    this.stopSim();
    this.clearCountdown();
    this.clearPlaceTimer();
    this.broadcast();
  }

  getCarsUpdate(): CarsUpdate {
    return {
      t: Date.now(),
      cars: [...this.cars.values()].map((c) => ({
        id: c.id,
        x: c.x,
        z: c.z,
        yaw: c.yaw,
        speed: c.speed,
        boost: c.boost,
        finished: c.finished,
        finishPlace: c.finishPlace,
        lapProgress: c.lapProgress,
        laps: c.laps,
        spinning: c.spinning,
        icy: c.icy,
      })),
    };
  }

  getState(): RoomState {
    return {
      code: this.code,
      phase: this.phase,
      players: [...this.players.values()],
      cars: [...this.cars.values()],
      obstacles: this.obstacles,
      trackPieces: this.track.pieces,
      trackSockets: this.track.sockets,
      targetScore: this.targetScore,
      round: this.round,
      placeTimeLeft: this.placeTimeLeft,
      countdown: this.countdown,
      winnerId: this.winnerId,
      finishOrder: this.finishOrder,
      hostId: this.hostId,
      serverTime: Date.now(),
    };
  }

  broadcast(): void {
    this.emitState(this.getState());
  }

  destroy(): void {
    this.stopSim();
    this.clearCountdown();
    this.clearPlaceTimer();
  }
}
