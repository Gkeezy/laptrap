import * as THREE from 'three';
import type { FruitType } from '../../../shared/types';

/**
 * Low-poly running fruit characters (original art, built from primitives).
 * Hierarchy: root (position/yaw) -> body (bob/squash) + legL/legR (hip pivots) + armL/armR.
 */
export interface FruitParts {
  body: THREE.Group;
  legL: THREE.Group;
  legR: THREE.Group;
  armL: THREE.Group;
  armR: THREE.Group;
  baseY: number;
  phase: number;
  lastX: number;
  lastZ: number;
  speedEst: number;
}

const lam = (color: number | string) => new THREE.MeshLambertMaterial({ color, flatShading: true });

function sphere(r: number, color: number | string, w = 8, h = 6): THREE.Mesh {
  return new THREE.Mesh(new THREE.SphereGeometry(r, w, h), lam(color));
}

function stem(len = 0.35, color: number | string = 0x5d3a1a): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.08, len, 5), lam(color));
  return m;
}

function leaf(color: number | string = 0x3fa34d, s = 0.35): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.ConeGeometry(s * 0.45, s, 4), lam(color));
  m.scale.z = 0.35;
  return m;
}

/** Builds the fruit body (centered roughly on origin, ~1.6 tall). Returns body group + face height/depth. */
function buildBody(type: FruitType): { g: THREE.Group; faceY: number; faceZ: number } {
  const g = new THREE.Group();
  switch (type) {
    case 'apple': {
      const b = sphere(0.85, 0xe23b2e, 10, 8);
      b.scale.y = 0.92;
      g.add(b);
      const s = stem(); s.position.y = 0.9; g.add(s);
      const l = leaf(); l.position.set(0.18, 0.95, 0); l.rotation.z = -1.0; g.add(l);
      return { g, faceY: 0.1, faceZ: 0.8 };
    }
    case 'banana': {
      // curved banana from stacked tilted segments
      const mat = lam(0xf7d046);
      for (let i = 0; i < 5; i++) {
        const t = i / 4 - 0.5;
        const seg = new THREE.Mesh(new THREE.CylinderGeometry(0.42 - Math.abs(t) * 0.35, 0.42 - Math.abs(t) * 0.35, 0.5, 7), mat);
        seg.position.set(0, t * 1.7, Math.cos(t * 2.2) * 0.35 - 0.25);
        seg.rotation.x = -t * 1.3;
        g.add(seg);
      }
      const tip = stem(0.25, 0x4a3410); tip.position.set(0, 1.0, -0.05); tip.rotation.x = 0.6; g.add(tip);
      return { g, faceY: 0.05, faceZ: 0.5 };
    }
    case 'orange': {
      const b = sphere(0.85, 0xf39c12, 10, 8);
      g.add(b);
      const l = leaf(0x2e8b3a, 0.3); l.position.set(0, 0.88, 0); l.rotation.z = 0.5; g.add(l);
      return { g, faceY: 0.1, faceZ: 0.82 };
    }
    case 'strawberry': {
      const b = new THREE.Mesh(new THREE.ConeGeometry(0.8, 1.6, 9), lam(0xe8304a));
      b.rotation.x = Math.PI; // point down
      g.add(b);
      // seeds
      const seedMat = lam(0xffe08a);
      for (let i = 0; i < 14; i++) {
        const a = (i / 14) * Math.PI * 2;
        const yy = ((i * 37) % 10) / 10 - 0.3;
        const r = 0.8 * (0.5 - yy / 1.6) + 0.02;
        const sd = new THREE.Mesh(new THREE.SphereGeometry(0.05, 4, 3), seedMat);
        sd.position.set(Math.sin(a) * r, yy, Math.cos(a) * r);
        g.add(sd);
      }
      for (let i = 0; i < 5; i++) {
        const l = leaf(0x2f9e44, 0.4);
        const a = (i / 5) * Math.PI * 2;
        l.position.set(Math.sin(a) * 0.35, 0.82, Math.cos(a) * 0.35);
        l.rotation.set(Math.cos(a) * 1.2, 0, -Math.sin(a) * 1.2);
        g.add(l);
      }
      return { g, faceY: 0.2, faceZ: 0.55 };
    }
    case 'watermelon': {
      // a wedge slice: green rind, red flesh, black seeds
      const shape = new THREE.Shape();
      shape.moveTo(-1, 0);
      shape.absarc(0, 0, 1, Math.PI, 0, true);
      shape.lineTo(-1, 0);
      const geo = new THREE.ExtrudeGeometry(shape, { depth: 0.45, bevelEnabled: false, curveSegments: 8 });
      geo.translate(0, 0, -0.225);
      const flesh = new THREE.Mesh(geo, lam(0xff4d5e));
      flesh.rotation.z = Math.PI; // dome down, flat edge up
      flesh.position.y = 0.45;
      flesh.scale.set(0.9, 1.1, 1);
      g.add(flesh);
      const rind = new THREE.Mesh(new THREE.TorusGeometry(0.98, 0.1, 4, 12, Math.PI), lam(0x2e9e4f));
      rind.rotation.z = Math.PI;
      rind.position.y = 0.45;
      rind.scale.set(0.9, 1.1, 2.4);
      g.add(rind);
      const seedMat = lam(0x111111);
      for (const [sx, sy] of [[-0.35, 0.05], [0.3, 0.0], [0, -0.3], [-0.15, -0.05], [0.15, -0.25]]) {
        for (const side of [1, -1]) {
          const sd = new THREE.Mesh(new THREE.SphereGeometry(0.05, 4, 3), seedMat);
          sd.scale.y = 1.6;
          sd.position.set(sx, sy, side * 0.23);
          g.add(sd);
        }
      }
      return { g, faceY: 0.2, faceZ: 0.25 };
    }
    case 'pineapple': {
      const b = new THREE.Mesh(new THREE.CylinderGeometry(0.62, 0.7, 1.4, 8), lam(0xd4a017));
      b.scale.set(1, 1, 1);
      g.add(b);
      const crossMat = lam(0x9c6b0e);
      for (let i = 0; i < 8; i++) {
        const ring = new THREE.Mesh(new THREE.TorusGeometry(0.66, 0.03, 3, 8), crossMat);
        ring.rotation.x = Math.PI / 2;
        ring.position.y = -0.55 + i * 0.16;
        g.add(ring);
      }
      for (let i = 0; i < 6; i++) {
        const l = leaf(0x2f8f3a, 0.8);
        const a = (i / 6) * Math.PI * 2;
        l.position.set(Math.sin(a) * 0.15, 1.05, Math.cos(a) * 0.15);
        l.rotation.set(Math.cos(a) * 0.4, 0, -Math.sin(a) * 0.4);
        g.add(l);
      }
      return { g, faceY: 0.15, faceZ: 0.68 };
    }
    case 'grapes': {
      const mat = lam(0x8e44ad);
      const rows = [3, 3, 2, 1];
      let y = 0.55;
      for (const n of rows) {
        for (let i = 0; i < n; i++) {
          const a = (i / n) * Math.PI * 2 + y;
          const r = n === 1 ? 0 : 0.32;
          const gr = new THREE.Mesh(new THREE.SphereGeometry(0.34, 7, 5), mat);
          gr.position.set(Math.sin(a) * r, y, Math.cos(a) * r);
          g.add(gr);
        }
        y -= 0.42;
      }
      const s = stem(0.4, 0x5d3a1a); s.position.y = 0.95; g.add(s);
      const l = leaf(0x3fa34d, 0.45); l.position.set(0.2, 1.0, 0); l.rotation.z = -1.1; g.add(l);
      return { g, faceY: 0.25, faceZ: 0.62 };
    }
    case 'lemon': {
      const b = sphere(0.75, 0xfff176, 10, 8);
      b.scale.set(1, 0.95, 1.25);
      b.rotation.y = Math.PI / 2; // long axis sideways
      g.add(b);
      for (const sx of [-1, 1]) {
        const nub = new THREE.Mesh(new THREE.ConeGeometry(0.18, 0.3, 6), lam(0xfff176));
        nub.rotation.z = -sx * Math.PI / 2;
        nub.position.x = sx * 0.95;
        g.add(nub);
      }
      return { g, faceY: 0.05, faceZ: 0.72 };
    }
    case 'cherry': {
      // two cherries joined by stems; main one is the "body"
      const main = sphere(0.7, 0xb0122b, 10, 8);
      main.position.set(-0.15, -0.1, 0);
      g.add(main);
      const twin = sphere(0.45, 0xb0122b, 8, 6);
      twin.position.set(0.7, 0.15, -0.35);
      g.add(twin);
      const s1 = stem(0.9, 0x3d7a2a); s1.position.set(0.05, 0.85, -0.1); s1.rotation.z = -0.35; g.add(s1);
      const s2 = stem(0.7, 0x3d7a2a); s2.position.set(0.5, 0.75, -0.25); s2.rotation.z = 0.5; g.add(s2);
      const l = leaf(0x3fa34d, 0.5); l.position.set(0.35, 1.25, -0.15); l.rotation.z = -1.2; g.add(l);
      return { g, faceY: 0.0, faceZ: 0.66 };
    }
    case 'pear': {
      const bottom = sphere(0.78, 0xa8d04a, 10, 8);
      bottom.position.y = -0.25;
      g.add(bottom);
      const top = sphere(0.48, 0xa8d04a, 8, 6);
      top.position.y = 0.5;
      g.add(top);
      const s = stem(0.35); s.position.y = 1.05; s.rotation.z = 0.25; g.add(s);
      const l = leaf(); l.position.set(-0.18, 1.05, 0); l.rotation.z = 1.0; g.add(l);
      return { g, faceY: -0.05, faceZ: 0.74 };
    }
  }
}

