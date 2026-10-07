import * as THREE from 'three';
import type { CarState, Obstacle, PlayerPublic, RoomState } from '../../../shared/types';
import { TRACK, OBSTACLE_LABELS } from '../../../shared/types';

const OUTER_R = TRACK.centerRadius + TRACK.trackWidth / 2;
const INNER_R = TRACK.centerRadius - TRACK.trackWidth / 2;

export class GameScene {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  private carMeshes = new Map<string, THREE.Group>();
  private obstacleMeshes = new Map<string, THREE.Object3D>();
  private ghost: THREE.Mesh | null = null;
  private placeMarker: THREE.Group | null = null;
  private animId = 0;
  private localId = '';
  private players = new Map<string, PlayerPublic>();
  canvas: HTMLCanvasElement;

  // Placement ghost position
  ghostPos = { x: 0, z: -TRACK.centerRadius, yaw: 0 };
  placing = false;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.setSize(canvas.clientWidth || innerWidth, canvas.clientHeight || innerHeight, false);
    this.renderer.setClearColor(0x87b5e0);

    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.Fog(0x87b5e0, 60, 140);

    this.camera = new THREE.PerspectiveCamera(55, 1, 0.1, 300);
    this.camera.position.set(0, 28, 40);

    this.buildWorld();
    this.onResize();
    window.addEventListener('resize', () => this.onResize());
  }

  private buildWorld(): void {
    // Ground
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(200, 200),
      new THREE.MeshLambertMaterial({ color: 0x3d8c40 }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.05;
    this.scene.add(ground);

    // Track ring (asphalt)
    const trackShape = new THREE.Shape();
    trackShape.absarc(0, 0, OUTER_R, 0, Math.PI * 2, false);
    const hole = new THREE.Path();
    hole.absarc(0, 0, INNER_R, 0, Math.PI * 2, true);
    trackShape.holes.push(hole);
    const trackGeo = new THREE.ExtrudeGeometry(trackShape, { depth: 0.15, bevelEnabled: false });
    trackGeo.rotateX(-Math.PI / 2);
    const track = new THREE.Mesh(trackGeo, new THREE.MeshLambertMaterial({ color: 0x2a2e35 }));
    this.scene.add(track);

    // Lane dashes (simple rings)
    const mid = new THREE.Mesh(
      new THREE.RingGeometry(TRACK.centerRadius - 0.15, TRACK.centerRadius + 0.15, 96),
      new THREE.MeshBasicMaterial({ color: 0xf5d76e, side: THREE.DoubleSide }),
    );
    mid.rotation.x = -Math.PI / 2;
    mid.position.y = 0.16;
    this.scene.add(mid);

    // Walls
    this.addWallRing(OUTER_R + 0.15, 0x8e9aab);
    this.addWallRing(INNER_R - 0.15, 0x8e9aab);

    // Start/finish checkered strip
    const finish = new THREE.Mesh(
      new THREE.BoxGeometry(TRACK.trackWidth, 0.08, 1.2),
      new THREE.MeshBasicMaterial({ color: 0xffffff }),
    );
    finish.position.set(0, 0.2, -TRACK.centerRadius);
    this.scene.add(finish);

    // Start banners poles
    for (const side of [-TRACK.trackWidth / 2 - 0.5, TRACK.trackWidth / 2 + 0.5]) {
      const pole = new THREE.Mesh(
        new THREE.CylinderGeometry(0.2, 0.2, 4, 8),
        new THREE.MeshLambertMaterial({ color: 0xeeeeee }),
      );
      pole.position.set(side, 2, -TRACK.centerRadius);
      this.scene.add(pole);
    }
    const banner = new THREE.Mesh(
      new THREE.BoxGeometry(TRACK.trackWidth + 1, 0.8, 0.15),
      new THREE.MeshLambertMaterial({ color: 0xff5a36 }),
    );
    banner.position.set(0, 3.6, -TRACK.centerRadius);
    this.scene.add(banner);

    // Lights
    const amb = new THREE.AmbientLight(0xffffff, 0.55);
    this.scene.add(amb);
    const sun = new THREE.DirectionalLight(0xfff2d6, 1.05);
    sun.position.set(30, 50, 20);
    this.scene.add(sun);

    // Infield decoration
    const infield = new THREE.Mesh(
      new THREE.CircleGeometry(INNER_R - 1, 48),
      new THREE.MeshLambertMaterial({ color: 0x4aa34f }),
    );
    infield.rotation.x = -Math.PI / 2;
    infield.position.y = 0.02;
    this.scene.add(infield);
  }

  private addWallRing(radius: number, color: number): void {
    const geo = new THREE.TorusGeometry(radius, 0.35, 6, 96);
    geo.rotateX(Math.PI / 2);
    const mesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ color }));
    mesh.position.y = 0.5;
    this.scene.add(mesh);
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

  sync(state: RoomState): void {
    this.players.clear();
    for (const p of state.players) this.players.set(p.id, p);

    // Cars
    const seen = new Set<string>();
    for (const car of state.cars) {
      seen.add(car.id);
      let mesh = this.carMeshes.get(car.id);
      if (!mesh) {
        const color = this.players.get(car.id)?.color || '#ffffff';
        mesh = this.makeCar(color);
        this.carMeshes.set(car.id, mesh);
        this.scene.add(mesh);
      }
      mesh.position.set(car.x, 0, car.z);
      mesh.rotation.y = car.yaw;
      mesh.visible = true;
    }
    for (const [id, mesh] of this.carMeshes) {
      if (!seen.has(id)) mesh.visible = false;
    }

    // Obstacles
    const obSeen = new Set<string>();
    for (const ob of state.obstacles) {
      obSeen.add(ob.id);
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
    for (const [id, mesh] of this.obstacleMeshes) {
      if (!obSeen.has(id)) {
        this.scene.remove(mesh);
        this.obstacleMeshes.delete(id);
      }
    }

    this.updateGhostVisibility();
  }

  setPlacing(active: boolean): void {
    this.placing = active;
    this.updateGhostVisibility();
  }

  private updateGhostVisibility(): void {
    if (this.placing) {
      if (!this.placeMarker) {
        const g = new THREE.Group();
        const ring = new THREE.Mesh(
          new THREE.RingGeometry(1.5, 2.0, 24),
          new THREE.MeshBasicMaterial({ color: 0x3ecf8e, side: THREE.DoubleSide, transparent: true, opacity: 0.8 }),
        );
        ring.rotation.x = -Math.PI / 2;
        ring.position.y = 0.25;
        g.add(ring);
        this.placeMarker = g;
        this.scene.add(g);
      }
      this.placeMarker.visible = true;
      this.placeMarker.position.set(this.ghostPos.x, 0, this.ghostPos.z);
      this.placeMarker.rotation.y = this.ghostPos.yaw;
    } else if (this.placeMarker) {
      this.placeMarker.visible = false;
    }
  }

  moveGhost(dx: number, dz: number, dyaw: number): void {
    this.ghostPos.x += dx;
    this.ghostPos.z += dz;
    this.ghostPos.yaw += dyaw;
    // Soft clamp to track annulus
    const d = Math.hypot(this.ghostPos.x, this.ghostPos.z) || 0.001;
    const minR = INNER_R + 1.5;
    const maxR = OUTER_R - 1.5;
    if (d < minR) {
      this.ghostPos.x = (this.ghostPos.x / d) * minR;
      this.ghostPos.z = (this.ghostPos.z / d) * minR;
    } else if (d > maxR) {
      this.ghostPos.x = (this.ghostPos.x / d) * maxR;
      this.ghostPos.z = (this.ghostPos.z / d) * maxR;
    }
    this.updateGhostVisibility();
  }

  setGhostFromClick(x: number, z: number): void {
    this.ghostPos.x = x;
    this.ghostPos.z = z;
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
    const loop = () => {
      this.animId = requestAnimationFrame(loop);
      this.updateCamera();
      this.renderer.render(this.scene, this.camera);
    };
    loop();
  }

  stop(): void {
    cancelAnimationFrame(this.animId);
  }

  private updateCamera(): void {
    if (this.placing) {
      // Top-down-ish for placement
      const t = this.ghostPos;
      this.camera.position.lerp(new THREE.Vector3(t.x, 45, t.z + 8), 0.08);
      this.camera.lookAt(t.x, 0, t.z);
      return;
    }
    const car = this.carMeshes.get(this.localId);
    if (car && car.visible) {
      const behind = new THREE.Vector3(
        car.position.x - Math.sin(car.rotation.y) * 12,
        7,
        car.position.z - Math.cos(car.rotation.y) * 12,
      );
      this.camera.position.lerp(behind, 0.12);
      this.camera.lookAt(car.position.x, 1, car.position.z);
    } else {
      this.camera.position.lerp(new THREE.Vector3(0, 40, 50), 0.05);
      this.camera.lookAt(0, 0, 0);
    }
  }
}

export { OBSTACLE_LABELS };
