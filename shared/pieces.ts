/**
 * Shared track-tile geometry, used by BOTH server and client so physics, rendering,
 * sockets, finish tracking and fall-off detection always agree.
 *
 * Frame convention: forward(yaw) = (sin yaw, cos yaw); left(yaw) = forward(yaw + PI/2) = (cos yaw, -sin yaw).
 * A tile is described in its local frame by a centerline c(s), s in [0,1]:
 *   a = distance forward, b = offset to the LEFT, dyaw = heading change (positive = turned left).
 * Asphalt at s is a list of lateral intervals [bMin, bMax] relative to the centerline (holes = gaps).
 */
import { TRACK } from './types.js';
import type { TrackPiece, TrackPieceType } from './types.js';

export interface LocalPoint { a: number; b: number; dyaw: number }
export interface WorldPoint { x: number; z: number; yaw: number }

const L = TRACK.straightLen;
const R = TRACK.curveRadius;
const HW = TRACK.width / 2;

interface TileSpec {
  center(s: number): LocalPoint;
  lanes(s: number): Array<[number, number]>;
  /** Approx. length (for sampling density) */
  approxLen: number;
  /** Side sockets are offered only on plain wide tiles */
  sideSocket: boolean;
}

const straightLike = (len: number, hw: number): TileSpec['center'] => (s) => ({ a: len * s, b: 0, dyaw: 0 });

const SBEND_LEN = L * 1.5;
const SBEND_SHIFT = 10;
const ZIG_AMP = 2.5;
const ZIG_LEN = L * 1.3;
const FORK_LEN = L * 1.5;
const FORK_HOLE = 3; // half-width of the island
const PLANK_LEN = L * 1.5;

export const TILE_SPECS: Record<TrackPieceType, TileSpec> = {
  straight: { center: straightLike(L, HW), lanes: () => [[-HW, HW]], approxLen: L, sideSocket: true },
  curveL: {
    center: (s) => { const th = (s * Math.PI) / 2; return { a: R * Math.sin(th), b: R - R * Math.cos(th), dyaw: th }; },
    lanes: () => [[-HW, HW]], approxLen: (Math.PI / 2) * R, sideSocket: true,
  },
  curveR: {
    center: (s) => { const th = (s * Math.PI) / 2; return { a: R * Math.sin(th), b: -(R - R * Math.cos(th)), dyaw: -th }; },
    lanes: () => [[-HW, HW]], approxLen: (Math.PI / 2) * R, sideSocket: true,
  },
  narrow: { center: straightLike(L, 3), lanes: () => [[-3, 3]], approxLen: L, sideSocket: false },
  plank: { center: straightLike(PLANK_LEN, 1.75), lanes: () => [[-1.75, 1.75]], approxLen: PLANK_LEN, sideSocket: false },
  gap: {
    center: straightLike(L, HW),
    lanes: (s) => (s > 0.34 && s < 0.66 ? [] : [[-HW, HW]]),
    approxLen: L, sideSocket: false,
  },
  sbend: {
    center: (s) => {
      const b = (SBEND_SHIFT * (1 - Math.cos(Math.PI * s))) / 2;
      const db = (SBEND_SHIFT * Math.PI * Math.sin(Math.PI * s)) / 2; // d b / d s
      return { a: SBEND_LEN * s, b, dyaw: Math.atan2(db, SBEND_LEN) };
    },
    lanes: () => [[-HW + 1, HW - 1]], approxLen: SBEND_LEN + 3, sideSocket: false,
  },
  zigzag: {
    center: (s) => {
      // 1.5 wiggles; derivative is 0 at both ends so neighbours connect smoothly
      const b = ZIG_AMP * Math.sin(3 * Math.PI * s) * Math.sin(Math.PI * s);
      const db = ZIG_AMP * (3 * Math.PI * Math.cos(3 * Math.PI * s) * Math.sin(Math.PI * s) + Math.PI * Math.sin(3 * Math.PI * s) * Math.cos(Math.PI * s));
      return { a: ZIG_LEN * s, b, dyaw: Math.atan2(db, ZIG_LEN) };
    },
    lanes: () => [[-5, 5]], approxLen: ZIG_LEN * 1.1, sideSocket: false,
  },
  fork: {
    center: straightLike(FORK_LEN, HW),
    lanes: (s) => (s > 0.2 && s < 0.8 ? [[-HW, -FORK_HOLE], [FORK_HOLE, HW]] : [[-HW, HW]]),
    approxLen: FORK_LEN, sideSocket: false,
  },
};

