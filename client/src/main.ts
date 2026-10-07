import './style.css';
import type { InputState, ObstacleType, TrackPieceType, RoomState } from '../../shared/types';
import {
  OBSTACLE_TYPES,
  OBSTACLE_LABELS,
  TRACK_PIECE_TYPES,
  TRACK_PIECE_LABELS,
} from '../../shared/types';
import * as net from './network/socket';
import { GameScene } from './game/Scene';

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;

const menu = $('#menu');
const lobby = $('#lobby');
const gameRoot = $('#game-root');
const nameInput = $('#player-name') as HTMLInputElement;
const joinCodeInput = $('#join-code') as HTMLInputElement;
const menuError = $('#menu-error');
const lobbyCode = $('#lobby-code');
const lobbyLink = $('#lobby-link') as HTMLAnchorElement;
const lobbyTarget = $('#lobby-target');
const playerList = $('#player-list');
const lobbyMsg = $('#lobby-msg');
const btnReady = $('#btn-ready');
const btnStart = $('#btn-start');
const hudPhase = $('#hud-phase');
const hudRound = $('#hud-round');
const hudPlace = $('#hud-place');
const hudScore = $('#hud-score');
const hudCountdown = $('#hud-countdown');
const hudBanner = $('#hud-banner');
const scoreboard = $('#scoreboard');
const placeUi = $('#place-ui');
const placeTurn = $('#place-turn');
const placeTimer = $('#place-timer');
const placeHint = $('#place-hint');
const obstaclePicks = $('#obstacle-picks');
const trackPicks = $('#track-picks');
const tabTrap = $('#tab-trap');
const tabTrack = $('#tab-track');
const resultsOverlay = $('#results-overlay');
const gameoverOverlay = $('#gameover-overlay');
const winnerText = $('#winner-text');
const btnRematch = $('#btn-rematch');
const mobileControls = $('#mobile-controls');

let scene: GameScene | null = null;
let state: RoomState | null = null;
let selectedObstacle: ObstacleType = 'barrier';
let selectedTrackPiece: TrackPieceType = 'straight';
let buildMode: 'trap' | 'track' = 'trap';
let itemPicked = false; // must click an item button first
let myReady = false;
let loopTimer: number | null = null;
let lastTick = performance.now();
let poseAccum = 0;

const keys: InputState = {
  forward: false,
  back: false,
  left: false,
  right: false,
  boost: false,
};

nameInput.value = localStorage.getItem('laptrap-name') || '';

function roomUrl(code: string): string {
  const u = new URL(location.href);
  u.searchParams.set('room', code);
  return u.toString();
}
function show(el: HTMLElement): void {
  el.classList.remove('hidden');
}
function hide(el: HTMLElement): void {
  el.classList.add('hidden');
}

function ensureScene(): GameScene {
  if (!scene) {
    const canvas = $('#game-canvas') as HTMLCanvasElement;
    scene = new GameScene(canvas);
    scene.start();
    canvas.addEventListener('click', (e) => {
      void onMapClick(e);
    });
  }
  scene.setLocalId(net.myId());
  return scene;
}

async function onMapClick(e: MouseEvent): Promise<void> {
  if (!scene?.placing || !state) return;
  const me = state.players.find((p) => p.id === net.myId());
  if (me?.hasPlaced) return;

  const hit = scene.screenToTrack(e.clientX, e.clientY);
  if (!hit) return;
  const pick = scene.setGhostFromClick(hit.x, hit.z);

  if (!itemPicked) {
    hudBanner.textContent = 'Select a trap or track piece first';
    show(hudBanner);
    setTimeout(() => hide(hudBanner), 1200);
    return;
  }

  // Click-to-place immediately
  if (buildMode === 'track') {
    if (!pick.socketId) {
      hudBanner.textContent = 'Click a green socket to place track';
      show(hudBanner);
      setTimeout(() => hide(hudBanner), 1200);
      return;
    }
    const res = await net.placeTrackPiece(selectedTrackPiece, pick.socketId);
    if (!res.ok) {
      hudBanner.textContent = res.error || 'Place failed';
      show(hudBanner);
      setTimeout(() => hide(hudBanner), 1500);
    }
    return;
  }

  const res = await net.placeObstacle(selectedObstacle, scene.ghostPos.x, scene.ghostPos.z, scene.ghostPos.yaw);
  if (!res.ok) {
    hudBanner.textContent = res.error || 'Place failed';
    show(hudBanner);
    setTimeout(() => hide(hudBanner), 1500);
  }
}