function addFace(g: THREE.Group, y: number, z: number): void {
  const white = new THREE.MeshBasicMaterial({ color: 0xffffff });
  const black = new THREE.MeshBasicMaterial({ color: 0x111111 });
  for (const sx of [-0.22, 0.22]) {
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.15, 8, 6), white);
    eye.position.set(sx, y + 0.15, z);
    eye.scale.z = 0.6;
    g.add(eye);
    const pupil = new THREE.Mesh(new THREE.SphereGeometry(0.075, 6, 4), black);
    pupil.position.set(sx, y + 0.15, z + 0.09);
    g.add(pupil);
  }
  const mouth = new THREE.Mesh(new THREE.TorusGeometry(0.11, 0.03, 4, 8, Math.PI), black);
  mouth.rotation.z = Math.PI;
  mouth.position.set(0, y - 0.1, z + 0.02);
  g.add(mouth);
}

function makeLimb(len: number, thick: number, footColor: number, foot: boolean): THREE.Group {
  const pivot = new THREE.Group();
  const limb = new THREE.Mesh(new THREE.CylinderGeometry(thick, thick, len, 5), lam(0x3b2a1a));
  limb.position.y = -len / 2;
  pivot.add(limb);
  if (foot) {
    const shoe = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.16, 0.42), lam(footColor));
    shoe.position.set(0, -len, 0.08);
    pivot.add(shoe);
  } else {
    const hand = new THREE.Mesh(new THREE.SphereGeometry(0.1, 6, 4), lam(0xffffff));
    hand.position.y = -len;
    pivot.add(hand);
  }
  return pivot;
}

