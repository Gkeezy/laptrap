import * as THREE from 'three';
import { makeFruit, animateFruit, estimateRemoteSpeed } from './Fruit';
import { sampleTile, tileSteps, onAsphalt as tileOnAsphalt, TILE_SPECS, leftVec, forwardVec } from '../../../shared/pieces';
import type {
  CarState,
  CarsUpdate,
  InputState,
  Obstacle,
  PlayerPublic,
  RaceMarkers,
  RoomState,
  TrackPiece,
  TrackSocket,
} from '../../../shared/types';
import {
  TRACK, MAP_HALF_SIZE, START_SAFE, DEATH_DEPTH, RUN_TURN_RATE_MAX, RUN_TURN_RATE_MIN, STEER_EASE_IN, STEER_EASE_OUT,
} from '../../../shared/types';

/** Grass sits well below the track so a fall off the edge is visible before the death plane */
const GROUND_Y = -(DEATH_DEPTH + 4);
/** Client lane tolerance is a hair stricter than the server's (0.35) so it starts falling first */
const ASPHALT_TOL = 0.25;

interface Snapshot {
  x: number;
  z: number;
  yaw: number;
  t: number;
}

interface CarRender {
  mesh: THREE.Group;
  buffer: Snapshot[];
  localX: number;
  localY: number;
  localZ: number;
  localYaw: number;
  localSpeed: number;
  localBoost: number;
  padBoost: number;
  steer: number;
  localVy: number;
  airborne: boolean;
  spinning: number;
  icy: number;
  initialized: boolean;
  eliminated: boolean;
}

function lerpAngle(a: number, b: number, t: number): number {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}


