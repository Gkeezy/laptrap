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
  PoseUpdate,
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
  crossedFinishLine,
  getMarkers,
  getSpawnPose,
  isValidObstaclePlacement,
  placeTrackPiece,
  worldToProgress,
} from './track.js';

const SIM_HZ = 20;
const BROADCAST_HZ = 12;
const TICK_MS = 1000 / SIM_HZ;
const BROADCAST_MS = 1000 / BROADCAST_HZ;
const BOOST_MAX = 100;
const MAX_POSE_SPEED = 70;
const MAX_POSE_STEP = 18; // units per pose packet (~80ms)

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
  private prevPos = new Map<string, { x: number; z: number }>();
  private passedMid = new Map<string, boolean>();

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
    this.players.set(id, {
      id,
      name: name.slice(0, 16) || 'Racer',
      color: CAR_COLORS[this.players.size % CAR_COLORS.length],
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
    this.prevPos.clear();
    this.passedMid.clear();

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
        checkpoint: 0,
        laps: 0,
        spinning: 0,
        icy: 0,
      });
      this.prevDist.set(p.id, prog.dist);
      this.prevWp.set(p.id, spawn.wpIndex);
      this.prevPos.set(p.id, { x: spawn.x, z: spawn.z });
      this.passedMid.set(p.id, false);
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

  /** Client-authoritative pose with light validation */
  applyPose(id: string, pose: PoseUpdate): void {
    if (this.phase !== 'racing') return;
    const car = this.cars.get(id);
    if (!car || car.finished) return;

    this.inputs.set(id, {
      forward: !!pose.input?.forward,
      back: !!pose.input?.back,
      left: !!pose.input?.left,
      right: !!pose.input?.right,
      boost: !!pose.input?.boost,
    });

    const dx = pose.x - car.x;
    const dz = pose.z - car.z;
    const step = Math.hypot(dx, dz);
    let x = pose.x;
    let z = pose.z;
    let yaw = pose.yaw;
    let speed = Math.max(-14, Math.min(MAX_POSE_SPEED, pose.speed || 0));
    let boost = Math.max(0, Math.min(BOOST_MAX, pose.boost ?? car.boost));

    // Reject huge teleports — soft clamp toward claimed pose
    if (step > MAX_POSE_STEP) {
      const t = MAX_POSE_STEP / step;
      x = car.x + dx * t;
      z = car.z + dz * t;
    }

    const clamped = clampToTrack(this.track, x, z);
    if (clamped.hit) {
      x = clamped.x;
      z = clamped.z;
      speed *= 0.96;
    }

    // Obstacle interactions (server-side effects)
    if (car.spinning > 0) {
      car.spinning = Math.max(0, car.spinning - 0.05);
      yaw += 0.3;
      speed *= 0.92;
    }
    for (const ob of this.obstacles) {
      const od = Math.hypot(x - ob.x, z - ob.z);
      if (od > 3.5) continue;
      if (ob.type === 'barrier' && od < 2.2) {
        const nx = (x - ob.x) / (od || 1);
        const nz = (z - ob.z) / (od || 1);
        x = ob.x + nx * 2.2;
        z = ob.z + nz * 2.2;
        speed *= -0.2;
      } else if (ob.type === 'ice' && od < 2.8) {
        car.icy = Math.max(car.icy, 1.0);
      } else if (ob.type === 'boost' && od < 2.5) {
        speed = Math.max(speed, 34);
      } else if (ob.type === 'oil' && od < 2.4) {
        car.spinning = Math.max(car.spinning, 0.7);
      } else if (ob.type === 'ramp' && od < 2.5) {
        speed += 4;
      }
    }
    if (car.icy > 0) car.icy = Math.max(0, car.icy - 0.05);

    const prev = this.prevPos.get(id) ?? { x: car.x, z: car.z };
    car.x = x;
    car.z = z;
    car.yaw = yaw;
    car.speed = speed;
    car.boost = boost;

    const hint = this.prevWp.get(id) ?? 0;
    const prog = worldToProgress(this.track, x, z, hint);
    car.lapProgress = prog.progress;
    this.prevWp.set(id, prog.wpIndex);
    this.prevDist.set(id, prog.dist);

    if (prog.progress > 0.45) this.passedMid.set(id, true);

    const minProg = this.track.isLoop ? 0.55 : 0.72;
    if (
      (this.passedMid.get(id) || prog.progress > minProg) &&
      crossedFinishLine(this.track, prev.x, prev.z, x, z, minProg, prog.progress)
    ) {
      car.finished = true;
      car.speed = 0;
      car.laps = 1;
      car.finishPlace = this.finishOrder.length + 1;
      this.finishOrder.push(id);
      this.checkRaceEnd();
    }

    this.prevPos.set(id, { x, z });
  }

  private startSim(): void {
    this.stopSim();
    // Lightweight tick: soft car-car separation + timeout only (poses drive motion)
    this.tickTimer = setInterval(() => {
      this.softSeparate();
      if (this.raceStartedAt && Date.now() - this.raceStartedAt > 120000) {
        const unfinished = [...this.cars.values()]
          .filter((c) => !c.finished)
          .sort((a, b) => b.lapProgress - a.lapProgress);
        for (const c of unfinished) {
          c.finished = true;
          c.speed = 0;
          c.finishPlace = this.finishOrder.length + 1;
          this.finishOrder.push(c.id);
        }
        this.raceStartedAt = 0;
        this.endRace();
      }
    }, TICK_MS);

    this.broadcastTimer = setInterval(() => {
      this.emitCars(this.getCarsUpdate());
    }, BROADCAST_MS);
  }

  private softSeparate(): void {
    const cars = [...this.cars.values()];
    for (let i = 0; i < cars.length; i++) {
      for (let j = i + 1; j < cars.length; j++) {
        const a = cars[i];
        const b = cars[j];
        if (a.finished || b.finished) continue;
        const dx = b.x - a.x;
        const dz = b.z - a.z;
        const d = Math.hypot(dx, dz);
        if (d < 2.0 && d > 0.01) {
          const nx = dx / d;
          const nz = dz / d;
          const push = (2.0 - d) * 0.15; // gentle
          a.x -= nx * push;
          a.z -= nz * push;
          b.x += nx * push;
          b.z += nz * push;
        }
      }
    }
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

  private checkRaceEnd(): void {
    const active = [...this.cars.values()].filter((c) => this.players.get(c.id)?.connected);
    if (active.length > 0 && active.every((c) => c.finished)) this.endRace();
  }

  private endRace(): void {
    this.stopSim();
    const unfinished = [...this.cars.values()]
      .filter((c) => !c.finished)
      .sort((a, b) => b.lapProgress - a.lapProgress);
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
    for (const p of this.players.values()) p.hasPlaced = !p.connected;
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
    if (need.length > 0 && need.every((p) => p.hasPlaced)) this.finishPlacing();
    else this.broadcast();
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
    if (p.hasPlaced) return { ok: false, error: 'Already placed this round (one item only)' };
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
    if (p.hasPlaced) return { ok: false, error: 'Already placed this round (one item only)' };
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
      markers: getMarkers(this.track),
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
