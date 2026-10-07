import { io, Socket } from 'socket.io-client';
import type {
  ClientToServerEvents,
  ServerToClientEvents,
  RoomState,
  InputState,
  ObstacleType,
} from '../../../shared/types';

export type GameSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

let socket: GameSocket | null = null;

export function getSocket(): GameSocket {
  if (!socket) {
    socket = io({
      autoConnect: true,
      transports: ['websocket', 'polling'],
    });
  }
  return socket;
}

export function createRoom(name: string, targetScore?: number): Promise<{ ok: boolean; code?: string; error?: string }> {
  return new Promise((resolve) => {
    getSocket().emit('createRoom', { name, targetScore }, resolve);
  });
}

export function joinRoom(code: string, name: string): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
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

export function placeObstacle(
  type: ObstacleType,
  x: number,
  z: number,
  yaw: number,
): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    getSocket().emit('placeObstacle', { type, x, z, yaw }, resolve);
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

export function onError(cb: (msg: string) => void): void {
  getSocket().on('error', cb);
}

export function myId(): string {
  return getSocket().id || '';
}
