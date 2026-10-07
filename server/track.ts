/**
 * Piece-based expandable track.
 * Starter = straight line (4 straights). Open end sockets at both tips.
 * START is fixed at the original entry; FINISH follows the farthest main-path tip.
 * When pieces reconnect into a loop, markers coincide (combined gate).
 */

import {
  TRACK,
  TrackPiece,
  TrackPieceType,
  TrackSocket,
  RaceMarkers,
} from '../shared/types.js';

export interface Waypoint {
  x: number;
  z: number;
  yaw: number;
  dist: number;
  pieceId: string;
}

export interface TrackWorld {
  pieces: TrackPiece[];
  sockets: TrackSocket[];
  mainPath: string[];
  waypoints: Waypoint[];
  totalLength: number;
  pieceSeq: number;
  socketSeq: number;
  /** Fixed start pose (never moves) */
  startMarker: { x: number; z: number; yaw: number };
  /** Finish at farthest tip — updates when path grows */
  finishMarker: { x: number; z: number; yaw: number };
  isLoop: boolean;
}

function forward(yaw: number): { x: number; z: number } {
  return { x: Math.sin(yaw), z: Math.cos(yaw) };
}
function leftOf(yaw: number): { x: number; z: number } {
  return { x: -Math.cos(yaw), z: Math.sin(yaw) };
}
function rightOf(yaw: number): { x: number; z: number } {
  return { x: Math.cos(yaw), z: -Math.sin(yaw) };
}

export function pieceExit(piece: TrackPiece): { x: number; z: number; yaw: number } {
  const { straightLen: L, curveRadius: R } = TRACK;
  if (piece.type === 'straight') {
    const f = forward(piece.yaw);
    return { x: piece.x + f.x * L, z: piece.z + f.z * L, yaw: piece.yaw };
  }
  const sweep = Math.PI / 2;
  const side = piece.type === 'curveL' ? leftOf(piece.yaw) : rightOf(piece.yaw);
  const sign = piece.type === 'curveL' ? 1 : -1;
  const cx = piece.x + side.x * R;
  const cz = piece.z + side.z * R;
  const relX = piece.x - cx;
  const relZ = piece.z - cz;
  const t = sign * sweep;
  const cos = Math.cos(t);
  const sin = Math.sin(t);
  return {
    x: cx + relX * cos - relZ * sin,
    z: cz + relX * sin + relZ * cos,
    yaw: piece.yaw + t,
  };
}

export function samplePiece(piece: TrackPiece, steps = 8): Array<{ x: number; z: number; yaw: number }> {
  const pts: Array<{ x: number; z: number; yaw: number }> = [];
  const { straightLen: L, curveRadius: R } = TRACK;
  if (piece.type === 'straight') {
    const f = forward(piece.yaw);
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      pts.push({ x: piece.x + f.x * L * t, z: piece.z + f.z * L * t, yaw: piece.yaw });
    }
    return pts;
  }
  const sweep = Math.PI / 2;
  const side = piece.type === 'curveL' ? leftOf(piece.yaw) : rightOf(piece.yaw);
  const sign = piece.type === 'curveL' ? 1 : -1;
  const cx = piece.x + side.x * R;
  const cz = piece.z + side.z * R;
  const relX0 = piece.x - cx;
  const relZ0 = piece.z - cz;
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

function pieceLength(type: TrackPieceType): number {
  if (type === 'straight') return TRACK.straightLen;
  return (Math.PI / 2) * TRACK.curveRadius;
}

function midSideSocket(piece: TrackPiece): { x: number; z: number; yaw: number } {
  const samples = samplePiece(piece, 4);
  const mid = samples[Math.floor(samples.length / 2)];
  const out = rightOf(mid.yaw);
  const half = TRACK.width / 2 + 0.5;
  return {
    x: mid.x + out.x * half,
    z: mid.z + out.z * half,
    yaw: Math.atan2(out.x, out.z),
  };
}