async function doCreate(): Promise<void> {
  menuError.textContent = '';
  const name = nameInput.value.trim() || 'Host';
  localStorage.setItem('laptrap-name', name);
  const res = await net.createRoom(name);
  if (!res.ok || !res.code) {
    menuError.textContent = res.error || 'Could not create room';
    return;
  }
  history.replaceState(null, '', `/?room=${res.code}`);
  hide(menu);
  show(lobby);
}

async function doJoin(code?: string): Promise<void> {
  menuError.textContent = '';
  const name = nameInput.value.trim() || 'Racer';
  localStorage.setItem('laptrap-name', name);
  const c = (code || joinCodeInput.value).toUpperCase().trim();
  if (!c) {
    menuError.textContent = 'Enter a room code';
    return;
  }
  const res = await net.joinRoom(c, name);
  if (!res.ok) {
    menuError.textContent = res.error || 'Could not join';
    return;
  }
  history.replaceState(null, '', `/?room=${c}`);
  hide(menu);
  show(lobby);
}

$('#btn-create').addEventListener('click', () => void doCreate());
$('#btn-join').addEventListener('click', () => void doJoin());
joinCodeInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') void doJoin();
});
btnReady.addEventListener('click', () => {
  myReady = !myReady;
  net.setReady(myReady);
  btnReady.textContent = myReady ? 'Unready' : 'Ready';
});
btnStart.addEventListener('click', () => net.startGame());
$('#btn-leave').addEventListener('click', () => {
  net.leaveRoom();
  location.href = '/';
});
$('#btn-copy').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(lobbyLink.href);
    lobbyMsg.textContent = 'Link copied!';
  } catch {
    lobbyMsg.textContent = 'Copy failed';
  }
});
$('#btn-skip-place').addEventListener('click', () => net.skipPlace());
btnRematch.addEventListener('click', () => net.rematch());
$('#btn-home').addEventListener('click', () => {
  net.leaveRoom();
  location.href = '/';
});

function setBuildMode(mode: 'trap' | 'track'): void {
  buildMode = mode;
  tabTrap.classList.toggle('selected', mode === 'trap');
  tabTrack.classList.toggle('selected', mode === 'track');
  if (mode === 'trap') {
    show(obstaclePicks);
    hide(trackPicks);
    placeHint.textContent = 'Select a trap, then click asphalt to place (one per round)';
  } else {
    hide(obstaclePicks);
    trackPicks.classList.remove('hidden');
    placeHint.textContent = 'Select a piece, then click a green socket (one per round)';
  }
}
tabTrap.addEventListener('click', () => setBuildMode('trap'));
tabTrack.addEventListener('click', () => setBuildMode('track'));

for (const t of OBSTACLE_TYPES) {
  const b = document.createElement('button');
  b.className = 'btn';
  b.textContent = OBSTACLE_LABELS[t];
  b.addEventListener('click', (ev) => {
    ev.stopPropagation();
    selectedObstacle = t;
    itemPicked = true;
    buildMode = 'trap';
    setBuildMode('trap');
    obstaclePicks.querySelectorAll('button').forEach((x) => x.classList.remove('selected'));
    b.classList.add('selected');
  });
  obstaclePicks.appendChild(b);
}
(obstaclePicks.querySelector('button') as HTMLButtonElement)?.classList.add('selected');

for (const t of TRACK_PIECE_TYPES) {
  const b = document.createElement('button');
  b.className = 'btn';
  b.textContent = TRACK_PIECE_LABELS[t];
  b.addEventListener('click', (ev) => {
    ev.stopPropagation();
    selectedTrackPiece = t;
    itemPicked = true;
    buildMode = 'track';
    setBuildMode('track');
    trackPicks.querySelectorAll('button').forEach((x) => x.classList.remove('selected'));
    b.classList.add('selected');
  });
  trackPicks.appendChild(b);
}
(trackPicks.querySelector('button') as HTMLButtonElement)?.classList.add('selected');