export function forwardVec(yaw: number): { x: number; z: number } {
  return { x: Math.sin(yaw), z: Math.cos(yaw) };
}
export function leftVec(yaw: number): { x: number; z: number } {
  return { x: Math.cos(yaw), z: -Math.sin(yaw) };
}

export function pieceHalfWidth(type: TrackPieceType): number {
  const lanes = TILE_SPECS[type].lanes(0);
  return Math.max(...lanes.map(([lo, hi]) => Math.max(Math.abs(lo), Math.abs(hi))));
}

export function tilePoint(piece: Pick<TrackPiece, 'type' | 'x' | 'z' | 'yaw'>, s: number): WorldPoint {
  const c = TILE_SPECS[piece.type].center(s);
  const f = forwardVec(piece.yaw);
  const l = leftVec(piece.yaw);
  return { x: piece.x + f.x * c.a + l.x * c.b, z: piece.z + f.z * c.a + l.z * c.b, yaw: piece.yaw + c.dyaw };
}

export function tileExit(piece: Pick<TrackPiece, 'type' | 'x' | 'z' | 'yaw'>): WorldPoint {
  return tilePoint(piece, 1);
}

/** Default sample count: about one sample per unit of length (min `min`). */
export function tileSteps(type: TrackPieceType, min = 8): number {
  return Math.max(min, Math.ceil(TILE_SPECS[type].approxLen * 1.5));
}

export function sampleTile(piece: Pick<TrackPiece, 'type' | 'x' | 'z' | 'yaw'>, steps = tileSteps(piece.type)): Array<WorldPoint & { s: number }> {
  const pts: Array<WorldPoint & { s: number }> = [];
  for (let i = 0; i <= steps; i++) {
    const s = i / steps;
    pts.push({ ...tilePoint(piece, s), s });
  }
  return pts;
}

export function tileLength(type: TrackPieceType): number {
  const pts = sampleTile({ type, x: 0, z: 0, yaw: 0 }, 64);
  let d = 0;
  for (let i = 1; i < pts.length; i++) d += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z);
  return d;
}

/** Sample cache per piece (pieces never move once placed). */
const cache = new Map<string, Array<WorldPoint & { s: number }>>();
function cachedSamples(piece: TrackPiece): Array<WorldPoint & { s: number }> {
  const key = `${piece.id}|${piece.type}|${piece.x.toFixed(3)}|${piece.z.toFixed(3)}|${piece.yaw.toFixed(4)}`;
  let pts = cache.get(key);
  if (!pts) {
    pts = sampleTile(piece);
    if (cache.size > 4000) cache.clear();
    cache.set(key, pts);
  }
  return pts;
}

/**
 * True if (x,z) is on asphalt of any piece. `tol` widens lanes (server uses a little more than the
 * client so the client always starts falling first). Holes (gap / fork island) are respected.
 */
export function onAsphalt(pieces: TrackPiece[], x: number, z: number, tol: number): boolean {
  for (const piece of pieces) {
    // quick reject
    if (Math.abs(x - piece.x) > 60 || Math.abs(z - piece.z) > 60) continue;
    const pts = cachedSamples(piece);
    let best = Infinity;
    let bi = -1;
    for (let i = 0; i < pts.length; i++) {
      const d = (pts[i].x - x) ** 2 + (pts[i].z - z) ** 2;
      if (d < best) { best = d; bi = i; }
    }
    if (bi < 0) continue;
    const p = pts[bi];
    const f = forwardVec(p.yaw);
    const l = leftVec(p.yaw);
    const dx = x - p.x;
    const dz = z - p.z;
    const along = dx * f.x + dz * f.z;
    const lat = dx * l.x + dz * l.z;
    // beyond the tile's ends: not this tile
    const nb = pts[bi === 0 ? 1 : bi - 1];
    const spacing = Math.hypot(nb.x - p.x, nb.z - p.z);
    if ((bi === 0 && along < -0.05) || (bi === pts.length - 1 && along > 0.05)) continue;
    if (Math.abs(along) > spacing * 0.75 + 0.05) continue;
    for (const [lo, hi] of TILE_SPECS[piece.type].lanes(p.s)) {
      if (lat >= lo - tol && lat <= hi + tol) return true;
    }
  }
  return false;
}