function rebuildWaypoints(world: TrackWorld): void {
  const byId = new Map(world.pieces.map((p) => [p.id, p]));
  const wps: Waypoint[] = [];
  let dist = 0;
  for (const id of world.mainPath) {
    const piece = byId.get(id);
    if (!piece) continue;
    const samples = samplePiece(piece, 10);
    for (let i = 0; i < samples.length; i++) {
      if (i > 0) {
        dist += Math.hypot(samples[i].x - samples[i - 1].x, samples[i].z - samples[i - 1].z);
      }
      wps.push({ ...samples[i], dist, pieceId: id });
    }
  }
  world.waypoints = wps;
  world.totalLength = dist || 1;
}

/** Update finish marker to tip of main path; detect loop if tip reconnects near start */
function updateMarkers(world: TrackWorld): void {
  const byId = new Map(world.pieces.map((p) => [p.id, p]));
  if (!world.mainPath.length) return;

  const lastId = world.mainPath[world.mainPath.length - 1];
  const last = byId.get(lastId);
  if (!last) return;
  const tip = pieceExit(last);

  const dx = tip.x - world.startMarker.x;
  const dz = tip.z - world.startMarker.z;
  const nearStart = Math.hypot(dx, dz) < 5;
  // Also loop if tip is near first piece entry and path is long enough
  world.isLoop = nearStart && world.mainPath.length >= 6;

  if (world.isLoop) {
    // Combined gate at start
    world.finishMarker = { ...world.startMarker };
  } else {
    world.finishMarker = { x: tip.x, z: tip.z, yaw: tip.yaw };
  }
}

function rebuildSockets(world: TrackWorld): void {
  const sockets: TrackSocket[] = [];
  const byId = new Map(world.pieces.map((p) => [p.id, p]));

  // End sockets: free tips of main path (both ends for open line)
  if (world.mainPath.length && !world.isLoop) {
    const firstId = world.mainPath[0];
    const lastId = world.mainPath[world.mainPath.length - 1];
    const first = byId.get(firstId);
    const last = byId.get(lastId);
    if (first) {
      // Backward tip: opposite of entry yaw
      const backYaw = first.yaw + Math.PI;
      sockets.push({
        id: `sock-${world.socketSeq++}`,
        x: first.x,
        z: first.z,
        yaw: backYaw,
        fromPieceId: first.id,
        kind: 'end',
      });
    }
    if (last) {
      const tip = pieceExit(last);
      sockets.push({
        id: `sock-${world.socketSeq++}`,
        x: tip.x,
        z: tip.z,
        yaw: tip.yaw,
        fromPieceId: last.id,
        kind: 'end',
      });
    }
  }

  // Side sockets
  for (const piece of world.pieces) {
    const side = midSideSocket(piece);
    const occupied = world.pieces.some((other) => {
      if (other.id === piece.id) return false;
      return Math.hypot(other.x - side.x, other.z - side.z) < 3.5;
    });
    if (!occupied) {
      sockets.push({
        id: `sock-${world.socketSeq++}`,
        x: side.x,
        z: side.z,
        yaw: side.yaw,
        fromPieceId: piece.id,
        kind: 'side',
      });
    }
  }

  // Free ends of non-main spurs
  for (const piece of world.pieces) {
    if (piece.onMainPath) continue;
    const exit = pieceExit(piece);
    const connects = world.pieces.some((other) => {
      if (other.id === piece.id) return false;
      return Math.hypot(other.x - exit.x, other.z - exit.z) < 3.5;
    });
    if (!connects) {
      sockets.push({
        id: `sock-${world.socketSeq++}`,
        x: exit.x,
        z: exit.z,
        yaw: exit.yaw,
        fromPieceId: piece.id,
        kind: 'end',
      });
    }
  }

  world.sockets = sockets;
}

export function getMarkers(world: TrackWorld): RaceMarkers {
  return {
    start: { ...world.startMarker },
    finish: { ...world.finishMarker },
    isLoop: world.isLoop,
  };
}

