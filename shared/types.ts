/** Shared types for Laptrap client & server */

export type Phase = 'lobby' | 'countdown' | 'racing' | 'placing' | 'results' | 'gameover';

export type ObstacleType =
  | 'barrier'
  | 'ice'
  | 'boost'
  | 'ramp'
  | 'oil'
  | 'bomb'
  | 'spikes'
  | 'mine';

export type TrackPieceType = 'straight' | 'curveL' | 'curveR';

export const OBSTACLE_TYPES: ObstacleType[] = [
  'barrier', 'ice', 'boost', 'ramp', 'oil', 'bomb', 'spikes', 'mine',
];

/** Non-lethal utility traps */
export const UTILITY_TRAPS: ObstacleType[] = ['barrier', 'ice', 'boost', 'ramp', 'oil'];
/** Lethal death traps */
export const DEATH_TRAPS: ObstacleType[] = ['bomb', 'spikes', 'mine'];

export const TRACK_PIECE_TYPES: TrackPieceType[] = ['straight', 'curveL', 'curveR'];

export const OBSTACLE_LABELS: Record<ObstacleType, string> = {
  barrier: 'Barrier',
  ice: 'Ice',
  boost: 'Speed Pad',
  ramp: 'Ramp',
  oil: 'Oil',
  bomb: 'Bomb',
  spikes: 'Spikes',
  mine: 'Mine',
};

export const OBSTACLE_ICONS: Record<ObstacleType, string> = {
  barrier: '🧱',
  ice: '🧊',
  boost: '⚡',
  ramp: '📐',
  oil: '🛢️',
  bomb: '💣',
  spikes: '☠️',
  mine: '⚫',
};

export const TRACK_PIECE_LABELS: Record<TrackPieceType, string> = {
  straight: 'Straight',
  curveL: 'Curve L',
  curveR: 'Curve R',
};

export const TRACK_PIECE_ICONS: Record<TrackPieceType, string> = {
  straight: '➖',
  curveL: '↩️',
  curveR: '↪️',
};

export type FruitType =
  | 'apple' | 'banana' | 'orange' | 'strawberry' | 'watermelon'
  | 'pineapple' | 'grapes' | 'lemon' | 'cherry' | 'pear';

/** 10 runners, one per player slot. color = main body color used in HUD. */
export const FRUITS: Array<{ type: FruitType; name: string; emoji: string; color: string }> = [
  { type: 'apple', name: 'Apple', emoji: '🍎', color: '#e74c3c' },
  { type: 'banana', name: 'Banana', emoji: '🍌', color: '#f7d046' },
  { type: 'orange', name: 'Orange', emoji: '🍊', color: '#f39c12' },
  { type: 'strawberry', name: 'Strawberry', emoji: '🍓', color: '#e8304a' },
  { type: 'watermelon', name: 'Watermelon', emoji: '🍉', color: '#2ecc71' },
  { type: 'pineapple', name: 'Pineapple', emoji: '🍍', color: '#d4a017' },
  { type: 'grapes', name: 'Grapes', emoji: '🍇', color: '#8e44ad' },
  { type: 'lemon', name: 'Lemon', emoji: '🍋', color: '#fff176' },
  { type: 'cherry', name: 'Cherry', emoji: '🍒', color: '#b0122b' },
  { type: 'pear', name: 'Pear', emoji: '🍐', color: '#a8d04a' },
];

export const CAR_COLORS = [
  '#e74c3c', '#3498db', '#2ecc71', '#f1c40f', '#9b59b6',
  '#e67e22', '#1abc9c', '#fd79a8', '#00cec9', '#a29bfe',
] as const;

export const POINTS_BY_PLACE = [5, 4, 3, 2, 1, 1, 0, 0, 0, 0] as const;
export const DEFAULT_TARGET_SCORE = 15;
export const MAX_PLAYERS = 10;
export const MIN_PLAYERS = 2;
export const PLACE_DURATION_SEC = 25;

export interface PlayerPublic {
  id: string;
  name: string;
  color: string;
  score: number;
  ready: boolean;
  connected: boolean;
  isHost: boolean;
  hasPlaced: boolean;
  fruit: FruitType;
}

export interface CarState {
  id: string;
  x: number;
  y: number;
  z: number;
  yaw: number;
  speed: number;
  boost: number;
  vy: number;
  airborne: boolean;
  finished: boolean;
  /** DNF / death / fell off */
  eliminated: boolean;
  eliminateReason: string | null;
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
  /** Bomb already detonated this race */
  spent?: boolean;
}

export interface TrackPiece {
  id: string;
  type: TrackPieceType;
  x: number;
  z: number;
  yaw: number;
  placedBy: string | null;
  onMainPath: boolean;
}

export interface TrackSocket {
  id: string;
  x: number;
  z: number;
  yaw: number;
  fromPieceId: string;
  kind: 'side' | 'end';
}

export interface RaceMarkers {
  start: { x: number; z: number; yaw: number };
  finish: { x: number; z: number; yaw: number };
  isLoop: boolean;
}

export interface RoomState {
  code: string;
  phase: Phase;
  players: PlayerPublic[];
  cars: CarState[];
  obstacles: Obstacle[];
  trackPieces: TrackPiece[];
  trackSockets: TrackSocket[];
  markers: RaceMarkers;
  targetScore: number;
  round: number;
  placeTimeLeft: number;
  countdown: number;
  winnerId: string | null;
  finishOrder: string[];
  hostId: string;
  serverTime: number;
}

export interface CarsUpdate {
  t: number;
  cars: Array<{
    id: string;
    x: number;
    y: number;
    z: number;
    yaw: number;
    speed: number;
    boost: number;
    vy: number;
    airborne: boolean;
    finished: boolean;
    eliminated: boolean;
    eliminateReason: string | null;
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
  /** Space: hop */
  jump: boolean;
}

export interface PoseUpdate {
  x: number;
  y: number;
  z: number;
  yaw: number;
  speed: number;
  boost: number;
  vy: number;
  airborne: boolean;
  input: InputState;
}

export interface ClientToServerEvents {
  createRoom: (payload: { name: string; targetScore?: number }, cb: (res: { ok: boolean; code?: string; error?: string }) => void) => void;
  joinRoom: (payload: { code: string; name: string }, cb: (res: { ok: boolean; error?: string }) => void) => void;
  setReady: (ready: boolean) => void;
  startGame: () => void;
  input: (input: InputState) => void;
  pose: (pose: PoseUpdate) => void;
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

/** Free trap placement bounds (world units from origin) */
export const MAP_HALF_SIZE = 200;

export const TRACK = {
  width: 10,
  straightLen: 16,
  curveRadius: 14,
  wallPad: 0.4,
} as const;
