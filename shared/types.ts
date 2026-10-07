/** Shared types for Laptrap client & server */

export type Phase = 'lobby' | 'countdown' | 'racing' | 'placing' | 'results' | 'gameover';

export type ObstacleType = 'barrier' | 'ice' | 'boost' | 'ramp' | 'oil';
export type TrackPieceType = 'straight' | 'curveL' | 'curveR';
export type BuildItemType = ObstacleType | TrackPieceType;

export const OBSTACLE_TYPES: ObstacleType[] = ['barrier', 'ice', 'boost', 'ramp', 'oil'];
export const TRACK_PIECE_TYPES: TrackPieceType[] = ['straight', 'curveL', 'curveR'];

export const OBSTACLE_LABELS: Record<ObstacleType, string> = {
  barrier: 'Barrier',
  ice: 'Ice Patch',
  boost: 'Boost Pad',
  ramp: 'Ramp',
  oil: 'Oil Slick',
};

export const TRACK_PIECE_LABELS: Record<TrackPieceType, string> = {
  straight: 'Straight',
  curveL: 'Curve Left',
  curveR: 'Curve Right',
};

export const CAR_COLORS = [
  '#e74c3c', '#3498db', '#2ecc71', '#f1c40f', '#9b59b6',
  '#e67e22', '#1abc9c', '#fd79a8', '#00cec9', '#a29bfe',
] as const;

/** Points by finish place (1st index 0). Extra places get 0. */
export const POINTS_BY_PLACE = [5, 4, 3, 2, 1, 1, 0, 0, 0, 0] as const;
export const DEFAULT_TARGET_SCORE = 15;
export const MAX_PLAYERS = 10;
export const MIN_PLAYERS = 2;
export const PLACE_DURATION_SEC = 25;

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
  /** During placing: true once this player has placed or skipped */
  hasPlaced: boolean;
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
  lapProgress: number;
  checkpoint: number;
  laps: number;
  spinning: number;
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

export interface TrackPiece {
  id: string;
  type: TrackPieceType;
  /** Entry pose */
  x: number;
  z: number;
  yaw: number;
  placedBy: string | null;
  /** True if part of the official lap route */
  onMainPath: boolean;
}

/** Open connector where a new track piece can snap */
export interface TrackSocket {
  id: string;
  x: number;
  z: number;
  yaw: number;
  fromPieceId: string;
  /** 'side' = mid-piece expand; 'end' = free tip of a spur */
  kind: 'side' | 'end';
}

export interface RoomState {
  code: string;
  phase: Phase;
  players: PlayerPublic[];
  cars: CarState[];
  obstacles: Obstacle[];
  trackPieces: TrackPiece[];
  trackSockets: TrackSocket[];
  targetScore: number;
  round: number;
  /** Seconds left in simultaneous place phase */
  placeTimeLeft: number;
  countdown: number;
  winnerId: string | null;
  finishOrder: string[];
  hostId: string;
  serverTime: number;
}

/** Lightweight 20 Hz car snapshot */
export interface CarsUpdate {
  t: number;
  cars: Array<{
    id: string;
    x: number;
    z: number;
    yaw: number;
    speed: number;
    boost: number;
    finished: boolean;
    finishPlace: number | null;
    lapProgress: number;
    laps: number;
    spinning: number;
    icy: number;
  }>;
}

export interface InputState {
  forward: boolean;
  back: boolean;
  left: boolean;
  right: boolean;
  boost: boolean;
}

export interface ClientToServerEvents {
  createRoom: (payload: { name: string; targetScore?: number }, cb: (res: { ok: boolean; code?: string; error?: string }) => void) => void;
  joinRoom: (payload: { code: string; name: string }, cb: (res: { ok: boolean; error?: string }) => void) => void;
  setReady: (ready: boolean) => void;
  startGame: () => void;
  input: (input: InputState) => void;
  placeObstacle: (payload: { type: ObstacleType; x: number; z: number; yaw: number }, cb: (res: { ok: boolean; error?: string }) => void) => void;
  placeTrackPiece: (payload: { type: TrackPieceType; socketId: string }, cb: (res: { ok: boolean; error?: string }) => void) => void;
  skipPlace: () => void;
  rematch: () => void;
  leaveRoom: () => void;
}

export interface ServerToClientEvents {
  roomState: (state: RoomState) => void;
  carsUpdate: (update: CarsUpdate) => void;
  error: (message: string) => void;
  chat: (payload: { name: string; text: string }) => void;
}

/** Track geometry constants */
export const TRACK = {
  width: 10,
  straightLen: 16,
  curveRadius: 14,
  wallPad: 0.4,
} as const;