export class GameScene {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  private cars = new Map<string, CarRender>();
  private obstacleMeshes = new Map<string, THREE.Object3D>();
  private pieceMeshes = new Map<string, THREE.Object3D>();
  private socketMeshes = new Map<string, THREE.Object3D>();
  private placeMarker: THREE.Group | null = null;
  private startGate: THREE.Group | null = null;
  private finishGate: THREE.Group | null = null;
  private animId = 0;
  private jumpHeld = false;
  frameErrors = 0;
  private lastFrame = performance.now();
  private ghostType: Obstacle['type'] | null = null;
  private ghostPreview: THREE.Object3D | null = null;
  private ghostRing: THREE.Mesh | null = null;
  private markersCache: RaceMarkers | null = null;
  ghostValid = true;
  private localId = '';
  private players = new Map<string, PlayerPublic>();
  canvas: HTMLCanvasElement;
  ghostPos = { x: 0, z: 0, yaw: 0 };
  placing = false;
  selectedSocketId: string | null = null;
  private sockets: TrackSocket[] = [];
  private pieces: TrackPiece[] = [];
  private camTarget = new THREE.Vector3(0, 40, 50);
  private camLook = new THREE.Vector3(0, 0, 0);
  private renderDelayMs = 100; // interpolation delay for remotes
  racing = false;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.setSize(canvas.clientWidth || innerWidth, canvas.clientHeight || innerHeight, false);
    this.renderer.setClearColor(0x87b5e0);
    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.Fog(0x87b5e0, 170, 560);
    this.camera = new THREE.PerspectiveCamera(55, 1, 0.1, 900);
    this.camera.position.set(0, 40, 50);

    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(1400, 1400),
      new THREE.MeshLambertMaterial({ color: 0x3d8c40 }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = GROUND_Y;
    this.scene.add(ground);
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.55));
    const sun = new THREE.DirectionalLight(0xfff2d6, 1.05);
    sun.position.set(40, 60, 20);
    this.scene.add(sun);

    this.onResize();
    window.addEventListener('resize', () => this.onResize());
  }

  setLocalId(id: string): void {
    this.localId = id;
  }

  onResize(): void {
    const w = this.canvas.clientWidth || innerWidth;
    const h = this.canvas.clientHeight || innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  private makeObstacle(type: Obstacle['type']): THREE.Object3D {
    switch (type) {
      case 'barrier': {
        const m = new THREE.Mesh(new THREE.BoxGeometry(2.4, 1.2, 0.6), new THREE.MeshLambertMaterial({ color: 0xe67e22 }));
        m.position.y = 0.6;
        return m;
      }
      case 'ice': {
        const m = new THREE.Mesh(
          new THREE.CylinderGeometry(2.2, 2.2, 0.12, 20),
          new THREE.MeshLambertMaterial({ color: 0xa8e6ff, transparent: true, opacity: 0.85 }),
        );
        m.position.y = 0.12;
        return m;
      }
      case 'boost': {
        const m = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.1, 2.8), new THREE.MeshLambertMaterial({ color: 0x2ecc71 }));
        m.position.y = 0.1;
        return m;
      }
      case 'ramp': {
        const g = new THREE.Group();
        // Wedge ramp mesh
        const shape = new THREE.Shape();
        shape.moveTo(0, 0);
        shape.lineTo(4.5, 0);
        shape.lineTo(4.5, 0.15);
        shape.lineTo(0, 2.2);
        shape.lineTo(0, 0);
        const geo = new THREE.ExtrudeGeometry(shape, { depth: 3.6, bevelEnabled: false });
        geo.rotateY(-Math.PI / 2);
        geo.translate(0, 0, -1.8);
        const m = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ color: 0x9b59b6 }));
        g.add(m);
        // Arrow paint
        const arrow = new THREE.Mesh(
          new THREE.BoxGeometry(0.4, 0.08, 2.2),
          new THREE.MeshBasicMaterial({ color: 0xf1c40f }),
        );
        arrow.position.set(0, 1.1, 0.2);
        arrow.rotation.x = -0.4;
        g.add(arrow);
        return g;
      }
      case 'oil': {
        const m = new THREE.Mesh(
          new THREE.CylinderGeometry(2.0, 2.0, 0.08, 16),
          new THREE.MeshLambertMaterial({ color: 0x1a1a1a, transparent: true, opacity: 0.9 }),
        );
        m.position.y = 0.08;
        return m;
      }
      case 'bomb': {
        const g = new THREE.Group();
        const body = new THREE.Mesh(
          new THREE.SphereGeometry(0.85, 16, 12),
          new THREE.MeshLambertMaterial({ color: 0x222222 }),
        );
        body.position.y = 0.85;
        g.add(body);
        const fuse = new THREE.Mesh(
          new THREE.CylinderGeometry(0.08, 0.08, 0.5, 6),
          new THREE.MeshLambertMaterial({ color: 0xc0392b }),
        );
        fuse.position.y = 1.85;
        g.add(fuse);
        return g;
      }
      case 'spikes': {
        const g = new THREE.Group();
        const base = new THREE.Mesh(
          new THREE.BoxGeometry(3.2, 0.15, 3.2),
          new THREE.MeshLambertMaterial({ color: 0x7f8c8d }),
        );
        base.position.y = 0.08;
        g.add(base);
        for (let i = -1; i <= 1; i++) {
          for (let j = -1; j <= 1; j++) {
            const spike = new THREE.Mesh(
              new THREE.ConeGeometry(0.35, 1.4, 6),
              new THREE.MeshLambertMaterial({ color: 0xbdc3c7 }),
            );
            spike.position.set(i * 1.0, 0.8, j * 1.0);
            g.add(spike);
          }
        }
        return g;
      }
      case 'mine': {
        const g = new THREE.Group();
        const disc = new THREE.Mesh(
          new THREE.CylinderGeometry(1.1, 1.1, 0.25, 16),
          new THREE.MeshLambertMaterial({ color: 0x27ae60 }),
        );
        disc.position.y = 0.15;
        g.add(disc);
        const skull = new THREE.Mesh(
          new THREE.SphereGeometry(0.35, 10, 8),
          new THREE.MeshLambertMaterial({ color: 0xf1c40f }),
        );
        skull.position.y = 0.45;
        g.add(skull);
        return g;
      }
    }
  }

  private makePieceMesh(piece: TrackPiece): THREE.Object3D {
    const g = new THREE.Group();
    const samples = sampleTile(piece, tileSteps(piece.type, 10));
    const spec = TILE_SPECS[piece.type];
    const color = piece.type === 'plank' ? 0x8b5a2b : piece.onMainPath ? 0x2a2e35 : 0x3a4555;
    const mat = new THREE.MeshLambertMaterial({ color });
    const dashMat = new THREE.MeshBasicMaterial({ color: 0xf5d76e });
    const warnMat = new THREE.MeshBasicMaterial({ color: 0xe23b2e });
    let prevHadLanes = true;
    for (let i = 0; i < samples.length - 1; i++) {
      const a = samples[i];
      const b = samples[i + 1];
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const len = Math.hypot(dx, dz) || 0.01;
      const yaw = Math.atan2(dx, dz);
      const sMid = (a.s + b.s) / 2;
      const lanes = spec.lanes(sMid);
      const l = leftVec(yaw);
      const mx = (a.x + b.x) / 2;
      const mz = (a.z + b.z) / 2;
      for (const [lo, hi] of lanes) {
        const off = (lo + hi) / 2;
        const seg = new THREE.Mesh(new THREE.BoxGeometry(hi - lo, 0.16, len + 0.06), mat);
        seg.position.set(mx + l.x * off, 0.08, mz + l.z * off);
        seg.rotation.y = yaw;
        g.add(seg);
      }
      // red warning bars at the edges of holes (jump gap)
      if (lanes.length === 0 && prevHadLanes || lanes.length > 0 && !prevHadLanes) {
        const bar = new THREE.Mesh(new THREE.BoxGeometry(TRACK.width, 0.2, 0.5), warnMat);
        bar.position.set(a.x, 0.12, a.z);
        bar.rotation.y = yaw;
        g.add(bar);
      }
      prevHadLanes = lanes.length > 0;
      const centerLane = lanes.some(([lo, hi]) => lo < -0.5 && hi > 0.5);
      if (centerLane && piece.type !== 'plank' && i % 3 === 0) {
        const dash = new THREE.Mesh(new THREE.BoxGeometry(0.25, 0.05, Math.min(1.4, len * 0.9)), dashMat);
        dash.position.set(mx, 0.18, mz);
        dash.rotation.y = yaw;
        g.add(dash);
      }
    }
    return g;
  }

  private makeGate(label: string, color: number): THREE.Group {
    const g = new THREE.Group();
    // Checkered strip
    const strip = new THREE.Group();
    const cols = 8;
    const cellW = TRACK.width / cols;
    for (let i = 0; i < cols; i++) {
      const c = (i % 2 === 0) ? 0xffffff : 0x111111;
      const cell = new THREE.Mesh(
        new THREE.BoxGeometry(cellW * 0.95, 0.1, 1.4),
        new THREE.MeshBasicMaterial({ color: c }),
      );
      cell.position.set(-TRACK.width / 2 + cellW * (i + 0.5), 0.22, 0);
      strip.add(cell);
    }
    g.add(strip);

    // Poles + banner
    for (const side of [-TRACK.width / 2 - 0.4, TRACK.width / 2 + 0.4]) {
      const pole = new THREE.Mesh(
        new THREE.CylinderGeometry(0.18, 0.18, 4.2, 8),
        new THREE.MeshLambertMaterial({ color: 0xeeeeee }),
      );
      pole.position.set(side, 2.1, 0);
      g.add(pole);
    }
    const banner = new THREE.Mesh(
      new THREE.BoxGeometry(TRACK.width + 1.2, 0.9, 0.2),
      new THREE.MeshLambertMaterial({ color }),
    );
    banner.position.set(0, 3.8, 0);
    g.add(banner);

    // Sprite label
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 64;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#00000000';
    ctx.clearRect(0, 0, 256, 64);
    ctx.font = 'bold 40px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = '#000000';
    ctx.lineWidth = 6;
    ctx.strokeText(label, 128, 32);
    ctx.fillText(label, 128, 32);
    const tex = new THREE.CanvasTexture(canvas);
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true }));
    sprite.scale.set(8, 2, 1);
    sprite.position.set(0, 5.2, 0);
    g.add(sprite);

    return g;
  }

  syncMarkers(markers: RaceMarkers): void {
    this.markersCache = markers;
    if (!this.startGate) {
      this.startGate = this.makeGate('START', 0x2ecc71);
      this.scene.add(this.startGate);
    }
    if (!this.finishGate) {
      this.finishGate = this.makeGate(markers.isLoop ? 'START / FINISH' : 'FINISH', 0xff5a36);
      this.scene.add(this.finishGate);
    }

    this.startGate.position.set(markers.start.x, 0, markers.start.z);
    this.startGate.rotation.y = markers.start.yaw;

    if (markers.isLoop) {
      // Offset finish slightly so both labels readable
      this.finishGate.position.set(markers.finish.x, 0, markers.finish.z);
      this.finishGate.rotation.y = markers.finish.yaw;
      this.finishGate.visible = true;
      // Update label via recreating is heavy — hide start banner duplicate: show combined on finish only
      this.startGate.visible = true;
    } else {
      this.finishGate.visible = true;
      this.startGate.visible = true;
      this.finishGate.position.set(markers.finish.x, 0, markers.finish.z);
      this.finishGate.rotation.y = markers.finish.yaw;
    }
  }

  syncTrack(pieces: TrackPiece[], sockets: TrackSocket[]): void {
    this.pieces = pieces;
    this.sockets = sockets;
    const seen = new Set<string>();
    for (const piece of pieces) {
      seen.add(piece.id);
      if (!this.pieceMeshes.has(piece.id)) {
        const mesh = this.makePieceMesh(piece);
        this.pieceMeshes.set(piece.id, mesh);
        this.scene.add(mesh);
      }
    }
    for (const [id, mesh] of this.pieceMeshes) {
      if (!seen.has(id)) {
        this.scene.remove(mesh);
        this.pieceMeshes.delete(id);
      }
    }

    const sockSeen = new Set<string>();
    for (const s of sockets) {
      sockSeen.add(s.id);
      let mesh = this.socketMeshes.get(s.id);
      if (!mesh) {
        mesh = new THREE.Mesh(
          new THREE.CylinderGeometry(1.4, 1.4, 0.2, 16),
          new THREE.MeshBasicMaterial({ color: 0x3ecf8e, transparent: true, opacity: 0.65 }),
        );
        mesh.position.y = 0.3;
        this.socketMeshes.set(s.id, mesh);
        this.scene.add(mesh);
      }
      mesh.position.x = s.x;
      mesh.position.z = s.z;
      mesh.visible = this.placing;
      (mesh as THREE.Mesh).material = new THREE.MeshBasicMaterial({
        color: this.selectedSocketId === s.id ? 0xff5a36 : 0x3ecf8e,
        transparent: true,
        opacity: this.selectedSocketId === s.id ? 0.9 : 0.65,
      });
    }
    for (const [id, mesh] of this.socketMeshes) {
      if (!sockSeen.has(id)) {
        this.scene.remove(mesh);
        this.socketMeshes.delete(id);
      }
    }
  }

  sync(state: RoomState): void {
    this.players.clear();
    for (const p of state.players) this.players.set(p.id, p);
    this.syncTrack(state.trackPieces, state.trackSockets);
    this.syncMarkers(state.markers);
    this.racing = state.phase === 'racing';

    const now = performance.now();
    const seen = new Set<string>();
    for (const car of state.cars) {
      seen.add(car.id);
      this.ensureCar(car, now);
      const cr = this.cars.get(car.id)!;
      if (car.id === this.localId) {
        // Only hard-set local on countdown / first init
        if (!cr.initialized || state.phase === 'countdown') {
          cr.localX = car.x;
          cr.localY = car.y || 0;
          cr.localZ = car.z;
          cr.localYaw = car.yaw;
          cr.localSpeed = 0;
          cr.steer = 0;
          cr.localBoost = car.boost;
          cr.localVy = 0;
          cr.airborne = false;
          cr.spinning = 0;
          cr.icy = 0;
          cr.eliminated = false;
          cr.initialized = true;
          cr.mesh.position.set(car.x, cr.localY, car.z);
          cr.mesh.rotation.y = car.yaw;
          cr.mesh.visible = true;
        }
        if (car.eliminated) {
          cr.eliminated = true;
          cr.mesh.visible = false;
        }
      } else {
        cr.buffer.push({ x: car.x, z: car.z, yaw: car.yaw, t: now });
        if (cr.buffer.length > 30) cr.buffer.shift();
      }
      cr.mesh.visible = true;
    }
    for (const [id, cr] of this.cars) {
      if (!seen.has(id)) cr.mesh.visible = false;
    }

    for (const ob of state.obstacles) {
      let mesh = this.obstacleMeshes.get(ob.id);
      if (!mesh) {
        mesh = this.makeObstacle(ob.type);
        this.obstacleMeshes.set(ob.id, mesh);
        this.scene.add(mesh);
      }
      mesh.position.x = ob.x;
      mesh.position.z = ob.z;
      mesh.rotation.y = ob.yaw;
      this.updateTrapPillar(mesh, ob.x, ob.z);
    }
    const obIds = new Set(state.obstacles.map((o) => o.id));
    for (const [id, mesh] of this.obstacleMeshes) {
      if (!obIds.has(id)) {
        this.scene.remove(mesh);
        this.obstacleMeshes.delete(id);
      }
    }
    this.updateGhostVisibility();
  }

  applyCarsUpdate(update: CarsUpdate): void {
    const now = performance.now();
    for (const car of update.cars) {
      const cr = this.cars.get(car.id);
      if (!cr) continue;
      if (car.eliminated) {
        cr.eliminated = true;
        cr.mesh.visible = false;
        continue;
      }
      if (car.id === this.localId) {
        cr.localBoost = car.boost;
        if (car.finished) cr.localSpeed = 0;
        const err = Math.hypot(car.x - cr.localX, car.z - cr.localZ);
        if (err > 25) {
          cr.localX = car.x;
          cr.localY = car.y || 0;
          cr.localZ = car.z;
          cr.localYaw = car.yaw;
          cr.localSpeed = car.speed;
        }
      } else {
        cr.buffer.push({ x: car.x, z: car.z, yaw: car.yaw, t: now });
        while (cr.buffer.length > 40) cr.buffer.shift();
        // store y on mesh directly via userData
        cr.mesh.userData.y = car.y || 0;
        cr.mesh.userData.airborne = !!car.airborne;
      }
    }
  }

  private ensureCar(car: CarState, now: number): void {
    if (this.cars.has(car.id)) return;
    const pl = this.players.get(car.id);
    const mesh = makeFruit(pl?.fruit || 'apple', pl?.color || '#ffffff');
    this.scene.add(mesh);
    this.cars.set(car.id, {
      mesh,
      buffer: [{ x: car.x, z: car.z, yaw: car.yaw, t: now }],
      localX: car.x,
      localY: car.y || 0,
      localZ: car.z,
      localYaw: car.yaw,
      localSpeed: 0,
      localBoost: 100,
      padBoost: 0,
      steer: 0,
      localVy: 0,
      airborne: false,
      spinning: 0,
      icy: 0,
      initialized: false,
      eliminated: false,
    });
  }

  /** Client-side physics for local car — source of truth for feel */
  tickLocal(input: InputState, dt: number, obstacles: Obstacle[] = []): { fellOff: boolean } {
    const cr = this.cars.get(this.localId);
    if (!cr || !this.racing || cr.eliminated) return { fellOff: false };

    // Ramp surface sample
    let surfY = 0;
    let onRamp = false;
    let rampKick = 0;
    for (const ob of obstacles) {
      if (ob.type !== 'ramp') continue;
      const dx = cr.localX - ob.x;
      const dz = cr.localZ - ob.z;
      const fx = Math.sin(ob.yaw);
      const fz = Math.cos(ob.yaw);
      const along = dx * fx + dz * fz;
      const lat = -dx * fz + dz * fx;
      if (Math.abs(lat) < 2.2 && along > -1.2 && along < 3.5) {
        const t = Math.max(0, Math.min(1, (along + 1.2) / 4.5));
        const h = t * 2.4;
        if (h >= surfY) {
          surfY = h;
          onRamp = true;
          rampKick = 12 + t * 20;
        }
      }
    }

    // Mirror utility trap effects locally (server applies the same rules)
    if (cr.padBoost > 0) cr.padBoost -= dt;
    for (const ob of obstacles) {
      if (ob.spent) continue;
      const od = Math.hypot(cr.localX - ob.x, cr.localZ - ob.z);
      const highUp = cr.airborne && cr.localY > 0.6;
      switch (ob.type) {
        case 'barrier':
          if (od < 2.2 && !highUp) {
            const nx = (cr.localX - ob.x) / (od || 1);
            const nz = (cr.localZ - ob.z) / (od || 1);
            cr.localX = ob.x + nx * 2.2;
            cr.localZ = ob.z + nz * 2.2;
            cr.localSpeed *= -0.2;
          }
          break;
        case 'ice':
          if (od < 2.8 && !highUp) cr.icy = Math.max(cr.icy, 1.0);
          break;
        case 'boost':
          if (od < 2.5 && !highUp) {
            cr.padBoost = 1.2;
            cr.localSpeed = Math.max(cr.localSpeed, 40);
          }
          break;
        case 'oil':
          if (od < 2.4 && !highUp && cr.spinning <= 0) cr.spinning = 0.7;
          break;
      }
    }

    if (cr.spinning > 0) {
      cr.spinning -= dt;
      cr.localYaw += 5 * dt;
      cr.localSpeed *= Math.max(0, 1 - 1.2 * dt);
    } else if (!cr.airborne) {
      // Running: eased steering (ramps in over ~0.25s), gentler at speed
      const target = (input.left ? 1 : 0) - (input.right ? 1 : 0);
      const reversing = target !== 0 && cr.steer !== 0 && Math.sign(target) !== Math.sign(cr.steer);
      const rate = target === 0 || reversing ? STEER_EASE_OUT : STEER_EASE_IN;
      const delta = target - cr.steer;
      cr.steer += Math.sign(delta) * Math.min(Math.abs(delta), rate * dt);
      const speedFrac = Math.min(1, Math.abs(cr.localSpeed) / 30);
      const turnRate = RUN_TURN_RATE_MAX - (RUN_TURN_RATE_MAX - RUN_TURN_RATE_MIN) * speedFrac;
      cr.localYaw += cr.steer * turnRate * dt;
      if (input.forward) cr.localSpeed += 55 * dt;
      if (input.back) cr.localSpeed -= 55 * dt;
      // Jump (Space): edge-triggered hop while grounded
      if (input.jump && !this.jumpHeld && !cr.airborne) {
        cr.localVy = 11;
        cr.airborne = true;
        cr.localY += 0.05;
      }
      if (cr.icy > 0) {
        cr.icy -= dt;
        cr.localYaw += Math.sin(performance.now() / 140) * 0.45 * dt;
        cr.localSpeed *= Math.max(0, 1 - 0.2 * dt); // slippery: coast
      } else {
        cr.localSpeed *= Math.max(0, 1 - 1.2 * dt);
        if (!input.forward && !input.back) cr.localSpeed *= Math.max(0, 1 - 6 * dt);
      }
      cr.localSpeed = Math.max(-10, Math.min(cr.padBoost > 0 ? 44 : 30, cr.localSpeed));
    }

    cr.localX += Math.sin(cr.localYaw) * cr.localSpeed * dt;
    cr.localZ += Math.cos(cr.localYaw) * cr.localSpeed * dt;

    // Ramp launch
    if (onRamp && !cr.airborne && cr.localSpeed > 8 && rampKick > 0) {
      cr.localVy = Math.max(cr.localVy, rampKick * 0.5);
      cr.localSpeed += 6;
      cr.airborne = true;
      cr.localY = Math.max(cr.localY, surfY + 0.15);
    }

    // Is there anything under us? Asphalt or a ramp, and only if we haven't dropped below the surface.
    const onAsphalt = tileOnAsphalt(this.pieces, cr.localX, cr.localZ, ASPHALT_TOL);
    const hasGround = (onAsphalt || onRamp) && cr.localY > -0.6;
    if (!hasGround) {
      // Ran off the edge (or dropped below it): real fall, no steering, keep some momentum
      cr.airborne = true;
      cr.steer = 0;
      cr.localVy -= 32 * dt;
      cr.localY += cr.localVy * dt;
      cr.localSpeed *= Math.max(0, 1 - 0.8 * dt);
      this.jumpHeld = input.jump;
      return { fellOff: cr.localY < -DEATH_DEPTH };
    }

    if (cr.airborne || cr.localY > surfY + 0.05) {
      cr.localVy -= 32 * dt;
      cr.localY += cr.localVy * dt;
      if (cr.localY <= surfY) {
        cr.localY = surfY;
        cr.localVy = 0;
        cr.airborne = false;
      } else {
        cr.airborne = true;
      }
    } else {
      cr.localY = surfY;
      cr.localVy = 0;
      cr.airborne = false;
    }

    this.jumpHeld = input.jump;

    return { fellOff: false };
  }

  /** Traps placed off the asphalt stand on a stone post down to the grass far below. */
  private updateTrapPillar(mesh: THREE.Object3D, x: number, z: number): void {
    const off = !tileOnAsphalt(this.pieces, x, z, ASPHALT_TOL);
    let pillar = mesh.getObjectByName('pillar');
    if (off && !pillar) {
      const h = -GROUND_Y;
      pillar = new THREE.Mesh(
        new THREE.CylinderGeometry(0.9, 1.2, h, 7),
        new THREE.MeshLambertMaterial({ color: 0x8a8174, flatShading: true }),
      );
      pillar.name = 'pillar';
      pillar.position.y = -h / 2 - 0.02;
      mesh.add(pillar);
    }
    if (pillar) pillar.visible = off;
  }



  getLocalPose(): {
    x: number; y: number; z: number; yaw: number; speed: number; boost: number; vy: number; airborne: boolean;
  } | null {
    const cr = this.cars.get(this.localId);
    if (!cr) return null;
    return {
      x: cr.localX,
      y: cr.localY,
      z: cr.localZ,
      yaw: cr.localYaw,
      speed: cr.localSpeed,
      boost: cr.localBoost,
      vy: cr.localVy,
      airborne: cr.airborne,
    };
  }

  setPlacing(active: boolean): void {
    this.placing = active;
    for (const mesh of this.socketMeshes.values()) mesh.visible = active;
    this.updateGhostVisibility();
  }

  /** Trap type to preview under the cursor (null = track mode / ring only). */
  setGhostType(type: Obstacle['type'] | null): void {
    if (type === this.ghostType) return;
    this.ghostType = type;
    if (this.ghostPreview && this.placeMarker) this.placeMarker.remove(this.ghostPreview);
    this.ghostPreview = null;
    if (type) {
      const prev = this.makeObstacle(type);
      prev.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.material) {
          const mat = (m.material as THREE.Material).clone() as THREE.MeshLambertMaterial;
          mat.transparent = true;
          mat.opacity = 0.55;
          mat.depthWrite = false;
          m.material = mat;
        }
      });
      this.ghostPreview = prev;
    }
    this.updateGhostVisibility();
  }

  rotateGhost(delta: number): void {
    this.ghostPos.yaw += delta;
    this.updateGhostVisibility();
  }

  /** Client-side mirror of server trap rules, for ghost tint only (server decides). */
  private trapSpotOk(x: number, z: number): boolean {
    const nearCourse = this.pieces.some((pc) => Math.hypot(pc.x - x, pc.z - z) < 80);
    if (!nearCourse && (Math.abs(x) > MAP_HALF_SIZE || Math.abs(z) > MAP_HALF_SIZE)) return false;
    const s = this.markersCache?.start;
    if (s) {
      const fx = Math.sin(s.yaw);
      const fz = Math.cos(s.yaw);
      const dx = x - s.x;
      const dz = z - s.z;
      const along = dx * fx + dz * fz;
      const lat = -dx * fz + dz * fx;
      if (along > -START_SAFE.back && along < START_SAFE.ahead && Math.abs(lat) < START_SAFE.halfWidth) return false;
    }
    for (const m of this.obstacleMeshes.values()) {
      if (Math.hypot(m.position.x - x, m.position.z - z) < 3) return false;
    }
    return true;
  }

  private updateGhostVisibility(): void {
    if (this.placing) {
      if (!this.placeMarker) {
        const g = new THREE.Group();
        const ring = new THREE.Mesh(
          new THREE.RingGeometry(1.2, 1.8, 24),
          new THREE.MeshBasicMaterial({ color: 0xff5a36, side: THREE.DoubleSide, transparent: true, opacity: 0.85 }),
        );
        ring.rotation.x = -Math.PI / 2;
        ring.position.y = 0.35;
        g.add(ring);
        this.ghostRing = ring;
        this.placeMarker = g;
        this.scene.add(g);
      }
      if (this.ghostPreview && this.ghostPreview.parent !== this.placeMarker) this.placeMarker.add(this.ghostPreview);
      if (this.ghostPreview) this.ghostPreview.rotation.y = this.ghostPos.yaw;
      this.ghostValid = this.ghostType ? this.trapSpotOk(this.ghostPos.x, this.ghostPos.z) : true;
      if (this.ghostRing) {
        (this.ghostRing.material as THREE.MeshBasicMaterial).color.set(
          this.ghostType ? (this.ghostValid ? 0x3ecf8e : 0xff3030) : 0xff5a36,
        );
      }
      this.placeMarker.visible = true;
      this.placeMarker.position.set(this.ghostPos.x, 0, this.ghostPos.z);
    } else if (this.placeMarker) {
      this.placeMarker.visible = false;
    }
  }

  moveGhost(dx: number, dz: number): void {
    this.ghostPos.x += dx;
    this.ghostPos.z += dz;
    this.updateGhostVisibility();
  }

  setGhostFromClick(x: number, z: number): { kind: 'socket' | 'ground'; socketId: string | null } {
    this.ghostPos.x = x;
    this.ghostPos.z = z;
    let best: TrackSocket | null = null;
    let bestD = 6;
    for (const s of this.sockets) {
      const d = Math.hypot(s.x - x, s.z - z);
      if (d < bestD) {
        bestD = d;
        best = s;
      }
    }
    if (best) {
      this.selectedSocketId = best.id;
      this.ghostPos.x = best.x;
      this.ghostPos.z = best.z;
      this.ghostPos.yaw = best.yaw;
    } else {
      this.selectedSocketId = null;
    }
    for (const [id, mesh] of this.socketMeshes) {
      const selected = id === this.selectedSocketId;
      (mesh as THREE.Mesh).material = selected ? this.sockMatSel : this.sockMatIdle;
    }
    this.updateGhostVisibility();
    return { kind: best ? 'socket' : 'ground', socketId: this.selectedSocketId };
  }

  /** Move ghost under cursor; snap to nearest socket within range */
  updateGhostCursor(x: number, z: number, preferSocket: boolean): void {
    this.ghostPos.x = x;
    this.ghostPos.z = z;
    if (preferSocket) {
      let best: TrackSocket | null = null;
      let bestD = 8;
      for (const s of this.sockets) {
        const d = Math.hypot(s.x - x, s.z - z);
        if (d < bestD) { bestD = d; best = s; }
      }
      if (best) {
        this.selectedSocketId = best.id;
        this.ghostPos.x = best.x;
        this.ghostPos.z = best.z;
        this.ghostPos.yaw = best.yaw;
      } else {
        this.selectedSocketId = null;
      }
    } else {
      this.selectedSocketId = null;
    }
    for (const [id, mesh] of this.socketMeshes) {
      const selected = id === this.selectedSocketId;
      (mesh as THREE.Mesh).material = selected ? this.sockMatSel : this.sockMatIdle;
      mesh.visible = this.placing;
    }
    this.updateGhostVisibility();
  }

  screenToTrack(clientX: number, clientY: number): { x: number; z: number } | null {
    const rect = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(ndc, this.camera);
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    const hit = new THREE.Vector3();
    if (raycaster.ray.intersectPlane(plane, hit)) return { x: hit.x, z: hit.z };
    return null;
  }

  start(): void {
    let last = performance.now();
    const loop = () => {
      this.animId = requestAnimationFrame(loop);
      const now = performance.now();
      last = now;
      // One bad frame must never kill the loop: log and keep rendering
      try {
        this.renderCars(now);
        this.updateCamera(now);
        this.renderer.render(this.scene, this.camera);
      } catch (err) {
        this.frameErrors++;
        if (this.frameErrors < 20 || this.frameErrors % 300 === 0) console.error('[laptrap] render frame failed', err);
      }
    };
    loop();
  }

  stop(): void {
    cancelAnimationFrame(this.animId);
  }

  private renderCars(now: number): void {
    const renderTime = now - this.renderDelayMs;
    const dt = Math.min(0.1, Math.max(0.001, (now - this.lastFrame) / 1000));
    this.lastFrame = now;
    for (const [id, cr] of this.cars) {
      if (!cr.mesh.visible) continue;
      if (cr.eliminated) {
        cr.mesh.visible = false;
        continue;
      }
      if (id === this.localId) {
        cr.mesh.position.set(cr.localX, cr.localY, cr.localZ);
        cr.mesh.rotation.y = cr.localYaw;
        animateFruit(cr.mesh, this.racing ? cr.localSpeed : 0, cr.airborne, dt, now);
        continue;
      }
      // Interpolate from buffer
      const buf = cr.buffer;
      if (buf.length === 0) continue;
      const yy = (cr.mesh.userData.y as number) || 0;
      if (buf.length === 1) {
        cr.mesh.position.set(buf[0].x, yy, buf[0].z);
        cr.mesh.rotation.y = buf[0].yaw;
      } else {
        let i = 0;
        while (i < buf.length - 1 && buf[i + 1].t < renderTime) i++;
        const a = buf[Math.max(0, i)];
        const b = buf[Math.min(buf.length - 1, i + 1)];
        const span = Math.max(1, b.t - a.t);
        const t = Math.min(1, Math.max(0, (renderTime - a.t) / span));
        // smooth y too so remote hops don't step
        const curY = cr.mesh.position.y;
        cr.mesh.position.set(a.x + (b.x - a.x) * t, curY + (yy - curY) * Math.min(1, dt * 12), a.z + (b.z - a.z) * t);
        cr.mesh.rotation.y = lerpAngle(a.yaw, b.yaw, t);
      }
      const spd = estimateRemoteSpeed(cr.mesh, dt);
      const air = !!cr.mesh.userData.airborne || Math.abs(cr.mesh.position.y) > 0.4;
      animateFruit(cr.mesh, spd, air, dt, now);
    }
  }

  // ---------- Build-phase camera (PICK + PLACE) ----------
  private buildView = false;
  private sockMatIdle = new THREE.MeshBasicMaterial({ color: 0x3ecf8e, transparent: true, opacity: 0.6 });
  private sockMatSel = new THREE.MeshBasicMaterial({ color: 0xff5a36, transparent: true, opacity: 0.95 });
  /** Orbit camera: look-at point (x,z), distance, heading yaw (camera looks along forward(yaw)), pitch */
  private bv = { x: 0, z: 0, dist: 90, yaw: 0, pitch: 0.95 };
  private bvBounds = { minX: -60, maxX: 60, minZ: -60, maxZ: 60 };

  /** Enter/leave the free build camera. Entering frames the course with FINISH ahead. */
  setBuildView(active: boolean): void {
    if (active && !this.buildView) this.resetBuildView();
    this.buildView = active;
  }

  isBuildView(): boolean {
    return this.buildView;
  }

  /** Default view: from behind/above START looking down the course toward FINISH, whole course framed. */
  resetBuildView(): void {
    const m = this.markersCache;
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const pc of this.pieces) {
      for (const sp of sampleTile(pc, 6)) {
        minX = Math.min(minX, sp.x); maxX = Math.max(maxX, sp.x);
        minZ = Math.min(minZ, sp.z); maxZ = Math.max(maxZ, sp.z);
      }
    }
    if (!Number.isFinite(minX)) { minX = -40; maxX = 40; minZ = -40; maxZ = 40; }
    const pad = TRACK.width;
    minX -= pad; maxX += pad; minZ -= pad; maxZ += pad;
    this.bvBounds = { minX: minX - 60, maxX: maxX + 60, minZ: minZ - 60, maxZ: maxZ + 60 };
    let yaw = 0;
    if (m) {
      const dx = m.finish.x - m.start.x;
      const dz = m.finish.z - m.start.z;
      yaw = Math.hypot(dx, dz) > 10 && !m.isLoop ? Math.atan2(dx, dz) : m.start.yaw;
    }
    // look-at: course center, nudged toward START so the course runs from bottom (START) to top (FINISH)
    const cx = (minX + maxX) / 2;
    const cz = (minZ + maxZ) / 2;
    const extent = Math.max(maxX - minX, maxZ - minZ) / 2;
    const dist = Math.min(280, Math.max(55, extent * 2.1 + 15));
    this.bv = { x: cx, z: cz, dist, yaw, pitch: 0.95 };
  }

  /** Grab-style pan by screen pixels (drag right = content moves right). */
  panBuildViewPixels(dxPx: number, dyPx: number): void {
    const h = this.canvas.clientHeight || innerHeight;
    const worldPerPx = (2 * this.bv.dist * Math.tan((this.camera.fov * Math.PI) / 360)) / h;
    const f = forwardVec(this.bv.yaw);
    const l = leftVec(this.bv.yaw); // screen-left
    // drag right -> camera moves screen-left; drag down -> camera moves forward (scaled for pitch)
    const fwdScale = 1 / Math.max(0.5, Math.sin(this.bv.pitch));
    this.bv.x += l.x * dxPx * worldPerPx + f.x * dyPx * worldPerPx * fwdScale;
    this.bv.z += l.z * dxPx * worldPerPx + f.z * dyPx * worldPerPx * fwdScale;
    this.clampBuildView();
  }

  /** Pan in screen directions: right>0 moves view right, up>0 moves view forward (toward top of screen). */
  panBuildView(right: number, up: number): void {
    const f = forwardVec(this.bv.yaw);
    const l = leftVec(this.bv.yaw);
    const k = this.bv.dist / 90;
    this.bv.x += (-l.x * right + f.x * up) * k;
    this.bv.z += (-l.z * right + f.z * up) * k;
    this.clampBuildView();
  }

  zoomBuildView(factor: number): void {
    this.bv.dist = Math.min(280, Math.max(22, this.bv.dist * factor));
  }

  rotateBuildView(dYaw: number, dPitch = 0): void {
    this.bv.yaw += dYaw;
    this.bv.pitch = Math.min(1.45, Math.max(0.5, this.bv.pitch + dPitch));
  }

  private clampBuildView(): void {
    const b = this.bvBounds;
    // keep the look-at point within the course bounds (+60 margin), however far the course has grown
    this.bv.x = Math.min(b.maxX, Math.max(b.minX, this.bv.x));
    this.bv.z = Math.min(b.maxZ, Math.max(b.minZ, this.bv.z));
  }

  private updateCamera(_now: number): void {
    if (this.buildView) {
      // Free build camera (never follows the mouse/ghost, so the spot under the cursor stays put)
      const f = forwardVec(this.bv.yaw);
      const horiz = Math.cos(this.bv.pitch) * this.bv.dist;
      const desired = new THREE.Vector3(this.bv.x - f.x * horiz, Math.sin(this.bv.pitch) * this.bv.dist, this.bv.z - f.z * horiz);
      this.camTarget.lerp(desired, 0.3);
      this.camLook.lerp(new THREE.Vector3(this.bv.x, 0, this.bv.z), 0.3);
    } else {
      const cr = this.cars.get(this.localId);
      if (cr && cr.mesh.visible) {
        const yaw = cr.localYaw;
        const desired = new THREE.Vector3(
          cr.localX - Math.sin(yaw) * 14,
          8,
          cr.localZ - Math.cos(yaw) * 14,
        );
        this.camTarget.lerp(desired, 0.08);
        this.camLook.lerp(new THREE.Vector3(cr.localX, 1, cr.localZ), 0.1);
      } else {
        this.camTarget.lerp(new THREE.Vector3(0, 50, 55), 0.04);
        this.camLook.lerp(new THREE.Vector3(0, 0, 0), 0.04);
      }
    }
    this.camera.position.copy(this.camTarget);
    this.camera.lookAt(this.camLook);
  }
}
