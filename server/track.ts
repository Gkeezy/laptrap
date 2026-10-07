/**
 * Piece-based expandable track.
 * Starter = small closed rectangle (4 straights + 4 curveR).
 * Side sockets let players grow spurs; reconnecting a spur to another socket
 * can lengthen the official main path (course grows) or create a shortcut.
 */

import {
  TRACK,
  TrackPiece,
  TrackPieceType,
  TrackSocket,
} from '../shared/types.js';

export interface Waypoint {
  x: number;
  z: number;
  yaw: number;
  dist: number; // cumulative distance along main path
  pieceId: string;
}

export interface TrackWorld {
  pieces: TrackPiece[];
  sockets: TrackSocket[];
  /** Ordered main-path piece ids (cycle) */
  mainPath: string[];
  waypoints: Waypoint[];
  totalLength: number;
  pieceSeq: number;
  socketSeq: number;
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
    return {
      x: piece.x + f.x * L,
      z: piece.z + f.z * L,
      yaw: piece.yaw,
    };
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
  // Rotate (relX, relZ) by t in XZ (CCW when sign>0)
  const rx = relX * cos - relZ * sin;
  const rz = relX * sin + relZ * cos;
  return {
    x: cx + rx,
    z: cz + rz,
    yaw: piece.yaw + t,
  };
}