const LEG_LEN = 0.75;
const BODY_Y = LEG_LEN + 0.15 + 0.8; // feet on ground

export function makeFruit(type: FruitType, accent: string): THREE.Group {
  const root = new THREE.Group();
  const { g: shape, faceY, faceZ } = buildBody(type);
  addFace(shape, faceY, faceZ);
  const body = new THREE.Group();
  body.add(shape);
  body.position.y = BODY_Y;
  root.add(body);

  const shoeColor = new THREE.Color(accent).multiplyScalar(0.6).getHex();
  const hipY = BODY_Y - 0.7;
  const legL = makeLimb(LEG_LEN, 0.07, shoeColor, true);
  const legR = makeLimb(LEG_LEN, 0.07, shoeColor, true);
  legL.position.set(-0.28, hipY + 0.05, 0);
  legR.position.set(0.28, hipY + 0.05, 0);
  root.add(legL, legR);

  const armL = makeLimb(0.55, 0.05, 0, false);
  const armR = makeLimb(0.55, 0.05, 0, false);
  armL.position.set(-0.78, BODY_Y, 0);
  armR.position.set(0.78, BODY_Y, 0);
  armL.rotation.z = -0.35;
  armR.rotation.z = 0.35;
  body.add(armL, armR);
  armL.position.y = 0; armR.position.y = 0;

  // simple blob shadow
  const shadow = new THREE.Mesh(
    new THREE.CircleGeometry(0.7, 12),
    new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.25, depthWrite: false }),
  );
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = 0.03;
  shadow.name = 'shadow';
  root.add(shadow);

  root.scale.setScalar(0.95);
  const parts: FruitParts = { body, legL, legR, armL, armR, baseY: BODY_Y, phase: Math.random() * 6, lastX: 0, lastZ: 0, speedEst: 0 };
  root.userData.fruit = parts;
  return root;
}