export function createStarterTrack(): TrackWorld {
  const world: TrackWorld = {
    pieces: [],
    sockets: [],
    mainPath: [],
    waypoints: [],
    totalLength: 0,
    pieceSeq: 0,
    socketSeq: 0,
    startMarker: { x: 0, z: 0, yaw: 0 },
    finishMarker: { x: 0, z: 0, yaw: 0 },
    isLoop: false,
  };

  // Straight line along +Z: 4 straights
  let x = 0;
  let z = -TRACK.straightLen * 2;
  let yaw = 0; // +Z

  world.startMarker = { x, z, yaw };

  for (let i = 0; i < 4; i++) {
    const id = `tp-${++world.pieceSeq}`;
    const piece: TrackPiece = { id, type: 'straight', x, z, yaw, placedBy: null, onMainPath: true };
    world.pieces.push(piece);
    world.mainPath.push(id);
    const exit = pieceExit(piece);
    x = exit.x;
    z = exit.z;
    yaw = exit.yaw;
  }

  rebuildWaypoints(world);
  updateMarkers(world);
  rebuildSockets(world);
  return world;
}

export function getSpawnPose(world: TrackWorld, index: number): { x: number; z: number; yaw: number; wpIndex: number } {
  const wps = world.waypoints;
  if (!wps.length) {
    const s = world.startMarker;
    return { x: s.x, z: s.z, yaw: s.yaw, wpIndex: 0 };
  }
  // Grid just AFTER the start line
  const lane = (index % 2 === 0 ? -1 : 1) * (2.0 + Math.floor(index / 2) * 0.1);
  const forwardDist = 3 + Math.floor(index / 2) * 2.8;
  let wp = wps[0];
  let wpIndex = 0;
  for (let i = 0; i < wps.length; i++) {
    if (wps[i].dist >= forwardDist) {
      wp = wps[i];
      wpIndex = i;
      break;
    }
  }
  const lateral = leftOf(wp.yaw);
  return {
    x: wp.x + lateral.x * lane,
    z: wp.z + lateral.z * lane,
    yaw: wp.yaw,
    wpIndex,
  };
}