/** Sample centerline points for a piece (for collision / progress) */
export function samplePiece(piece: TrackPiece, steps = 8): Array<{ x: number; z: number; yaw: number }> {
  const pts: Array<{ x: number; z: number; yaw: number }> = [];
  const { straightLen: L, curveRadius: R } = TRACK;
  if (piece.type === 'straight') {
    const f = forward(piece.yaw);
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      pts.push({
        x: piece.x + f.x * L * t,
        z: piece.z + f.z * L * t,
        yaw: piece.yaw,
      });
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
  // Outward = right of travel for clockwise starter (outside of loop)
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

function rebuildSockets(world: TrackWorld): void {
  const sockets: TrackSocket[] = [];
  const byId = new Map(world.pieces.map((p) => [p.id, p]));

  // Side sockets on every piece (outward) — free if nothing attached nearby
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

  // Free ends: pieces not on main path whose exit isn't near another piece entry
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

export function createStarterTrack(): TrackWorld {
  const world: TrackWorld = {
    pieces: [],
    sockets: [],
    mainPath: [],
    waypoints: [],
    totalLength: 0,
    pieceSeq: 0,
    socketSeq: 0,
  };

  // Clockwise rectangle: start bottom-left, go +X, turn right at each corner
  let x = -TRACK.straightLen / 2;
  let z = -TRACK.curveRadius - TRACK.straightLen / 2;
  let yaw = Math.PI / 2; // +X

  const add = (type: TrackPieceType) => {
    const id = `tp-${++world.pieceSeq}`;
    const piece: TrackPiece = { id, type, x, z, yaw, placedBy: null, onMainPath: true };
    world.pieces.push(piece);
    world.mainPath.push(id);
    const exit = pieceExit(piece);
    x = exit.x;
    z = exit.z;
    yaw = exit.yaw;
  };

  for (let i = 0; i < 4; i++) {
    add('straight');
    add('curveR');
  }

  rebuildWaypoints(world);
  rebuildSockets(world);
  return world;
}

export function getSpawnPose(world: TrackWorld, index: number): { x: number; z: number; yaw: number; wpIndex: number } {
  const wps = world.waypoints;
  if (!wps.length) return { x: 0, z: 0, yaw: 0, wpIndex: 0 };
  const lane = (index % 2 === 0 ? -1 : 1) * (2.0 + Math.floor(index / 2) * 0.1);
  const back = Math.floor(index / 2) * 3.0;
  const d = Math.min(world.totalLength * 0.12, 5 + back);
  let wp = wps[0];
  let wpIndex = 0;
  for (let i = 0; i < wps.length; i++) {
    if (wps[i].dist >= d) {
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
  // Never move backward along the route except when wrapping finish→start
  const goingBackward = best < prev && !(prev > n * 0.7 && best < n * 0.15);
  if (goingBackward) {
    best = prev;
    bestD = Math.hypot(wps[prev].x - x, wps[prev].z - z);
  }

  // Off-main asphalt: if closer to a spur sample than main path, keep main hint index
  // but allow onTrack=true
  let nearestDist = bestD;
  for (const piece of world.pieces) {
    if (piece.onMainPath) continue;
    for (const s of samplePiece(piece, 5)) {
      const d = Math.hypot(s.x - x, s.z - z);
      if (d < nearestDist) nearestDist = d;
    }
  }

  const halfW = TRACK.width / 2 + 1.2;
  const onTrack = nearestDist <= halfW;
  const dist = wps[best].dist;
  const progress = dist / world.totalLength;
  return { progress, dist, onTrack, nearestDist, wpIndex: best };
}

export function clampToTrack(world: TrackWorld, x: number, z: number): { x: number; z: number; hit: boolean } {
  const wps = world.waypoints;
  const halfW = TRACK.width / 2;

  // Gather sample points from all pieces
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

  if (bestD <= halfW) {
    return { x, z, hit: false };
  }

  // Project onto centerline then push to edge
  const lateral = leftOf(bestYaw);
  // vector from centerline to car
  let dx = x - bestX;
  let dz = z - bestZ;
  let lat = dx * lateral.x + dz * lateral.z;
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

  // Avoid overlapping existing pieces too heavily
  const exit = pieceExit(piece);
  for (const other of world.pieces) {
    if (Math.hypot(other.x - piece.x, other.z - piece.z) < 2) {
      return { ok: false, error: 'Blocked' };
    }
  }

  world.pieces.push(piece);

  // Try to snap exit to a nearby socket / piece entry → close spur
  const snapR = 4.5;
  let reconnectedTo: string | null = null;
  for (const other of world.pieces) {
    if (other.id === piece.id) continue;
    if (Math.hypot(other.x - exit.x, other.z - exit.z) < snapR) {
      reconnectedTo = other.id;
      break;
    }
  }
  // Also snap to open sockets
  if (!reconnectedTo) {
    for (const s of world.sockets) {
      if (s.id === socketId) continue;
      if (Math.hypot(s.x - exit.x, s.z - exit.z) < snapR) {
        // Find piece at that socket's origin for reconnection target
        reconnectedTo = s.fromPieceId;
        break;
      }
    }
  }

  if (reconnectedTo) {
    tryGrowMainPath(world, sock.fromPieceId, piece.id, reconnectedTo);
  }

  rebuildWaypoints(world);
  rebuildSockets(world);
  return { ok: true };
}

/**
 * If new spur from `fromPiece` through `newPiece` reconnects near `toPiece`,
 * and the detour is longer than the old main-path span, adopt it as main path.
 */
function tryGrowMainPath(world: TrackWorld, fromPieceId: string, newPieceId: string, toPieceId: string): void {
  const path = world.mainPath;
  const fromIdx = path.indexOf(fromPieceId);
  const toIdx = path.indexOf(toPieceId);
  if (fromIdx < 0 || toIdx < 0) {
    // Reconnected to a non-main piece — just leave as asphalt spur
    return;
  }
  if (fromIdx === toIdx) return;

  // Old forward span along main path from fromIdx to toIdx
  const n = path.length;
  const oldSpanIds: string[] = [];
  for (let i = (fromIdx + 1) % n; i !== toIdx; i = (i + 1) % n) {
    oldSpanIds.push(path[i]);
    if (oldSpanIds.length > n) break;
  }

  const byId = new Map(world.pieces.map((p) => [p.id, p]));
  const lenOf = (ids: string[]) =>
    ids.reduce((acc, id) => acc + pieceLength(byId.get(id)?.type ?? 'straight'), 0);

  const oldLen = lenOf(oldSpanIds);
  const newLen = pieceLength(byId.get(newPieceId)?.type ?? 'straight');

  // Only grow if detour is meaningfully longer (course expands)
  if (newLen > oldLen + 2) {
    // Replace old span with new piece
    const newPath: string[] = [];
    for (let i = 0; i < n; i++) {
      const id = path[i];
      if (id === fromPieceId) {
        newPath.push(id);
        newPath.push(newPieceId);
        // skip until toIdx
        continue;
      }
      if (oldSpanIds.includes(id)) continue;
      newPath.push(id);
    }
    // Mark flags
    for (const p of world.pieces) {
      p.onMainPath = newPath.includes(p.id);
    }
    const np = byId.get(newPieceId);
    if (np) np.onMainPath = true;
    world.mainPath = newPath;
  } else {
    // Shortcut: leave main path, new piece is optional asphalt
    const np = byId.get(newPieceId);
    if (np) np.onMainPath = false;
  }
}

export function finishLinePose(world: TrackWorld): { x: number; z: number; yaw: number } {
  const wp = world.waypoints[0];
  if (!wp) return { x: 0, z: 0, yaw: 0 };
  return { x: wp.x, z: wp.z, yaw: wp.yaw };
}
