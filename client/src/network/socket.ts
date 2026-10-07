import { io, Socket } from 'socket.io-client';
import type {
  ClientToServerEvents,
  ServerToClientEvents,
  RoomState,
  CarsUpdate,
  InputState,
  PoseUpdate,
  ObstacleType,
  TrackPieceType,
} from '../../../shared/types';

export type GameSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

let socket: GameSocket | null = null;

export function getSocket(): GameSocket {
  if (!socket) {
    socket = io({ autoConnect: true, transports: ['websocket', 'polling'] });
  }
  return socket;
}

export function createRoom(name: string, targetScore?: number) {
  return new Promise<{ ok: boolean; code?: string; error?: string }>((resolve) => {
    getSocket().emit('createRoom', { name, targetScore }, resolve);
  });
}

export function joinRoom(code: string, name: string) {
  return new Promise<{ ok: boolean; error?: string }>((resolve) => {
    getSocket().emit('joinRoom', { code, name }, resolve);
  });
}

export function setReady(ready: boolean): void {
  getSocket().emit('setReady', ready);
}
export function startGame(): void {
  getSocket().emit('startGame');
}
export function sendInput(input: InputState): void {
  getSocket().emit('input', input);
}
export function sendPose(pose: PoseUpdate): void {
  getSocket().emit('pose', pose);
}
export function placeObstacle(type: ObstacleType, x: number, z: number, yaw: number) {
  return new Promise<{ ok: boolean; error?: string }>((resolve) => {
    getSocket().emit('placeObstacle', { type, x, z, yaw }, resolve);
  });
}
export function placeTrackPiece(type: TrackPieceType, socketId: string) {
  return new Promise<{ ok: boolean; error?: string }>((resolve) => {
    getSocket().emit('placeTrackPiece', { type, socketId }, resolve);
  });
}
export function skipPlace(): void {
  getSocket().emit('skipPlace');
}
export function rematch(): void {
  getSocket().emit('rematch');
}
export function leaveRoom(): void {
  getSocket().emit('leaveRoom');
}
export function onRoomState(cb: (state: RoomState) => void): void {
  getSocket().on('roomState', cb);
}
export function onCarsUpdate(cb: (update: CarsUpdate) => void): void {
  getSocket().on('carsUpdate', cb);
}
export function onError(cb: (msg: string) => void): void {
  getSocket().on('error', cb);
}
export function myId(): string {
  return getSocket().id || '';
}
