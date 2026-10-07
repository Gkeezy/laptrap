import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  ClientToServerEvents,
  ServerToClientEvents,
  DEFAULT_TARGET_SCORE,
} from '../shared/types.js';
import { Room } from './room.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;

const app = express();
const httpServer = createServer(app);

const io = new Server<ClientToServerEvents, ServerToClientEvents>(httpServer, {
  cors: { origin: true, credentials: true },
});

const rooms = new Map<string, Room>();
const socketRoom = new Map<string, string>(); // socket.id -> room code
const existingCodes = new Set<string>();

// Health / API
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, rooms: rooms.size });
});

// Serve Vite build in production
const distPath = path.resolve(__dirname, '../../dist');
app.use(express.static(distPath));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api') || req.path.startsWith('/socket.io')) return next();
  res.sendFile(path.join(distPath, 'index.html'), (err) => {
    if (err) next();
  });
});

function emitRoom(code: string): void {
  const room = rooms.get(code);
  if (!room) return;
  io.to(code).emit('roomState', room.getState());
}

io.on('connection', (socket) => {
  socket.on('createRoom', (payload, cb) => {
    try {
      const name = (payload?.name || 'Host').trim().slice(0, 16);
      const target = Math.max(3, Math.min(21, payload?.targetScore ?? DEFAULT_TARGET_SCORE));
      const code = Room.createCode(existingCodes);
      existingCodes.add(code);
      const room = new Room(code, socket.id, name, target, () => emitRoom(code));
      rooms.set(code, room);
      socket.join(code);
      socketRoom.set(socket.id, code);
      cb({ ok: true, code });
      emitRoom(code);
    } catch (e) {
      cb({ ok: false, error: 'Failed to create room' });
    }
  });

  socket.on('joinRoom', (payload, cb) => {
    try {
      const code = (payload?.code || '').toUpperCase().trim();
      const name = (payload?.name || 'Racer').trim().slice(0, 16);
      const room = rooms.get(code);
      if (!room) {
        cb({ ok: false, error: 'Room not found' });
        return;
      }
      const result = room.addPlayer(socket.id, name);
      if (!result.ok) {
        cb(result);
        return;
      }
      socket.join(code);
      socketRoom.set(socket.id, code);
      cb({ ok: true });
      emitRoom(code);
    } catch {
      cb({ ok: false, error: 'Join failed' });
    }
  });

  socket.on('setReady', (ready) => {
    const code = socketRoom.get(socket.id);
    if (!code) return;
    rooms.get(code)?.setReady(socket.id, ready);
  });

  socket.on('startGame', () => {
    const code = socketRoom.get(socket.id);
    if (!code) return;
    const room = rooms.get(code);
    if (!room) return;
    const result = room.startGame(socket.id);
    if (!result.ok) socket.emit('error', result.error || 'Cannot start');
  });

  socket.on('input', (input) => {
    const code = socketRoom.get(socket.id);
    if (!code) return;
    rooms.get(code)?.setInput(socket.id, input);
  });

  socket.on('placeObstacle', (payload, cb) => {
    const code = socketRoom.get(socket.id);
    if (!code) {
      cb({ ok: false, error: 'Not in room' });
      return;
    }
    const room = rooms.get(code);
    if (!room) {
      cb({ ok: false, error: 'Room gone' });
      return;
    }
    const result = room.placeObstacle(socket.id, payload.type, payload.x, payload.z, payload.yaw);
    cb(result);
  });

  socket.on('skipPlace', () => {
    const code = socketRoom.get(socket.id);
    if (!code) return;
    rooms.get(code)?.skipPlace(socket.id);
  });

  socket.on('rematch', () => {
    const code = socketRoom.get(socket.id);
    if (!code) return;
    rooms.get(code)?.rematch(socket.id);
  });

  socket.on('leaveRoom', () => {
    leave(socket.id);
  });

  socket.on('disconnect', () => {
    leave(socket.id);
  });
});

function leave(socketId: string): void {
  const code = socketRoom.get(socketId);
  if (!code) return;
  socketRoom.delete(socketId);
  const room = rooms.get(code);
  if (!room) return;
  const empty = room.removePlayer(socketId);
  if (empty) {
    room.destroy();
    rooms.delete(code);
    existingCodes.delete(code);
  }
}

httpServer.listen(PORT, () => {
  console.log(`Laptrap server listening on http://localhost:${PORT}`);
});