/**
 * Animate run cycle / idle / jump.
 * speed: ground speed (units/s), airborne: in the air, dt: seconds.
 */
export function animateFruit(root: THREE.Group, speed: number, airborne: boolean, dt: number, now: number): void {
  const p = root.userData.fruit as FruitParts | undefined;
  if (!p) return;
  const s = Math.abs(speed);
  const runAmt = Math.min(1, s / 10);
  const back = speed < -0.5 ? -1 : 1;
  // keep blob shadow on the ground while hopping, shrink with height
  const sh = root.getObjectByName('shadow');
  if (sh) {
    const h = Math.max(0, root.position.y);
    sh.position.y = 0.03 - h / (root.scale.y || 1);
    const k = Math.max(0.4, 1 - h * 0.15);
    sh.scale.set(k, k, k);
  }

  if (airborne) {
    // Jump pose: legs tucked, arms up, stretched body
    p.legL.rotation.x += (-0.9 - p.legL.rotation.x) * Math.min(1, dt * 14);
    p.legR.rotation.x += (-0.5 - p.legR.rotation.x) * Math.min(1, dt * 14);
    p.armL.rotation.x += (-2.6 - p.armL.rotation.x) * Math.min(1, dt * 12);
    p.armR.rotation.x += (-2.6 - p.armR.rotation.x) * Math.min(1, dt * 12);
    p.body.scale.set(0.92, 1.12, 0.92);
    p.body.position.y = p.baseY + 0.1;
    p.body.rotation.x = 0;
  } else if (s > 0.6) {
    // Run cycle: stride frequency scales with speed
    p.phase += dt * (6 + s * 0.42) * back;
    const sw = Math.sin(p.phase);
    const amp = 0.35 + runAmt * 0.65;
    p.legL.rotation.x = sw * amp;
    p.legR.rotation.x = -sw * amp;
    p.armL.rotation.x = -sw * amp * 0.9;
    p.armR.rotation.x = sw * amp * 0.9;
    const bounce = Math.abs(Math.cos(p.phase));
    p.body.position.y = p.baseY + bounce * 0.28 * runAmt;
    // squash on footfall, stretch mid-stride
    const sq = 1 - (1 - bounce) * 0.12 * runAmt;
    p.body.scale.set(1 + (1 - sq) * 0.6, sq, 1 + (1 - sq) * 0.6);
    p.body.rotation.x = 0.18 * runAmt * back; // lean into run
  } else {
    // Idle: breathe + small sway, legs settle
    const k = Math.min(1, dt * 10);
    p.legL.rotation.x += (0 - p.legL.rotation.x) * k;
    p.legR.rotation.x += (0 - p.legR.rotation.x) * k;
    p.armL.rotation.x += (Math.sin(now / 600) * 0.12 - p.armL.rotation.x) * k;
    p.armR.rotation.x += (-Math.sin(now / 600) * 0.12 - p.armR.rotation.x) * k;
    const br = Math.sin(now / 380) * 0.035;
    p.body.scale.set(1 - br * 0.5, 1 + br, 1 - br * 0.5);
    p.body.position.y = p.baseY;
    p.body.rotation.x = 0;
  }
}

/** Estimate speed for remote players from rendered position deltas (smoothed). */
export function estimateRemoteSpeed(root: THREE.Group, dt: number): number {
  const p = root.userData.fruit as FruitParts | undefined;
  if (!p || dt <= 0) return 0;
  const d = Math.hypot(root.position.x - p.lastX, root.position.z - p.lastZ);
  p.lastX = root.position.x;
  p.lastZ = root.position.z;
  const inst = Math.min(80, d / dt);
  p.speedEst += (inst - p.speedEst) * Math.min(1, dt * 8);
  return p.speedEst;
}
