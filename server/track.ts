/** Server-side track helpers — oval track */

import { TRACK } from '../shared/types.js';

const OUTER_R = TRACK.centerRadius + TRACK.trackWidth / 2;
const INNER_R = TRACK.centerRadius - TRACK.trackWidth / 2;

/** Angle 0 = +X (right of oval), increases CCW. Start line is at angle -PI/2 (bottom, -Z). */
export function worldToProgress(x: number, z: number): number {
  // Start at bottom of oval (0, -centerRadius), progress clockwise for racing feel
  // Using atan2: start angle = -PI/2 (negative Z)
  let a = Math.atan2(z, x); // -PI..PI, 0 = +X
  // Remap so start (-PI/2) = 0, increasing counterclockwise becomes clockwise race...
  // For racing clockwise: start at bottom, go left (-X), top, right, bottom.
  // Clockwise from -PI/2: -PI/2 -> -PI/0? Actually clockwise from bottom goes to +X side first.
  // atan2 clockwise from -PI/2: -PI/2 -> 0 -> PI/2 -> PI/-PI -> -PI/2
  let progress = (a + Math.PI / 2) / (2 * Math.PI);
  if (progress < 0) progress += 1;
  if (progress >= 1) progress -= 1;
  return progress;
}

export function progressToWorld(progress: number, lane = 0): { x: number; z: number; yaw: number } {
  // progress 0 at start (bottom), going clockwise
  const a = -Math.PI / 2 + progress * 2 * Math.PI;
  const r = TRACK.centerRadius + lane;
  // yaw: facing direction of travel (clockwise tangent)
  // tangent for clockwise: angle + PI/2? At progress 0 (angle -PI/2), going toward +X, yaw should face +X = 0
  // derivative of (r cos a, r sin a) with a increasing: (-r sin a, r cos a)
  // at a=-PI/2: (-r*(-1), r*0) = (r, 0) → +X. yaw = atan2(dx_forward_z, dx_forward_x) wait
  // We use yaw where 0 = +X, increasing toward +Z (CCW). Forward for clockwise is (+cos(a)?):
  // forward = (sin(a)? No: (-sin a, cos a) for da>0 on (cos a, sin a)
  // fx = -sin(a), fz = cos(a). yaw = atan2(fz, fx)
  const fx = -Math.sin(a);
  const fz = Math.cos(a);
  const yaw = Math.atan2(fx, fz); // Wait — our car uses yaw as rotation around Y where 0 faces -Z or +Z?
  // We'll define yaw 0 = facing +Z, and car forward = (sin(yaw), cos(yaw)) in XZ... 
  // Simpler: yaw = atan2(fx, fz) with forward (sin yaw, cos yaw) = (fx, fz)
  // So yaw = atan2(fx, fz)
  return {
    x: Math.cos(a) * r,
    z: Math.sin(a) * r,
    yaw: Math.atan2(fx, fz),
  };
}

export function isOnTrack(x: number, z: number): boolean {
  const d = Math.hypot(x, z);
  return d >= INNER_R - 0.5 && d <= OUTER_R + 0.5;
}

export function clampToTrack(x: number, z: number): { x: number; z: number } {
  const d = Math.hypot(x, z) || 0.001;
  if (d < INNER_R) {
    return { x: (x / d) * INNER_R, z: (z / d) * INNER_R };
  }
  if (d > OUTER_R) {
    return { x: (x / d) * OUTER_R, z: (z / d) * OUTER_R };
  }
  return { x, z };
}

export function isValidPlacement(x: number, z: number): boolean {
  const d = Math.hypot(x, z);
  return d >= INNER_R + 1 && d <= OUTER_R - 1;
}

export function getSpawnPose(index: number): { x: number; z: number; yaw: number } {
  const lane = (index % 2 === 0 ? -2.2 : 2.2);
  const back = Math.floor(index / 2) * 3.5;
  // Just after the start/finish line so a full lap is required to finish
  const base = progressToWorld(0.02 + back * 0.008, lane);
  return base;
}

export { OUTER_R, INNER_R };
