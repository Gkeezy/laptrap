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
  FRUITS,
  PICK_DURATION_SEC,
  FINISH_GRACE_SEC,
  RACE_MAX_SEC,
  DEATH_DEPTH,
  RUN_TURN_RATE_MAX,
  MAP_HALF_SIZE,
  START_SAFE,
  DEFAULT_TARGET_SCORE,
  MAX_PLAYERS,
  MIN_PLAYERS,
  OBSTACLE_TYPES,
  TRACK_PIECE_TYPES,
  PLACE_DURATION_SEC,
} from '../shared/types.js';
import type { PickItem } from '../shared/types.js';
import {
  TrackWorld,
  createStarterTrack,
  crossedFinishLine,
  getMarkers,
  getSpawnPose,
  isOnAsphalt,
  placeTrackPiece,
  surfaceHeightAt,
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

const PLAIN_TILES: TrackPieceType[] = ['straight', 'curveL', 'curveR'];

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
  pickPool: PickItem[] = [];
  pickTimeLeft = 0;
  private pickTimer: ReturnType<typeof setInterval> | null = null;
  private pickSeq = 0;
  private firstFinishAt = 0;
  private lastGraceBroadcast = 0;
  private offGroundTicks = new Map<string, number>();
  private lastPoseAt = new Map<string, number>();

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
    const used = new Set([...this.players.values()].map((pl) => pl.fruit));
    const fruit = FRUITS.find((f) => !used.has(f.type)) ?? FRUITS[this.players.size % FRUITS.length];
    this.players.set(id, {
      id,
      name: name.slice(0, 16) || 'Runner',
      color: fruit.color,
      fruit: fruit.type,
      claim: null,
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
    if (this.phase === 'picking') this.checkPickingDone();
    // A runner leaving mid-race must not stall the round
    if (this.phase === 'racing') this.checkRaceEnd();

    const connected = [...this.players.values()].filter((x) => x.connected).length;
    if (connected < 1) return true;
    if (connected < MIN_PLAYERS && this.phase !== 'gameover') {
      this.phase = 'gameover';
      this.stopSim();
      this.clearPlaceTimer();
      this.clearPickTimer();
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
    this.clearPickTimer();
    this.pickPool = [];
    this.firstFinishAt = 0;
    this.offGroundTicks.clear();
    this.lastPoseAt.clear();
    for (const p of this.players.values()) p.claim = null;
    this.round += 1;
    this.finishOrder = [];
    this.winnerId = null;
    this.placeTimeLeft = 0;
    this.phase = 'countdown';
    this.countdown = 3;
    for (const ob of this.obstacles) ob.spent = false;
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
        y: 0,
        z: spawn.z,
        yaw: spawn.yaw,
        speed: 0,
        boost: BOOST_MAX,
        vy: 0,
        airborne: false,
        finished: false,
        eliminated: false,
        eliminateReason: null,
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
      this.inputs.set(p.id, { forward: false, back: false, left: false, right: false, jump: false });
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
      jump: !!input.jump,
    });
  }

  /** Client-authoritative pose with light validation */
  applyPose(id: string, pose: PoseUpdate): void {
    if (this.phase !== 'racing') return;
    const car = this.cars.get(id);
    if (!car || car.finished || car.eliminated) return;

    this.inputs.set(id, {
      forward: !!pose.input?.forward,
      back: !!pose.input?.back,
      left: !!pose.input?.left,
      right: !!pose.input?.right,
      jump: !!pose.input?.jump,
    });

    const dx = pose.x - car.x;
    const dz = pose.z - car.z;
    const step = Math.hypot(dx, dz);
    let x = pose.x;
    let z = pose.z;
    let y = pose.y ?? car.y;
    let yaw = pose.yaw;
    let speed = Math.max(-14, Math.min(MAX_POSE_SPEED, pose.speed || 0));
    let boost = Math.max(0, Math.min(BOOST_MAX, pose.boost ?? car.boost));
    let vy = pose.vy ?? car.vy;
    let airborne = !!pose.airborne;

    if (step > MAX_POSE_STEP) {
      const t = MAX_POSE_STEP / step;
      x = car.x + dx * t;
      z = car.z + dz * t;
    }

    // Turn-rate validation: keep yaw change within the running turn rate (spins excepted)
    const nowMs = Date.now();
    const lastAt = this.lastPoseAt.get(id) ?? nowMs - 50;
    this.lastPoseAt.set(id, nowMs);
    if (car.spinning <= 0) {
      const elapsed = Math.min(0.3, Math.max(0.016, (nowMs - lastAt) / 1000));
      const maxTurn = RUN_TURN_RATE_MAX * elapsed * 1.6 + 0.08;
      let dYaw = yaw - car.yaw;
      while (dYaw > Math.PI) dYaw -= Math.PI * 2;
      while (dYaw < -Math.PI) dYaw += Math.PI * 2;
      if (Math.abs(dYaw) > maxTurn) yaw = car.yaw + Math.sign(dYaw) * maxTurn;
    }

    const surf = surfaceHeightAt(this.track, this.obstacles, x, z);
    const onAsphalt = isOnAsphalt(this.track, x, z);
    // Ground exists under you only on asphalt or a ramp, and only if you haven't already dropped below it
    const hasGround = (onAsphalt || surf.onRamp) && y > -0.6;

    // Death plane: falling a short distance below the track = out for the round
    if (y < -DEATH_DEPTH + 0.05) {
      this.eliminate(car, 'Fell off the track');
      return;
    }
    // Standing "on air" off the asphalt (stale/old client): give ~0.5s then out
    if (!hasGround && !airborne && y > -0.3) {
      const n = (this.offGroundTicks.get(id) ?? 0) + 1;
      this.offGroundTicks.set(id, n);
      if (n > 10) {
        this.eliminate(car, 'Fell off the track');
        return;
      }
    } else {
      this.offGroundTicks.set(id, 0);
    }

    if (car.spinning > 0) {
      car.spinning = Math.max(0, car.spinning - 0.05);
      yaw += 0.3;
      speed *= 0.92;
    }

    for (const ob of this.obstacles) {
      if (ob.spent) continue;
      const od = Math.hypot(x - ob.x, z - ob.z);
      if (od > 4) continue;
      switch (ob.type) {
        case 'barrier':
          if (od < 2.2 && !airborne) {
            const nx = (x - ob.x) / (od || 1);
            const nz = (z - ob.z) / (od || 1);
            x = ob.x + nx * 2.2;
            z = ob.z + nz * 2.2;
            speed *= -0.2;
          }
          break;
        case 'ice':
          if (od < 2.8) car.icy = Math.max(car.icy, 1.0);
          break;
        case 'boost':
          if (od < 2.5) speed = Math.max(speed, 36);
          break;
        case 'oil':
          if (od < 2.4) car.spinning = Math.max(car.spinning, 0.7);
          break;
        case 'ramp':
          if (od < 3.2) {
            // Launch: upward velocity + forward kick
            if (surf.rampBoost > 0 && !airborne) {
              vy = Math.max(vy, surf.rampBoost * 0.55);
              speed = Math.max(speed, speed + 8);
              airborne = true;
              y = Math.max(y, surf.y + 0.2);
            } else if (surf.y > y) {
              y = surf.y;
            }
          }
          break;
        case 'bomb':
          if (od < 2.8) {
            ob.spent = true;
            this.eliminate(car, 'Blown up by a bomb');
            return;
          }
          break;
        case 'spikes':
          if (od < 2.4 && !airborne) {
            this.eliminate(car, 'Impaled on spikes');
            return;
          }
          break;
        case 'mine':
          if (od < 2.0) {
            ob.spent = true;
            this.eliminate(car, 'Hit a mine');
            return;
          }
          break;
      }
    }
    if (car.icy > 0) car.icy = Math.max(0, car.icy - 0.05);

    // Simple air settle on server for consistency
    if (!hasGround) {
      // falling: trust client's y (it integrates gravity); just mark airborne
      airborne = true;
    } else if (airborne || y > 0.05) {
      vy -= 28 * 0.05;
      y += vy * 0.05;
      if (y <= surf.y) {
        y = surf.y;
        vy = 0;
        airborne = false;
      } else {
        airborne = true;
      }
    } else {
      y = surf.y;
      vy = 0;
      airborne = false;
    }

    const prev = this.prevPos.get(id) ?? { x: car.x, z: car.z };
    car.x = x;
    car.y = y;
    car.z = z;
    car.yaw = yaw;
    car.speed = speed;
    car.boost = boost;
    car.vy = vy;
    car.airborne = airborne;

    const hint = this.prevWp.get(id) ?? 0;
    const prog = worldToProgress(this.track, x, z, hint);
    car.lapProgress = prog.progress;
    this.prevWp.set(id, prog.wpIndex);
    this.prevDist.set(id, prog.dist);

    if (prog.progress > 0.45) this.passedMid.set(id, true);

    const minProg = this.track.isLoop ? 0.55 : 0.72;
    if (
      !car.eliminated &&
      (this.passedMid.get(id) || prog.progress > minProg) &&
      crossedFinishLine(this.track, prev.x, prev.z, x, z, minProg, prog.progress)
    ) {
      car.finished = true;
      car.speed = 0;
      car.laps = 1;
      car.finishPlace = this.finishOrder.length + 1;
      this.finishOrder.push(id);
      if (!this.firstFinishAt) {
        this.firstFinishAt = Date.now();
        this.broadcast(); // clients start the grace countdown
      }
      this.checkRaceEnd();
    }

    this.prevPos.set(id, { x, z });
  }

  private eliminate(car: CarState, reason: string): void {
    if (car.eliminated || car.finished) return;
    car.eliminated = true;
    car.eliminateReason = reason;
    car.speed = 0;
    car.vy = 0;
    // Park below — clients hide/spectate
    car.y = -DEATH_DEPTH;
    // ROOT-CAUSE FIX: an elimination can be the last thing that ends a race
    this.checkRaceEnd();
  }

  private startSim(): void {
    this.stopSim();
    // Lightweight tick: soft car-car separation + timeout only (poses drive motion)
    this.tickTimer = setInterval(() => {
      this.safe('raceTick', () => {
        if (this.phase !== 'racing') return;
        this.softSeparate();
        const now = Date.now();
        if (this.firstFinishAt && now - this.firstFinishAt > FINISH_GRACE_SEC * 1000) {
          this.timeOutRace('Too slow (time up)');
        } else if (this.raceStartedAt && now - this.raceStartedAt > RACE_MAX_SEC * 1000) {
          this.timeOutRace('Race time limit');
        } else if (this.firstFinishAt && now - this.lastGraceBroadcast > 1000) {
          this.lastGraceBroadcast = now;
          this.broadcast();
        } else {
          // belt-and-braces: end if everyone is already done
          this.checkRaceEnd();
        }
      });
    }, TICK_MS);

    this.broadcastTimer = setInterval(() => {
      this.safe('carsBroadcast', () => this.emitCars(this.getCarsUpdate()));
    }, BROADCAST_MS);
  }

  private softSeparate(): void {
    const cars = [...this.cars.values()];
    for (let i = 0; i < cars.length; i++) {
      for (let j = i + 1; j < cars.length; j++) {
        const a = cars[i];
        const b = cars[j];
        if (a.finished || b.finished || a.eliminated || b.eliminated) continue;
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

  /** Run a timer/handler body without letting one exception kill the room loop. */
  private safe(label: string, fn: () => void): void {
    try {
      fn();
    } catch (err) {
      console.error(`[room ${this.code}] ${label} failed:`, err);
    }
  }

  /** Grace window / hard cap expired: everyone still running is a DNF. */
  private timeOutRace(reason: string): void {
    for (const c of this.cars.values()) {
      if (c.finished || c.eliminated) continue;
      c.eliminated = true;
      c.eliminateReason = reason;
      c.speed = 0;
    }
    this.raceStartedAt = 0;
    this.endRace();
  }

  private checkRaceEnd(): void {
    if (this.phase !== 'racing') return;
    const active = [...this.cars.values()].filter((c) => this.players.get(c.id)?.connected);
    if (active.length === 0) return;
    // Done when every connected car finished or was eliminated
    if (active.every((c) => c.finished || c.eliminated)) this.endRace();
  }

  private endRace(): void {
    if (this.phase !== 'racing') return; // never end twice
    this.stopSim();
    this.firstFinishAt = 0;
    // Survivors still racing → place by progress
    const unfinished = [...this.cars.values()]
      .filter((c) => !c.finished && !c.eliminated)
      .sort((a, b) => b.lapProgress - a.lapProgress);
    for (const c of unfinished) {
      c.finished = true;
      c.finishPlace = this.finishOrder.length + 1;
      this.finishOrder.push(c.id);
    }
    // DNFs last
    const dnfs = [...this.cars.values()]
      .filter((c) => c.eliminated && !this.finishOrder.includes(c.id))
      .sort((a, b) => b.lapProgress - a.lapProgress);
    for (const c of dnfs) {
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
      this.safe('beginPicking', () => this.beginPicking());
    }, 3000);
  }

  private beginPlacing(): void {
    this.phase = 'placing';
    this.placeTimeLeft = PLACE_DURATION_SEC;
    for (const p of this.players.values()) p.hasPlaced = !p.connected || !p.claim;
    this.broadcast();
    this.clearPlaceTimer();
    this.placeTimer = setInterval(() => this.safe('placeTimer', () => {
      this.placeTimeLeft -= 1;
      if (this.placeTimeLeft <= 0) {
        this.placeTimeLeft = 0;
        this.finishPlacing();
      } else {
        this.broadcast();
      }
    }), 1000);
    // everyone might already be done (no claims)
    this.checkPlacingDone();
  }

  /** Shared pool: (connected players + 2) options, always at least 2 track pieces. */
  private generatePool(): PickItem[] {
    const n = [...this.players.values()].filter((p) => p.connected).length + 2;
    const rnd = <T,>(arr: readonly T[]) => arr[Math.floor(Math.random() * arr.length)];
    const trackCount = Math.min(n, Math.max(2, Math.round(n * 0.35)));
    const items: PickItem[] = [];
    for (let i = 0; i < n; i++) {
      const isTrack = i < trackCount;
      items.push({
        id: `pk-${++this.pickSeq}`,
        kind: isTrack ? 'track' : 'trap',
        // first track slot is always a plain wide tile so the course stays runnable; the rest mix in specials
        type: isTrack ? (i === 0 ? rnd(PLAIN_TILES) : rnd(TRACK_PIECE_TYPES)) : rnd(OBSTACLE_TYPES),
        claimedBy: null,
      });
    }
    // shuffle so track pieces aren't always first
    for (let i = items.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [items[i], items[j]] = [items[j], items[i]];
    }
    return items;
  }

  private beginPicking(): void {
    this.phase = 'picking';
    for (const p of this.players.values()) {
      p.claim = null;
      p.hasPlaced = false;
    }
    this.pickPool = this.generatePool();
    this.pickTimeLeft = PICK_DURATION_SEC;
    this.broadcast();
    this.clearPickTimer();
    this.pickTimer = setInterval(() => this.safe('pickTimer', () => {
      this.pickTimeLeft -= 1;
      if (this.pickTimeLeft <= 0) {
        this.pickTimeLeft = 0;
        this.finishPicking();
      } else {
        this.broadcast();
      }
    }), 1000);
  }

  claimPick(id: string, itemId: string): { ok: boolean; error?: string } {
    if (this.phase !== 'picking') return { ok: false, error: 'Not pick phase' };
    const p = this.players.get(id);
    if (!p?.connected) return { ok: false, error: 'Not in room' };
    if (p.claim) return { ok: false, error: 'You already picked' };
    const item = this.pickPool.find((i) => i.id === itemId);
    if (!item) return { ok: false, error: 'No such item' };
    if (item.claimedBy) {
      const who = this.players.get(item.claimedBy)?.name ?? 'someone';
      return { ok: false, error: `Too slow — ${who} took it` };
    }
    item.claimedBy = id; // first click wins (Node is single-threaded: no race)
    p.claim = { kind: item.kind, type: item.type };
    this.checkPickingDone();
    return { ok: true };
  }

  private checkPickingDone(): void {
    if (this.phase !== 'picking') return;
    const need = [...this.players.values()].filter((p) => p.connected);
    if (need.length > 0 && need.every((p) => p.claim)) this.finishPicking();
    else this.broadcast();
  }

  /** Timer ran out or all picked: stragglers get a random leftover, then place phase. */
  private finishPicking(): void {
    if (this.phase !== 'picking') return;
    this.clearPickTimer();
    for (const p of this.players.values()) {
      if (!p.connected || p.claim) continue;
      const left = this.pickPool.filter((i) => !i.claimedBy);
      if (!left.length) break;
      const item = left[Math.floor(Math.random() * left.length)];
      item.claimedBy = p.id;
      p.claim = { kind: item.kind, type: item.type };
    }
    this.beginPlacing();
  }

  private clearPickTimer(): void {
    if (this.pickTimer) {
      clearInterval(this.pickTimer);
      this.pickTimer = null;
    }
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
    if (!p.claim || p.claim.kind !== 'trap' || p.claim.type !== type) return { ok: false, error: 'You can only place the item you picked' };
    const bad = this.validateTrapSpot(x, z);
    if (bad) return { ok: false, error: bad };
    if (this.obstacles.length >= 80) return { ok: false, error: 'Too many traps on the map' };

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

  /** Traps can go anywhere on the map, with sanity checks. Returns error string or null. */
  private validateTrapSpot(x: number, z: number): string | null {
    if (!Number.isFinite(x) || !Number.isFinite(z)) return 'Invalid position';
    // Map = at least +-MAP_HALF_SIZE, and always 80 units around the course as it grows
    const nearCourse = this.track.pieces.some((pc) => Math.hypot(pc.x - x, pc.z - z) < 80);
    if (!nearCourse && (Math.abs(x) > MAP_HALF_SIZE || Math.abs(z) > MAP_HALF_SIZE)) return 'Outside the map';
    // Protect START line + spawn grid (grid sits just past start along its heading)
    const s = getMarkers(this.track).start;
    const fx = Math.sin(s.yaw);
    const fz = Math.cos(s.yaw);
    const dx = x - s.x;
    const dz = z - s.z;
    const along = dx * fx + dz * fz;
    const lat = -dx * fz + dz * fx;
    if (along > -START_SAFE.back && along < START_SAFE.ahead && Math.abs(lat) < START_SAFE.halfWidth) return 'Too close to START / spawn area';
    // No stacking traps on top of each other
    for (const o of this.obstacles) {
      if (Math.hypot(o.x - x, o.z - z) < 3) return 'Too close to another trap';
    }
    return null;
  }

  placeTrack(id: string, type: TrackPieceType, socketId: string): { ok: boolean; error?: string } {
    if (this.phase !== 'placing') return { ok: false, error: 'Not placing phase' };
    const p = this.players.get(id);
    if (!p?.connected) return { ok: false, error: 'Not in room' };
    if (p.hasPlaced) return { ok: false, error: 'Already placed this round (one item only)' };
    if (!TRACK_PIECE_TYPES.includes(type)) return { ok: false, error: 'Invalid piece' };
    if (!p.claim || p.claim.kind !== 'track' || p.claim.type !== type) return { ok: false, error: 'You can only place the item you picked' };

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
      p.claim = null;
    }
    this.pickPool = [];
    this.clearPickTimer();
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
        y: c.y,
        z: c.z,
        yaw: c.yaw,
        speed: c.speed,
        boost: c.boost,
        vy: c.vy,
        airborne: c.airborne,
        finished: c.finished,
        eliminated: c.eliminated,
        eliminateReason: c.eliminateReason,
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
      pickTimeLeft: this.pickTimeLeft,
      pickPool: this.pickPool,
      graceLeftMs: this.firstFinishAt && this.phase === 'racing'
        ? Math.max(0, FINISH_GRACE_SEC * 1000 - (Date.now() - this.firstFinishAt))
        : 0,
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
    this.clearPickTimer();
    this.clearCountdown();
    this.clearPlaceTimer();
  }
}