function enterGame(): void {
  hide(menu);
  hide(lobby);
  show(gameRoot);
  ensureScene();
  startLoop();
  if ('ontouchstart' in window || navigator.maxTouchPoints > 0) show(mobileControls);
}

function renderLobby(s: RoomState): void {
  lobbyCode.textContent = s.code;
  lobbyTarget.textContent = String(s.targetScore);
  const url = roomUrl(s.code);
  lobbyLink.href = url;
  lobbyLink.textContent = url;
  playerList.innerHTML = '';
  for (const p of s.players) {
    const li = document.createElement('li');
    const sw = document.createElement('span');
    sw.className = 'swatch';
    sw.style.background = p.color;
    const name = document.createElement('span');
    name.textContent = p.name + (p.id === net.myId() ? ' (you)' : '') + (p.isHost ? ' 👑' : '');
    const badge = document.createElement('span');
    badge.className = 'badge' + (p.ready ? ' ready' : '');
    badge.textContent = !p.connected ? 'disconnected' : p.ready ? 'READY' : '…';
    li.append(sw, name, badge);
    playerList.appendChild(li);
  }
  const me = s.players.find((p) => p.id === net.myId());
  if (me?.isHost) show(btnStart);
  else hide(btnStart);
  lobbyMsg.textContent =
    s.players.filter((p) => p.connected).length < 2
      ? 'Waiting for at least 2 players… (max 10)'
      : `Players ${s.players.length}/10 — ready up; host starts.`;
}

function renderHud(s: RoomState): void {
  hudPhase.textContent = s.phase.toUpperCase();
  hudRound.textContent = s.round ? `Round ${s.round}` : '';
  const me = s.players.find((p) => p.id === net.myId());
  const myCar = s.cars.find((c) => c.id === net.myId());
  hudScore.textContent = me ? `Score ${me.score}/${s.targetScore}` : '';
  if (myCar?.finishPlace) hudPlace.textContent = `P${myCar.finishPlace}`;
  else if (myCar && s.phase === 'racing') {
    const sorted = [...s.cars].sort((a, b) => {
      if (a.finished !== b.finished) return a.finished ? -1 : 1;
      return b.lapProgress - a.lapProgress;
    });
    const place = sorted.findIndex((c) => c.id === net.myId()) + 1;
    hudPlace.textContent = place ? `P${place}` : '';
  } else hudPlace.textContent = '';

  scoreboard.innerHTML = s.players
    .slice()
    .sort((a, b) => b.score - a.score)
    .map((p) => `<div><span style="color:${p.color}">${p.name}</span><span>${p.score}</span></div>`)
    .join('');

  if (s.phase === 'countdown' && s.countdown > 0) {
    hudCountdown.textContent = String(s.countdown);
    show(hudCountdown);
  } else hide(hudCountdown);

  if (s.phase === 'results') {
    const lines = s.finishOrder.map((id, i) => {
      const p = s.players.find((x) => x.id === id);
      const pts = [5, 4, 3, 2, 1, 1, 0, 0, 0, 0][i] ?? 0;
      return `<div>${i + 1}. ${p?.name ?? '?'} <strong>+${pts}</strong></div>`;
    });
    resultsOverlay.innerHTML = `<h2>Race Results</h2>${lines.join('')}<p class="hint">Everyone places one trap or track piece…</p>`;
    show(resultsOverlay);
  } else hide(resultsOverlay);

  if (s.phase === 'placing') {
    show(placeUi);
    const meP = s.players.find((p) => p.id === net.myId());
    const placedCount = s.players.filter((p) => p.connected && p.hasPlaced).length;
    const total = s.players.filter((p) => p.connected).length;
    placeTimer.textContent = `${s.placeTimeLeft}s`;
    if (meP?.hasPlaced) {
      placeTurn.textContent = `Done! Waiting (${placedCount}/${total})…`;
      scene?.setPlacing(false);
      itemPicked = false;
    } else {
      placeTurn.textContent = `Build — pick ONE item, click map (${placedCount}/${total})`;
      scene?.setPlacing(true);
    }
  } else {
    hide(placeUi);
    scene?.setPlacing(false);
    itemPicked = false;
  }

  if (s.phase === 'gameover') {
    const w = s.players.find((p) => p.id === s.winnerId);
    winnerText.textContent = w ? `${w.name} wins!` : 'Game over';
    show(gameoverOverlay);
    if (me?.isHost) show(btnRematch);
    else hide(btnRematch);
  } else hide(gameoverOverlay);
}

