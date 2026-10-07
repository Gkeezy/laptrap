import * as THREE from 'three';
import type {
  CarState,
  CarsUpdate,
  Obstacle,
  PlayerPublic,
  RoomState,
  TrackPiece,
  TrackSocket,
} from '../../../shared/types';
import { TRACK } from '../../../shared/types';

interface CarRender {
  mesh: THREE.Group;
  // interpolation buffer for remotes
  from: { x: number; z: number; yaw: number; t: number };
  to: { x: number; z: number; yaw: number; t: number };
  // local prediction
  localX: number;
  localZ: number;
  localYaw: number;
  localSpeed: number;
  serverX: number;
  serverZ: number;
  serverYaw: number;
  serverSpeed: number;
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
  private finishMesh: THREE.Object3D | null = null;
  private animId = 0;
  private localId = '';
  private players = new Map<string, PlayerPublic>();
  canvas: HTMLCanvasElement;
  ghostPos = { x: 0, z: 0, yaw: 0 };
  placing = false;
  selectedSocketId: string | null = null;
  private sockets: TrackSocket[] = [];
  private lastCarsT = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.setSize(canvas.clientWidth || innerWidth, canvas.clientHeight || innerHeight, false);
    this.renderer.setClearColor(0x87b5e0);

    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.Fog(0x87b5e0, 80, 180);

    this.camera = new THREE.PerspectiveCamera(55, 1, 0.1, 400);
    this.camera.position.set(0, 35, 45);

