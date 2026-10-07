/** Shared types for Laptrap client & server */

export type Phase = 'lobby' | 'countdown' | 'racing' | 'placing' | 'results' | 'gameover';

export type ObstacleType = 'barrier' | 'ice' | 'boost' | 'ramp' | 'oil';

export const OBSTACLE_TYPES: ObstacleType[] = ['barrier', 'ice', 'boost', 'ramp', 'oil'];

export const OBSTACLE_LABELS: Record<ObstacleType, string> = {
  barrier: 'Barrier',
  ice: 'Ice Patch',
  boost: 'Boost Pad',
  ramp: 'Ramp',
  oil: 'Oil Slick',
};

export const CAR_COLORS = ['#e74c3c', '#3498db', '#2ecc71', '#f1c40f'] as const;

export const POINTS_BY_PLACE = [3, 2, 1, 0] as const;
export const DEFAULT_TARGET_SCORE = 9;
export const MAX_PLAYERS = 4;
export const MIN_PLAYERS = 2;

export interface Vec2 {
  x: number;
  z: number;
}

export interface PlayerPublic {
  id: string;
  name: string;
  color: string;
  score: number;
  ready: boolean;
  connected: boolean;
  isHost: boolean;
}

export interface CarState {
  id: string;
  x: number;
  z: number;
  yaw: number;
  speed: number;
  boost: number;
  finished: boolean;
  finishPlace: number | null;
  lapProgress: number; // 0..1 around track
  checkpoint: number;
  laps: number;
  spinning: number; // remaining spin time from oil
  icy: number;
}

export interface Obstacle {
  id: string;
  type: ObstacleType;
  x: number;
  z: number;
  yaw: number;
  placedBy: string;
}

export interface RoomState {
  code: string;
  phase: Phase;
  players: PlayerPublic[];
  cars: CarState[];
  obstacles: Obstacle[];
  targetScore: number;
  round: number;
  placingPlayerId: string | null;
  placingQueue: string[]; // finish order for placement
  countdown: number;
  winnerId: string | null;
  finishOrder: string[];
  hostId: string;
}

export interface InputState {
  forward: boolean;
  back: boolean;
  left: boolean;
  right: boolean;
  boost: boolean;
}

/** Client → Server events */
export interface ClientToServerEvents {
  createRoom: (payload: { name: string; targetScore?: number }, cb: (res: { ok: boolean; code?: string; error?: string }) => void) => void;
  joinRoom: (payload: { code: string; name: string }, cb: (res: { ok: boolean; error?: string }) => void) => void;
  setReady: (ready: boolean) => void;
  startGame: () => void;
  input: (input: InputState) => void;
  placeObstacle: (payload: { type: ObstacleType; x: number; z: number; yaw: number }, cb: (res: { ok: boolean; error?: string }) => void) => void;
  skipPlace: () => void;
  rematch: () => void;
  leaveRoom: () => void;
}

/** Server → Client events */
export interface ServerToClientEvents {
  roomState: (state: RoomState) => void;
  error: (message: string) => void;
  chat: (payload: { name: string; text: string }) => void;
}

/** Track constants (shared for validation) */
export const TRACK = {
  centerRadius: 28,
  trackWidth: 10,
  wallHeight: 1.2,
  startLineZ: 0,
} as const;