function onState(s: RoomState): void {
  state = s;
  if (s.phase === 'lobby') {
    hide(menu);
    show(lobby);
    hide(gameRoot);
    renderLobby(s);
    return;
  }
  enterGame();
  ensureScene().sync(s);
  renderHud(s);
  renderLobby(s);
}

net.onRoomState(onState);
net.onCarsUpdate((update) => {
  if (!scene || !state) return;
  for (const c of update.cars) {
    const existing = state.cars.find((x) => x.id === c.id);
    if (existing) Object.assign(existing, c);
    else state.cars.push({ ...c, checkpoint: 0 });
  }
  if (state.phase === 'racing') {
    const myCar = state.cars.find((c) => c.id === net.myId());
    if (myCar?.finishPlace) hudPlace.textContent = `P${myCar.finishPlace}`;
  }
  scene.applyCarsUpdate(update);
});
net.onError((msg) => {
  menuError.textContent = msg;
});

function startLoop(): void {
  if (loopTimer) return;
  lastTick = performance.now();
  const tick = () => {
    loopTimer = requestAnimationFrame(tick) as unknown as number;
    const now = performance.now();
    const dt = Math.min(0.05, (now - lastTick) / 1000);
    lastTick = now;
    if (!state || !scene) return;

    if (state.phase === 'racing') {
      scene.tickLocal(keys, dt);
      poseAccum += dt;
      if (poseAccum >= 1 / 20) {
        poseAccum = 0;
        const pose = scene.getLocalPose();
        if (pose) {
          net.sendPose({
            ...pose,
            input: { ...keys },
          });
        }
      }
    }
    if (state.phase === 'placing') {
      const me = state.players.find((p) => p.id === net.myId());
      if (me && !me.hasPlaced) {
        const speed = 0.55;
        if (keys.left) scene.moveGhost(-speed, 0);
        if (keys.right) scene.moveGhost(speed, 0);
        if (keys.forward) scene.moveGhost(0, -speed);
        if (keys.back) scene.moveGhost(0, speed);
      }
    }
  };
  tick();
}

function bindKey(code: string, down: boolean): void {
  switch (code) {
    case 'KeyW':
    case 'ArrowUp':
      keys.forward = down;
      break;
    case 'KeyS':
    case 'ArrowDown':
      keys.back = down;
      break;
    case 'KeyA':
    case 'ArrowLeft':
      keys.left = down;
      break;
    case 'KeyD':
    case 'ArrowRight':
      keys.right = down;
      break;
    case 'Space':
      keys.boost = down;
      break;
  }
}
window.addEventListener('keydown', (e) => {
  if (e.repeat) return;
  bindKey(e.code, true);
  if (e.code === 'Space') e.preventDefault();
  if (e.code === 'Escape' && state?.phase === 'placing') net.skipPlace();
});
window.addEventListener('keyup', (e) => bindKey(e.code, false));

mobileControls.querySelectorAll('button').forEach((btn) => {
  const key = btn.getAttribute('data-key') as keyof InputState;
  const set = (v: boolean) => {
    if (key in keys) (keys as Record<string, boolean>)[key] = v;
  };
  btn.addEventListener('touchstart', (e) => {
    e.preventDefault();
    set(true);
  });
  btn.addEventListener('touchend', (e) => {
    e.preventDefault();
    set(false);
  });
  btn.addEventListener('mousedown', () => set(true));
  btn.addEventListener('mouseup', () => set(false));
  btn.addEventListener('mouseleave', () => set(false));
});

const params = new URLSearchParams(location.search);
const roomParam = params.get('room');
if (roomParam) {
  joinCodeInput.value = roomParam.toUpperCase();
  const join = () => {
    if (!nameInput.value.trim()) nameInput.value = 'Racer' + Math.floor(Math.random() * 90 + 10);
    void doJoin(roomParam);
  };
  net.getSocket().once('connect', join);
  if (net.getSocket().connected) join();
}