    this.buildWorld();
    this.onResize();
    window.addEventListener('resize', () => this.onResize());
  }

  private buildWorld(): void {
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(400, 400),
      new THREE.MeshLambertMaterial({ color: 0x3d8c40 }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.05;
    this.scene.add(ground);

    const amb = new THREE.AmbientLight(0xffffff, 0.55);
    this.scene.add(amb);
    const sun = new THREE.DirectionalLight(0xfff2d6, 1.05);
    sun.position.set(40, 60, 20);
    this.scene.add(sun);
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
        const m = new THREE.Mesh(
          new THREE.BoxGeometry(2.4, 1.2, 0.6),
          new THREE.MeshLambertMaterial({ color: 0xe67e22 }),
        );
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
        const m = new THREE.Mesh(
          new THREE.BoxGeometry(2.2, 0.1, 2.8),
          new THREE.MeshLambertMaterial({ color: 0x2ecc71 }),
        );
        m.position.y = 0.1;
        return m;
      }
      case 'ramp': {
        const m = new THREE.Mesh(
          new THREE.BoxGeometry(2.4, 0.8, 2.2),
          new THREE.MeshLambertMaterial({ color: 0x9b59b6 }),
        );
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
    const mat = new THREE.MeshLambertMaterial({
      color: piece.onMainPath ? 0x2a2e35 : 0x3a4555,
    });
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

      // side walls
      const left = { x: -Math.cos(yaw), z: Math.sin(yaw) };
      for (const sign of [-1, 1]) {
        const wall = new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.9, len + 0.05), wallMat);
        wall.position.set(
          (a.x + b.x) / 2 + left.x * halfW * sign,
          0.45,
          (a.z + b.z) / 2 + left.z * halfW * sign,
        );
        wall.rotation.y = yaw;
        g.add(wall);
      }

      // center line dash
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

  syncTrack(pieces: TrackPiece[], sockets: TrackSocket[]): void {
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

    // Rebuild piece meshes if main-path flag may change colors — recreate when count changes is enough;
    // force refresh when piece set identity changes
    // Sockets
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
      if (this.selectedSocketId === s.id) {
        (mesh as THREE.Mesh).material = new THREE.MeshBasicMaterial({
          color: 0xff5a36,
          transparent: true,
          opacity: 0.9,
        });
      } else {
        (mesh as THREE.Mesh).material = new THREE.MeshBasicMaterial({
          color: 0x3ecf8e,
          transparent: true,
          opacity: 0.65,
        });
      }
    }
    for (const [id, mesh] of this.socketMeshes) {
      if (!sockSeen.has(id)) {
        this.scene.remove(mesh);
        this.socketMeshes.delete(id);
      }
    }

    // Finish line at first piece entry-ish
    if (pieces.length && !this.finishMesh) {
      const start = pieces.find((p) => p.onMainPath) || pieces[0];
      const fin = new THREE.Mesh(
        new THREE.BoxGeometry(TRACK.width, 0.08, 1.0),
        new THREE.MeshBasicMaterial({ color: 0xffffff }),
      );
      fin.position.set(start.x, 0.2, start.z);
      fin.rotation.y = start.yaw;
      this.finishMesh = fin;
      this.scene.add(fin);
    }
  }

  /** Full state sync (phase changes, lobby, placing) */
  sync(state: RoomState): void {
    this.players.clear();
    for (const p of state.players) this.players.set(p.id, p);

    this.syncTrack(state.trackPieces, state.trackSockets);

    const now = performance.now();
    const seen = new Set<string>();
    for (const car of state.cars) {
      seen.add(car.id);
      this.ensureCar(car, now);
      const cr = this.cars.get(car.id)!;
      cr.serverX = car.x;
      cr.serverZ = car.z;
      cr.serverYaw = car.yaw;
      cr.serverSpeed = car.speed;
      if (car.id === this.localId) {
        // Soft snap on phase start
        if (state.phase === 'countdown' || state.phase === 'racing') {
          const dx = car.x - cr.localX;
          const dz = car.z - cr.localZ;
          if (Math.hypot(dx, dz) > 8 || state.phase === 'countdown') {
            cr.localX = car.x;
            cr.localZ = car.z;
            cr.localYaw = car.yaw;
            cr.localSpeed = car.speed;
          }
        }
      } else {
        cr.from = { ...cr.to };
        cr.to = { x: car.x, z: car.z, yaw: car.yaw, t: now };
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

  /** High-rate car snapshots during race */
  applyCarsUpdate(update: CarsUpdate): void {
    const now = performance.now();
    this.lastCarsT = update.t;
    for (const car of update.cars) {
      const cr = this.cars.get(car.id);
      if (!cr) continue;
      cr.serverX = car.x;
      cr.serverZ = car.z;
      cr.serverYaw = car.yaw;
      cr.serverSpeed = car.speed;
      if (car.id === this.localId) {
        // Soft-correct local prediction toward server (no hard snap)
        const dx = car.x - cr.localX;
        const dz = car.z - cr.localZ;
        const err = Math.hypot(dx, dz);
        if (err > 12) {
          cr.localX = car.x;
          cr.localZ = car.z;
          cr.localYaw = car.yaw;
          cr.localSpeed = car.speed;
        } else {
          const k = err > 4 ? 0.25 : 0.12;
          cr.localX += dx * k;
          cr.localZ += dz * k;
          cr.localYaw = lerpAngle(cr.localYaw, car.yaw, k);
          cr.localSpeed = cr.localSpeed * (1 - k) + car.speed * k;
        }
      } else {
        cr.from = { ...cr.to };
        cr.to = { x: car.x, z: car.z, yaw: car.yaw, t: now };
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
      from: { x: car.x, z: car.z, yaw: car.yaw, t: now },
      to: { x: car.x, z: car.z, yaw: car.yaw, t: now },
      localX: car.x,
      localZ: car.z,
      localYaw: car.yaw,
      localSpeed: car.speed,
      serverX: car.x,
      serverZ: car.z,
      serverYaw: car.yaw,
      serverSpeed: car.speed,
    });
  }

  /** Client-side local prediction step */
  predictLocal(input: { forward: boolean; back: boolean; left: boolean; right: boolean; boost: boolean }, dt: number): void {
    const cr = this.cars.get(this.localId);
    if (!cr) return;
    if (cr.localSpeed === undefined) return;

    const turnRate = 2.6 + Math.min(Math.abs(cr.localSpeed) * 0.05, 1.2);
    if (input.left) cr.localYaw += turnRate * dt;
    if (input.right) cr.localYaw -= turnRate * dt;
    if (input.forward) cr.localSpeed += 30 * dt;
    if (input.back) cr.localSpeed -= 42 * dt;
    if (input.boost && cr.localSpeed > 4) cr.localSpeed += 26 * dt;
    cr.localSpeed *= Math.max(0, 1 - 1.0 * dt);
    if (!input.forward && !input.back) cr.localSpeed *= Math.max(0, 1 - 2.8 * dt);
    cr.localSpeed = Math.max(-12, Math.min(64, cr.localSpeed));
    cr.localX += Math.sin(cr.localYaw) * cr.localSpeed * dt;
    cr.localZ += Math.cos(cr.localYaw) * cr.localSpeed * dt;
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

  setGhostFromClick(x: number, z: number): void {
    this.ghostPos.x = x;
    this.ghostPos.z = z;
    // Select nearest socket if close
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
    if (raycaster.ray.intersectPlane(plane, hit)) {
      return { x: hit.x, z: hit.z };
    }
    return null;
  }

  start(): void {
    let last = performance.now();
    const loop = () => {
      this.animId = requestAnimationFrame(loop);
      const now = performance.now();
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      this.renderCars(now);
      this.updateCamera();
      this.renderer.render(this.scene, this.camera);
    };
    loop();
  }

  stop(): void {
    cancelAnimationFrame(this.animId);
  }

  private renderCars(now: number): void {
    for (const [id, cr] of this.cars) {
      if (!cr.mesh.visible) continue;
      if (id === this.localId) {
        cr.mesh.position.set(cr.localX, 0, cr.localZ);
        cr.mesh.rotation.y = cr.localYaw;
      } else {
        const span = Math.max(16, cr.to.t - cr.from.t);
        const t = Math.min(1, (now - cr.to.t + span) / span);
        // interpolate from→to, then lightly extrapolate if past
        const alpha = Math.min(1.15, Math.max(0, (now - cr.from.t) / span));
        const a = Math.min(alpha, 1);
        const x = cr.from.x + (cr.to.x - cr.from.x) * a;
        const z = cr.from.z + (cr.to.z - cr.from.z) * a;
        const yaw = lerpAngle(cr.from.yaw, cr.to.yaw, a);
        // if slightly past, extrapolate along last delta
        if (alpha > 1) {
          const ex = alpha - 1;
          cr.mesh.position.set(x + (cr.to.x - cr.from.x) * ex * 0.3, 0, z + (cr.to.z - cr.from.z) * ex * 0.3);
        } else {
          cr.mesh.position.set(x, 0, z);
        }
        cr.mesh.rotation.y = yaw;
      }
    }
  }

  private updateCamera(): void {
    if (this.placing) {
      const t = this.ghostPos;
      this.camera.position.lerp(new THREE.Vector3(t.x, 55, t.z + 10), 0.08);
      this.camera.lookAt(t.x, 0, t.z);
      return;
    }
    const cr = this.cars.get(this.localId);
    if (cr && cr.mesh.visible) {
      const yaw = cr.localYaw;
      const behind = new THREE.Vector3(
        cr.localX - Math.sin(yaw) * 14,
        8,
        cr.localZ - Math.cos(yaw) * 14,
      );
      this.camera.position.lerp(behind, 0.1);
      this.camera.lookAt(cr.localX, 1, cr.localZ);
    } else {
      this.camera.position.lerp(new THREE.Vector3(0, 50, 55), 0.05);
      this.camera.lookAt(0, 0, 0);
    }
  }
}