export function worldToProgress(
  world: TrackWorld,
  x: number,
  z: number,
  hintIdx = 0,
): { progress: number; dist: number; onTrack: boolean; nearestDist: number; wpIndex: number } {
  const wps = world.waypoints;
  if (!wps.length) return { progress: 0, dist: 0, onTrack: false, nearestDist: 999, wpIndex: 0 };

  const n = wps.length;
  const prev = ((hintIdx % n) + n) % n;
  let best = prev;
  let bestD = Math.hypot(wps[prev].x - x, wps[prev].z - z);
  const window = Math.max(20, Math.floor(n / 2));
  for (let k = 1; k <= window; k++) {
    const i = (prev + k) % n;
    const d = Math.hypot(wps[i].x - x, wps[i].z - z);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  const goingBackward = best < prev && !(world.isLoop && prev > n * 0.7 && best < n * 0.15);
  if (goingBackward) {
    best = prev;
    bestD = Math.hypot(wps[prev].x - x, wps[prev].z - z);
  }

  let nearestDist = bestD;
  for (const piece of world.pieces) {
    if (piece.onMainPath) continue;
    for (const s of samplePiece(piece, 5)) {
      const d = Math.hypot(s.x - x, s.z - z);
      if (d < nearestDist) nearestDist = d;
    }
  }

  const halfW = TRACK.width / 2 + 1.2;
  return {
    progress: wps[best].dist / world.totalLength,
    dist: wps[best].dist,
    onTrack: nearestDist <= halfW,
    nearestDist,
    wpIndex: best,
  };
}

/** Crossing finish: was behind finish plane, now in front, along path */
export function crossedFinishLine(
  world: TrackWorld,
  prevX: number,
  prevZ: number,
  x: number,
  z: number,
  minProgress = 0.55,
  currentProgress = 0,
): boolean {
  if (currentProgress < minProgress && !world.isLoop) {
    // Point-to-point: must be most of the way along the path
    if (currentProgress < 0.7) return false;
  }
  if (world.isLoop && currentProgress < 0.55) return false;

  const fin = world.finishMarker;
  const f = forward(fin.yaw);
  // Plane at finish facing along travel: signed distance along forward
  const prevDot = (prevX - fin.x) * f.x + (prevZ - fin.z) * f.z;
  const nowDot = (x - fin.x) * f.x + (z - fin.z) * f.z;
  // Crossed from behind (negative) to ahead (positive)
  if (!(prevDot < 0.5 && nowDot >= 0)) return false;
  // Must be laterally near the finish strip
  const lateral = leftOf(fin.yaw);
  const lat = (x - fin.x) * lateral.x + (z - fin.z) * lateral.z;
  return Math.abs(lat) < TRACK.width / 2 + 1.5;
}

export function clampToTrack(world: TrackWorld, x: number, z: number): { x: number; z: number; hit: boolean } {
  const halfW = TRACK.width / 2;
  let bestX = x;
  let bestZ = z;
  let bestD = Infinity;
  let bestYaw = 0;

  const consider = (px: number, pz: number, yaw: number) => {
    const d = Math.hypot(px - x, pz - z);
    if (d < bestD) {
      bestD = d;
      bestX = px;
      bestZ = pz;
      bestYaw = yaw;
    }
  };

  for (const piece of world.pieces) {
    for (const s of samplePiece(piece, 12)) consider(s.x, s.z, s.yaw);
  }

  if (bestD <= halfW) return { x, z, hit: false };

  const lateral = leftOf(bestYaw);
  let lat = (x - bestX) * lateral.x + (z - bestZ) * lateral.z;
  lat = Math.max(-halfW, Math.min(halfW, lat));
  return {
    x: bestX + lateral.x * lat,
    z: bestZ + lateral.z * lat,
    hit: true,
  };
}

export function isValidObstaclePlacement(world: TrackWorld, x: number, z: number): boolean {
  const { onTrack, nearestDist } = worldToProgress(world, x, z);
  return onTrack && nearestDist < TRACK.width / 2 - 1;
}


/** True if within asphalt half-width of any piece centerline */
export function isOnAsphalt(world: TrackWorld, x: number, z: number): boolean {
  const halfW = TRACK.width / 2 + 0.35;
  let best = Infinity;
  for (const piece of world.pieces) {
    for (const s of samplePiece(piece, 10)) {
      const d = Math.hypot(s.x - x, s.z - z);
      if (d < best) best = d;
    }
  }
  return best <= halfW;
}

/** Surface height at position (ramps raise the road) — base 0 */
export function surfaceHeightAt(
  world: TrackWorld,
  obstacles: Array<{ type: string; x: number; z: number; yaw: number }>,
  x: number,
  z: number,
): { y: number; rampBoost: number } {
  let y = 0;
  let rampBoost = 0;
  for (const ob of obstacles) {
    if (ob.type !== 'ramp') continue;
    const dx = x - ob.x;
    const dz = z - ob.z;
    // Local coords along ramp facing
    const fx = Math.sin(ob.yaw);
    const fz = Math.cos(ob.yaw);
    const along = dx * fx + dz * fz;
    const lat = dx * (-fz) + dz * fx; // rough lateral
    if (Math.abs(lat) < 2.2 && along > -1.2 && along < 3.5) {
      // Rising slope: 0 at entry → ~2.2 at crest
      const t = Math.max(0, Math.min(1, (along + 1.2) / 4.5));
      const h = t * 2.4;
      if (h > y) {
        y = h;
        rampBoost = 14 + t * 18; // upward kick when on ramp face
      }
    }
  }
  return { y, rampBoost };
}

export function placeTrackPiece(
  world: TrackWorld,
  type: TrackPieceType,
  socketId: string,
  placedBy: string,
): { ok: boolean; error?: string } {
  const sock = world.sockets.find((s) => s.id === socketId);
  if (!sock) return { ok: false, error: 'Invalid socket' };

  const piece: TrackPiece = {
    id: `tp-${++world.pieceSeq}`,
    type,
    x: sock.x,
    z: sock.z,
    yaw: sock.yaw,
    placedBy,
    onMainPath: false,
  };

  for (const other of world.pieces) {
    if (other.id === sock.fromPieceId) continue;
    // Allow attaching at an exit tip; only reject near-duplicate entries
    if (Math.hypot(other.x - piece.x, other.z - piece.z) < 2.5) {
      return { ok: false, error: 'Blocked' };
    }
  }

  world.pieces.push(piece);
  const exit = pieceExit(piece);

  // Extending from a main-path END socket → grow main path + move finish
  if (sock.kind === 'end') {
    const lastId = world.mainPath[world.mainPath.length - 1];
    const firstId = world.mainPath[0];
    if (sock.fromPieceId === lastId) {
      // Extending forward tip
      piece.onMainPath = true;
      world.mainPath.push(piece.id);
    } else if (sock.fromPieceId === firstId) {
      // Extending backward from start — prepend, keep start marker fixed
      // New piece entry is behind start; we still keep startMarker at original
      piece.onMainPath = true;
      world.mainPath.unshift(piece.id);
      // Rebuild path direction: if we prepend going backward, path order may be wrong.
      // For simplicity: only allow forward tip to extend main finish; backward extends
      // as spur unless it forms a loop. Revert prepend — treat as spur from start end.
      world.mainPath.shift();
      piece.onMainPath = false;
    }
  }

  // Snap reconnect
  const snapR = 4.5;
  let reconnectedTo: string | null = null;
  for (const other of world.pieces) {
    if (other.id === piece.id) continue;
    if (Math.hypot(other.x - exit.x, other.z - exit.z) < snapR) {
      reconnectedTo = other.id;
      break;
    }
  }
  if (!reconnectedTo) {
    for (const s of world.sockets) {
      if (s.id === socketId) continue;
      if (Math.hypot(s.x - exit.x, s.z - exit.z) < snapR) {
        reconnectedTo = s.fromPieceId;
        break;
      }
    }
  }

  if (reconnectedTo) {
    tryGrowMainPath(world, sock.fromPieceId, piece.id, reconnectedTo);
  } else if (piece.onMainPath) {
    // Already added to main path as tip extension
  }

  rebuildWaypoints(world);
  updateMarkers(world);
  rebuildSockets(world);
  return { ok: true };
}

function tryGrowMainPath(world: TrackWorld, fromPieceId: string, newPieceId: string, toPieceId: string): void {
  const path = world.mainPath;
  const fromIdx = path.indexOf(fromPieceId);
  const toIdx = path.indexOf(toPieceId);
  const byId = new Map(world.pieces.map((p) => [p.id, p]));
  const np = byId.get(newPieceId);

  // Connecting back near start → close loop
  if (toIdx === 0 || toPieceId === path[0]) {
    if (fromIdx === path.length - 1 || fromPieceId === path[path.length - 1]) {
      if (np) {
        np.onMainPath = true;
        if (!path.includes(newPieceId)) path.push(newPieceId);
      }
      world.isLoop = true;
      return;
    }
  }

  if (fromIdx < 0 || toIdx < 0) return;
  if (fromIdx === toIdx) return;

  const n = path.length;
  const oldSpanIds: string[] = [];
  for (let i = (fromIdx + 1) % n; i !== toIdx; i = (i + 1) % n) {
    oldSpanIds.push(path[i]);
    if (oldSpanIds.length > n) break;
  }

  const lenOf = (ids: string[]) =>
    ids.reduce((acc, id) => acc + pieceLength(byId.get(id)?.type ?? 'straight'), 0);
  const oldLen = lenOf(oldSpanIds);
  const newLen = pieceLength(byId.get(newPieceId)?.type ?? 'straight');

  if (newLen > oldLen + 2 || oldSpanIds.length === 0) {
    const newPath: string[] = [];
    for (let i = 0; i < n; i++) {
      const id = path[i];
      if (id === fromPieceId) {
        newPath.push(id);
        newPath.push(newPieceId);
        continue;
      }
      if (oldSpanIds.includes(id)) continue;
      newPath.push(id);
    }
    for (const p of world.pieces) p.onMainPath = newPath.includes(p.id);
    if (np) np.onMainPath = true;
    world.mainPath = newPath;
  } else if (np) {
    np.onMainPath = false;
  }
}
