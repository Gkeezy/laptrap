import * as THREE from 'three';
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
import { TRACK } from '../../../shared/types';

interface Snapshot {
  x: number;
  z: number;
  yaw: number;
  t: number;
}

interface CarRender {
  mesh: THREE.Group;
  buffer: Snapshot[];
  // Local authoritative state (only for local player)
  localX: number;
  localZ: number;
  localYaw: number;
  localSpeed: number;
  localBoost: number;
  spinning: number;
  icy: number;
  initialized: boolean;
}

function lerpAngle(a: number, b: number, t: number): number {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

function samplePieceLocal(piece: TrackPiece, steps = 8): Array<{ x: number; z: number; yaw: number }> {
  const L = TRACK.straightLen;
  const R = TRACK.curveRadius;
  const pts: Array<{ x: number; z: number; yaw: number }> = [];
  const fwd = (yaw: number) => ({ x: Math.sin(yaw), z: Math.cos(yaw) });
  const left = (yaw: number) => ({ x: -Math.cos(yaw), z: Math.sin(yaw) });
  const right = (yaw: number) => ({ x: Math.cos(yaw), z: -Math.sin(yaw) });

  if (piece.type === 'straight') {
    const f = fwd(piece.yaw);
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      pts.push({ x: piece.x + f.x * L * t, z: piece.z + f.z * L * t, yaw: piece.yaw });
    }
    return pts;
  }
  const side = piece.type === 'curveL' ? left(piece.yaw) : right(piece.yaw);
  const sign = piece.type === 'curveL' ? 1 : -1;
  const cx = piece.x + side.x * R;
  const cz = piece.z + side.z * R;
  const relX0 = piece.x - cx;
  const relZ0 = piece.z - cz;
  const sweep = Math.PI / 2;
  for (let i = 0; i <= steps; i++) {
    const t = sign * sweep * (i / steps);
    const cos = Math.cos(t);
    const sin = Math.sin(t);
    pts.push({
      x: cx + relX0 * cos - relZ0 * sin,
      z: cz + relX0 * sin + relZ0 * cos,
      yaw: piece.yaw + t,
    });
  }
  return pts;
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
    this.scene.fog = new THREE.Fog(0x87b5e0, 90, 200);
    this.camera = new THREE.PerspectiveCamera(55, 1, 0.1, 400);
    this.camera.position.set(0, 40, 50);

    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(500, 500),
      new THREE.MeshLambertMaterial({ color: 0x3d8c40 }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.05;
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

  private makeCar(color: string): THREE.Group {
    const g = new THREE.Group();
    const body = new THREE.Mesh(
      new THREE.BoxGeometry(1.6, 0.55, 2.8),
      new THREE.MeshLambertMaterial({ color }),
    );
    body.position.y = 0.45;
    g.add(body);
    const cabin = new THREE.Mesh(
      new THREE.BoxGeometry(1.2, 0.4, 1.2),
      new THREE.MeshLambertMaterial({ color: 0x222222 }),
    );
    cabin.position.set(0, 0.85, -0.15);
    g.add(cabin);
    const wheelMat = new THREE.MeshLambertMaterial({ color: 0x111111 });
    for (const [x, z] of [[-0.85, 0.9], [0.85, 0.9], [-0.85, -0.9], [0.85, -0.9]] as const) {
      const w = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.35, 0.35, 10), wheelMat);
      w.rotation.z = Math.PI / 2;
      w.position.set(x, 0.35, z);
      g.add(w);
    }
    return g;
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
        const m = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.8, 2.2), new THREE.MeshLambertMaterial({ color: 0x9b59b6 }));
        m.position.y = 0.2;
        m.rotation.x = -0.35;
        return m;
      }
      case 'oil': {
        const m = new THREE.Mesh(
          new THREE.CylinderGeometry(2.0, 2.0, 0.08, 16),
          new THREE.MeshLambertMaterial({ color: 0x1a1a1a, transparent: true, opacity: 0.9 }),
        );
        m.position.y = 0.08;
        return m;
      }
    }
  }

  private makePieceMesh(piece: TrackPiece): THREE.Object3D {
    const g = new THREE.Group();
    const samples = samplePieceLocal(piece, 10);
    const halfW = TRACK.width / 2;
    const mat = new THREE.MeshLambertMaterial({ color: piece.onMainPath ? 0x2a2e35 : 0x3a4555 });
    const wallMat = new THREE.MeshLambertMaterial({ color: 0x8e9aab });
    for (let i = 0; i < samples.length - 1; i++) {
      const a = samples[i];
      const b = samples[i + 1];
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const len = Math.hypot(dx, dz) || 0.01;
      const yaw = Math.atan2(dx, dz);
      const seg = new THREE.Mesh(new THREE.BoxGeometry(TRACK.width, 0.16, len + 0.05), mat);
      seg.position.set((a.x + b.x) / 2, 0.08, (a.z + b.z) / 2);
      seg.rotation.y = yaw;
      g.add(seg);
      const left = { x: -Math.cos(yaw), z: Math.sin(yaw) };
      for (const sign of [-1, 1]) {
        const wall = new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.9, len + 0.05), wallMat);
        wall.position.set((a.x + b.x) / 2 + left.x * halfW * sign, 0.45, (a.z + b.z) / 2 + left.z * halfW * sign);
        wall.rotation.y = yaw;
        g.add(wall);
      }
      if (i % 2 === 0) {
        const dash = new THREE.Mesh(
          new THREE.BoxGeometry(0.25, 0.05, Math.min(1.2, len * 0.6)),
          new THREE.MeshBasicMaterial({ color: 0xf5d76e }),
        );
        dash.position.set((a.x + b.x) / 2, 0.18, (a.z + b.z) / 2);
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
          cr.localZ = car.z;
          cr.localYaw = car.yaw;
          cr.localSpeed = 0;
          cr.localBoost = car.boost;
          cr.spinning = 0;
          cr.icy = 0;
          cr.initialized = true;
          cr.mesh.position.set(car.x, 0, car.z);
          cr.mesh.rotation.y = car.yaw;
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
      if (car.id === this.localId) {
        // Local is client-authoritative — ignore position; sync boost/status only
        cr.localBoost = car.boost;
        if (car.finished) cr.localSpeed = 0;
        // Only correct if wildly desynced (anti-cheat / rubber-band rare)
        const err = Math.hypot(car.x - cr.localX, car.z - cr.localZ);
        if (err > 25) {
          cr.localX = car.x;
          cr.localZ = car.z;
          cr.localYaw = car.yaw;
          cr.localSpeed = car.speed;
        }
      } else {
        cr.buffer.push({ x: car.x, z: car.z, yaw: car.yaw, t: now });
        while (cr.buffer.length > 40) cr.buffer.shift();
      }
    }
  }

  private ensureCar(car: CarState, now: number): void {
    if (this.cars.has(car.id)) return;
    const color = this.players.get(car.id)?.color || '#ffffff';
    const mesh = this.makeCar(color);
    this.scene.add(mesh);
    this.cars.set(car.id, {
      mesh,
      buffer: [{ x: car.x, z: car.z, yaw: car.yaw, t: now }],
      localX: car.x,
      localZ: car.z,
      localYaw: car.yaw,
      localSpeed: 0,
      localBoost: 100,
      spinning: 0,
      icy: 0,
      initialized: false,
    });
  }

  /** Client-side physics for local car — source of truth for feel */
  tickLocal(input: InputState, dt: number): void {
    const cr = this.cars.get(this.localId);
    if (!cr || !this.racing) return;

    if (cr.spinning > 0) {
      cr.spinning -= dt;
      cr.localYaw += 5 * dt;
      cr.localSpeed *= Math.max(0, 1 - 1.2 * dt);
    } else {
      const turnRate = 2.5 + Math.min(Math.abs(cr.localSpeed) * 0.05, 1.1);
      if (input.left) cr.localYaw += turnRate * dt;
      if (input.right) cr.localYaw -= turnRate * dt;

      if (input.forward) cr.localSpeed += 30 * dt;
      if (input.back) cr.localSpeed -= 40 * dt;

      let boosting = false;
      if (input.boost && cr.localBoost > 0 && cr.localSpeed > 4) {
        cr.localBoost = Math.max(0, cr.localBoost - 30 * dt);
        cr.localSpeed += 24 * dt;
        boosting = true;
      }
      if (!boosting) cr.localBoost = Math.min(100, cr.localBoost + 20 * dt);

      if (cr.icy > 0) {
        cr.icy -= dt;
        cr.localYaw += Math.sin(performance.now() / 140) * 0.45 * dt;
      }

      cr.localSpeed *= Math.max(0, 1 - 1.0 * dt);
      if (!input.forward && !input.back && !boosting) cr.localSpeed *= Math.max(0, 1 - 2.5 * dt);
      cr.localSpeed = Math.max(-12, Math.min(50 + (boosting ? 16 : 0), cr.localSpeed));
    }

    cr.localX += Math.sin(cr.localYaw) * cr.localSpeed * dt;
    cr.localZ += Math.cos(cr.localYaw) * cr.localSpeed * dt;

    // Soft local clamp to asphalt samples
    this.softClampLocal(cr);
  }

  private softClampLocal(cr: CarRender): void {
    let bestD = Infinity;
    let bestX = cr.localX;
    let bestZ = cr.localZ;
    let bestYaw = cr.localYaw;
    for (const piece of this.pieces) {
      for (const s of samplePieceLocal(piece, 8)) {
        const d = Math.hypot(s.x - cr.localX, s.z - cr.localZ);
        if (d < bestD) {
          bestD = d;
          bestX = s.x;
          bestZ = s.z;
          bestYaw = s.yaw;
        }
      }
    }
    const halfW = TRACK.width / 2;
    if (bestD > halfW) {
      const left = { x: -Math.cos(bestYaw), z: Math.sin(bestYaw) };
      let lat = (cr.localX - bestX) * left.x + (cr.localZ - bestZ) * left.z;
      lat = Math.max(-halfW, Math.min(halfW, lat));
      cr.localX = bestX + left.x * lat;
      cr.localZ = bestZ + left.z * lat;
      cr.localSpeed *= 0.97;
    }
  }

  getLocalPose(): { x: number; z: number; yaw: number; speed: number; boost: number } | null {
    const cr = this.cars.get(this.localId);
    if (!cr) return null;
    return {
      x: cr.localX,
      z: cr.localZ,
      yaw: cr.localYaw,
      speed: cr.localSpeed,
      boost: cr.localBoost,
    };
  }

  setPlacing(active: boolean): void {
    this.placing = active;
    for (const mesh of this.socketMeshes.values()) mesh.visible = active;
    this.updateGhostVisibility();
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
        this.placeMarker = g;
        this.scene.add(g);
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
      (mesh as THREE.Mesh).material = new THREE.MeshBasicMaterial({
        color: selected ? 0xff5a36 : 0x3ecf8e,
        transparent: true,
        opacity: selected ? 0.9 : 0.65,
      });
    }
    this.updateGhostVisibility();
    return { kind: best ? 'socket' : 'ground', socketId: this.selectedSocketId };
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
      this.renderCars(now);
      this.updateCamera(now);
      this.renderer.render(this.scene, this.camera);
    };
    loop();
  }

  stop(): void {
    cancelAnimationFrame(this.animId);
  }

  private renderCars(now: number): void {
    const renderTime = now - this.renderDelayMs;
    for (const [id, cr] of this.cars) {
      if (!cr.mesh.visible) continue;
      if (id === this.localId) {
        cr.mesh.position.set(cr.localX, 0, cr.localZ);
        cr.mesh.rotation.y = cr.localYaw;
        continue;
      }
      // Interpolate from buffer
      const buf = cr.buffer;
      if (buf.length === 0) continue;
      if (buf.length === 1) {
        cr.mesh.position.set(buf[0].x, 0, buf[0].z);
        cr.mesh.rotation.y = buf[0].yaw;
        continue;
      }
      // Find surrounding snapshots
      let i = 0;
      while (i < buf.length - 1 && buf[i + 1].t < renderTime) i++;
      const a = buf[Math.max(0, i)];
      const b = buf[Math.min(buf.length - 1, i + 1)];
      const span = Math.max(1, b.t - a.t);
      const t = Math.min(1, Math.max(0, (renderTime - a.t) / span));
      cr.mesh.position.set(a.x + (b.x - a.x) * t, 0, a.z + (b.z - a.z) * t);
      cr.mesh.rotation.y = lerpAngle(a.yaw, b.yaw, t);
    }
  }

  private updateCamera(_now: number): void {
    if (this.placing) {
      const t = this.ghostPos;
      this.camTarget.lerp(new THREE.Vector3(t.x, 55, t.z + 12), 0.06);
      this.camLook.lerp(new THREE.Vector3(t.x, 0, t.z), 0.06);
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
