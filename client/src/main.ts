import './style.css';
import type { InputState, ObstacleType, TrackPieceType, RoomState, PickKind } from '../../shared/types';
import {
  OBSTACLE_LABELS,
  OBSTACLE_ICONS,
  DEATH_TRAPS,
  TRACK_PIECE_LABELS,
  TRACK_PIECE_ICONS,
  FRUITS,
  TRACK_PIECE_HINTS,
} from '../../shared/types';

const fruitOf = (f?: string) => FRUITS.find((x) => x.type === f);
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
const placeItem = $('#place-item');
const pickUi = $('#pick-ui');
const pickGrid = $('#pick-grid');
const pickTimer = $('#pick-timer');
const pickStatus = $('#pick-status');
const hudGrace = $('#hud-grace');
const camHint = $('#cam-hint');
const resultsOverlay = $('#results-overlay');
const gameoverOverlay = $('#gameover-overlay');
const winnerText = $('#winner-text');
const btnRematch = $('#btn-rematch');
const mobileControls = $('#mobile-controls');

let scene: GameScene | null = null;
let state: RoomState | null = null;
// Read-only debug/test handle (used by automated browser tests)
let graceReceivedAt = 0;
/** Build-camera input state */
const camKeys = { q: false, e: false };
let lastMouse: { x: number; y: number } | null = null;
let camDrag: { mode: 'pan' | 'rotate'; x: number; y: number; id: number } | null = null;
const debugHandle = { frames: 0, errors: [] as string[], get phase() { return state?.phase; }, get state() { return state; }, get scene() { return scene; } };
(window as unknown as { __laptrap: typeof debugHandle }).__laptrap = debugHandle;
let selectedObstacle: ObstacleType = 'barrier';
let selectedTrackPiece: TrackPieceType = 'straight';
let buildMode: 'trap' | 'track' = 'trap';
let itemSelected = false;
let myReady = false;
let loopTimer: number | null = null;
let lastTick = performance.now();
let poseAccum = 0;

const keys: InputState = {
  forward: false, back: false, left: false, right: false, jump: false,
};

nameInput.value = localStorage.getItem('laptrap-name') || '';

function roomUrl(code: string): string {
  const u = new URL(location.href);
  u.searchParams.set('room', code);
  return u.toString();
}
function show(el: HTMLElement): void { el.classList.remove('hidden'); }
function hide(el: HTMLElement): void { el.classList.add('hidden'); }

function ensureScene(): GameScene {
  if (!scene) {
    const canvas = $('#game-canvas') as HTMLCanvasElement;
    scene = new GameScene(canvas);
    scene.start();
    // ---- Build camera: right/middle drag, wheel; left click stays reserved for placing ----
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    canvas.addEventListener('pointerdown', (e) => {
      if (!scene?.isBuildView() || e.button === 0) return;
      e.preventDefault();
      const rotate = e.button === 1 || e.shiftKey || e.altKey || e.ctrlKey;
      camDrag = { mode: rotate ? 'rotate' : 'pan', x: e.clientX, y: e.clientY, id: e.pointerId };
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!camDrag || e.pointerId !== camDrag.id || !scene) return;
      const dx = e.clientX - camDrag.x;
      const dy = e.clientY - camDrag.y;
      camDrag.x = e.clientX;
      camDrag.y = e.clientY;
      if (camDrag.mode === 'pan') scene.panBuildViewPixels(dx, dy);
      else scene.rotateBuildView(-dx * 0.006, dy * 0.004);
    });
    const endDrag = (e: PointerEvent) => {
      if (camDrag && e.pointerId === camDrag.id) {
        camDrag = null;
        if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
      }
    };
    canvas.addEventListener('pointerup', endDrag);
    canvas.addEventListener('pointercancel', endDrag);
    // Wheel anywhere over the game (incl. HUD panels) zooms, unless a panel actually needs to scroll
    gameRoot.addEventListener('wheel', (e) => {
      if (!scene?.isBuildView()) return;
      const panel = (e.target as HTMLElement | null)?.closest?.('#pick-ui') as HTMLElement | null;
      if (panel && panel.scrollHeight > panel.clientHeight + 2) return;
      e.preventDefault();
      scene.zoomBuildView(Math.exp(Math.max(-200, Math.min(200, e.deltaY)) * 0.0015));
    }, { passive: false });
    canvas.addEventListener('mouseleave', () => { lastMouse = null; });
    canvas.addEventListener('mousemove', (e) => {
      lastMouse = { x: e.clientX, y: e.clientY };
      if (!scene?.placing || !state) return;
      const me = state.players.find((p) => p.id === net.myId());
      if (me?.hasPlaced) return;
      const hit = scene.screenToTrack(e.clientX, e.clientY);
      if (hit) scene.updateGhostCursor(hit.x, hit.z, buildMode === 'track');
    });
    canvas.addEventListener('click', (e) => { void onMapClick(e); });
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
  // Traps: exact cursor spot anywhere on the map. Track: snap to sockets.
  const pick = buildMode === 'track'
    ? scene.setGhostFromClick(hit.x, hit.z)
    : (scene.updateGhostCursor(hit.x, hit.z, false), { kind: 'ground' as const, socketId: null });

  if (!itemSelected) {
    flash('Select an item from the toolbar first');
    return;
  }

  if (buildMode === 'track') {
    // Snap to nearest socket under cursor
    scene.updateGhostCursor(hit.x, hit.z, true);
    const sockId = scene.selectedSocketId || pick.socketId;
    if (!sockId) {
      flash('Click near a green socket');
      return;
    }
    const res = await net.placeTrackPiece(selectedTrackPiece, sockId);
    if (!res.ok) flash(res.error || 'Place failed');
    return;
  }

  if (!scene.ghostValid) {
    flash('Can’t place there (START/spawn zone, map edge, or on another trap)');
    return;
  }
  const res = await net.placeObstacle(selectedObstacle, scene.ghostPos.x, scene.ghostPos.z, scene.ghostPos.yaw);
  if (!res.ok) flash(res.error || 'Place failed');
}

function flash(msg: string): void {
  hudBanner.textContent = msg;
  show(hudBanner);
  setTimeout(() => hide(hudBanner), 1400);
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
  hide(menu); show(lobby);
}

async function doJoin(code?: string): Promise<void> {
  menuError.textContent = '';
  const name = nameInput.value.trim() || 'Runner';
  localStorage.setItem('laptrap-name', name);
  const c = (code || joinCodeInput.value).toUpperCase().trim();
  if (!c) { menuError.textContent = 'Enter a room code'; return; }
  const res = await net.joinRoom(c, name);
  if (!res.ok) { menuError.textContent = res.error || 'Could not join'; return; }
  history.replaceState(null, '', `/?room=${c}`);
  hide(menu); show(lobby);
}

$('#btn-create').addEventListener('click', () => void doCreate());
$('#btn-join').addEventListener('click', () => void doJoin());
joinCodeInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') void doJoin(); });
btnReady.addEventListener('click', () => {
  myReady = !myReady;
  net.setReady(myReady);
  btnReady.textContent = myReady ? 'Unready' : 'Ready';
});
btnStart.addEventListener('click', () => net.startGame());
$('#btn-leave').addEventListener('click', () => { net.leaveRoom(); location.href = '/'; });
$('#btn-copy').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(lobbyLink.href);
    lobbyMsg.textContent = 'Link copied!';
  } catch { lobbyMsg.textContent = 'Copy failed'; }
});
$('#btn-skip-place').addEventListener('click', () => net.skipPlace());
$('#btn-recenter').addEventListener('click', (e) => { e.stopPropagation(); scene?.resetBuildView(); });
btnRematch.addEventListener('click', () => net.rematch());
$('#btn-home').addEventListener('click', () => { net.leaveRoom(); location.href = '/'; });

/** Log an error without letting it break the game loop or socket handlers. */
function reportError(where: string, err: unknown): void {
  const msg = `${where}: ${err instanceof Error ? err.message : String(err)}`;
  debugHandle.errors.push(msg);
  if (debugHandle.errors.length > 50) debugHandle.errors.shift();
  console.error('[laptrap]', where, err);
}

function itemIcon(kind: PickKind, type: string): string {
  return kind === 'track' ? TRACK_PIECE_ICONS[type as TrackPieceType] : OBSTACLE_ICONS[type as ObstacleType];
}
function itemLabel(kind: PickKind, type: string): string {
  return kind === 'track' ? TRACK_PIECE_LABELS[type as TrackPieceType] : OBSTACLE_LABELS[type as ObstacleType];
}

/** Pick cards are created once per pool and updated in place, so clicks never hit a detached button. */
let pickPoolKey = '';
const pickCards = new Map<string, HTMLButtonElement>();

function renderPick(s: RoomState): void {
  if (s.phase !== 'picking') {
    hide(pickUi);
    return;
  }
  show(pickUi);
  const me = s.players.find((p) => p.id === net.myId());
  pickTimer.textContent = `${s.pickTimeLeft}s`;
  const key = s.pickPool.map((i) => i.id).join(',');
  if (key !== pickPoolKey) {
    pickPoolKey = key;
    pickCards.clear();
    pickGrid.innerHTML = '';
    for (const item of s.pickPool) {
      const b = document.createElement('button');
      b.type = 'button';
      const death = item.kind === 'trap' && DEATH_TRAPS.includes(item.type as ObstacleType);
      b.dataset.base = `pick-card ${item.kind}${death ? ' death' : ''}`;
      b.className = b.dataset.base;
      b.innerHTML = `<span class="ico">${itemIcon(item.kind, item.type)}</span><span>${itemLabel(item.kind, item.type)}</span>` +
        `<span class="kind">${item.kind === 'track' ? 'track tile' : death ? 'death trap' : 'trap'}</span>` +
        (item.kind === 'track' ? `<span class="tile-hint">${TRACK_PIECE_HINTS[item.type as TrackPieceType]}</span>` : '') +
        `<span class="who"></span>`;
      // pointerdown = fastest possible claim; server decides who was first
      b.addEventListener('pointerdown', async (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        if (b.disabled) {
          const cur = state?.pickPool.find((i) => i.id === item.id);
          const who = cur?.claimedBy ? state?.players.find((p) => p.id === cur.claimedBy)?.name : null;
          if (who && cur?.claimedBy !== net.myId()) flash(`Too slow — ${who} took it`);
          return;
        }
        const res = await net.claimPick(item.id);
        if (!res.ok) flash(res.error || 'Could not pick');
      });
      pickCards.set(item.id, b);
      pickGrid.appendChild(b);
    }
  }
  for (const item of s.pickPool) {
    const b = pickCards.get(item.id);
    if (!b) continue;
    const owner = item.claimedBy ? s.players.find((p) => p.id === item.claimedBy) : null;
    b.className = `${b.dataset.base}${owner ? ' claimed' : ''}${owner && owner.id === net.myId() ? ' mine' : ''}`;
    b.disabled = !!owner || !!me?.claim;
    const who = b.querySelector('.who');
    if (who) who.textContent = owner ? `${fruitOf(owner.fruit)?.emoji ?? ''} ${owner.name}` : '';
  }
  const picked = s.players.filter((p) => p.connected && p.claim).length;
  const total = s.players.filter((p) => p.connected).length;
  pickStatus.textContent = me?.claim
    ? `You got ${itemIcon(me.claim.kind, me.claim.type)} ${itemLabel(me.claim.kind, me.claim.type)} — waiting (${picked}/${total})…`
    : `Click one item. No pick when the timer ends = random leftover. (${picked}/${total})`;
}

function enterGame(): void {
  hide(menu); hide(lobby); show(gameRoot);
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
    const fr = fruitOf(p.fruit);
    name.textContent = `${fr?.emoji ?? ''} ${p.name}` + (fr ? ` · ${fr.name}` : '') + (p.id === net.myId() ? ' (you)' : '') + (p.isHost ? ' 👑' : '');
    const badge = document.createElement('span');
    badge.className = 'badge' + (p.ready ? ' ready' : '');
    badge.textContent = !p.connected ? 'disconnected' : p.ready ? 'READY' : '…';
    li.append(sw, name, badge);
    playerList.appendChild(li);
  }
  const me = s.players.find((p) => p.id === net.myId());
  if (me?.isHost) show(btnStart); else hide(btnStart);
  lobbyMsg.textContent =
    s.players.filter((p) => p.connected).length < 2
      ? 'Waiting for at least 2 players… (max 10)'
      : `Players ${s.players.length}/10 — ready up; host starts.`;
}

function renderHud(s: RoomState): void {
  const phaseNames: Record<string, string> = { racing: 'RUN!', picking: 'PICK', placing: 'PLACE', countdown: 'GET READY' };
  hudPhase.textContent = phaseNames[s.phase] ?? s.phase.toUpperCase();
  hudRound.textContent = s.round ? `Round ${s.round}` : '';
  const me = s.players.find((p) => p.id === net.myId());
  const myCar = s.cars.find((c) => c.id === net.myId());
  hudScore.textContent = me ? `Score ${me.score}/${s.targetScore}` : '';

  if (myCar?.eliminated) {
    hudPlace.textContent = `OUT${myCar.eliminateReason ? ': ' + myCar.eliminateReason : ''}`;
  } else if (myCar?.finishPlace) {
    hudPlace.textContent = `P${myCar.finishPlace}`;
  } else if (myCar && s.phase === 'racing') {
    const sorted = [...s.cars].filter((c) => !c.eliminated).sort((a, b) => {
      if (a.finished !== b.finished) return a.finished ? -1 : 1;
      return b.lapProgress - a.lapProgress;
    });
    const place = sorted.findIndex((c) => c.id === net.myId()) + 1;
    hudPlace.textContent = place ? `P${place}` : '';
  } else hudPlace.textContent = '';

  scoreboard.innerHTML = s.players
    .slice()
    .sort((a, b) => b.score - a.score)
    .map((p) => {
      const car = s.cars.find((c) => c.id === p.id);
      const tag = car?.eliminated ? ' 💀' : '';
      return `<div><span style="color:${p.color}">${fruitOf(p.fruit)?.emoji ?? ''} ${p.name}${tag}</span><span>${p.score}</span></div>`;
    })
    .join('');

  if (s.phase === 'countdown' && s.countdown > 0) {
    hudCountdown.textContent = String(s.countdown);
    show(hudCountdown);
  } else hide(hudCountdown);

  if (s.phase === 'results') {
    const lines = s.finishOrder.map((id, i) => {
      const p = s.players.find((x) => x.id === id);
      const car = s.cars.find((c) => c.id === id);
      const pts = [5, 4, 3, 2, 1, 1, 0, 0, 0, 0][i] ?? 0;
      const dnf = car?.eliminated ? ` <em>(DNF${car.eliminateReason ? ': ' + car.eliminateReason : ''})</em>` : '';
      return `<div>${i + 1}. ${p?.name ?? '?'}${dnf} <strong>+${pts}</strong></div>`;
    });
    resultsOverlay.innerHTML = `<h2>Run Results</h2>${lines.join('')}<p class="hint">Next: pick one item from the shared pool…</p>`;
    show(resultsOverlay);
  } else hide(resultsOverlay);

  const building = s.phase === 'picking' || s.phase === 'placing';
  scene?.setBuildView(building);
  if (building) show(camHint); else hide(camHint);

  if (s.phase === 'placing') {
    show(placeUi);
    const meP = s.players.find((p) => p.id === net.myId());
    const claim = meP?.claim ?? null;
    if (claim) {
      buildMode = claim.kind;
      if (claim.kind === 'trap') selectedObstacle = claim.type as ObstacleType;
      else selectedTrackPiece = claim.type as TrackPieceType;
      itemSelected = true;
      placeItem.innerHTML = `<span class="ico">${itemIcon(claim.kind, claim.type)}</span><span>Your item: <strong>${itemLabel(claim.kind, claim.type)}</strong></span>`;
      placeHint.textContent = claim.kind === 'trap'
        ? 'Left-click ANYWHERE on the map to place it · R rotates · Esc skip'
        : 'Left-click a green socket to attach it · Esc skip';
    } else {
      itemSelected = false;
      placeItem.textContent = 'No item this round — sit tight.';
      placeHint.textContent = '';
    }
    const placedCount = s.players.filter((p) => p.connected && p.hasPlaced).length;
    const total = s.players.filter((p) => p.connected).length;
    placeTimer.textContent = `${s.placeTimeLeft}s`;
    if (meP?.hasPlaced) {
      placeTurn.textContent = `Placed! Waiting (${placedCount}/${total})…`;
      scene?.setPlacing(false);
      itemSelected = false;
    } else {
      placeTurn.textContent = `Place it! (${placedCount}/${total} placed)`;
      scene?.setPlacing(true);
      scene?.setGhostType(buildMode === "trap" ? selectedObstacle : null);
    }
  } else {
    hide(placeUi);
    scene?.setPlacing(false);
  }

  if (s.phase === 'gameover') {
    const w = s.players.find((p) => p.id === s.winnerId);
    winnerText.textContent = w ? `${w.name} wins!` : 'Game over';
    show(gameoverOverlay);
    if (me?.isHost) show(btnRematch); else hide(btnRematch);
  } else hide(gameoverOverlay);
}

function onState(s: RoomState): void {
  try {
    onStateInner(s);
  } catch (err) {
    reportError('roomState', err);
  }
}

function onStateInner(s: RoomState): void {
  state = s;
  graceReceivedAt = performance.now();
  if (s.phase === 'lobby') {
    hide(menu); show(lobby); hide(gameRoot);
    renderLobby(s);
    return;
  }
  enterGame();
  ensureScene().sync(s);
  renderHud(s);
  renderPick(s);
  renderLobby(s);

  const myCar = s.cars.find((c) => c.id === net.myId());
  if (myCar?.eliminated && myCar.eliminateReason && s.phase === 'racing') {
    flash(`Eliminated — ${myCar.eliminateReason}`);
  }
}

net.onRoomState(onState);
net.onCarsUpdate((update) => {
  if (!scene || !state) return;
  try {
    applyCars(update);
  } catch (err) {
    reportError('carsUpdate', err);
  }
});
function applyCars(update: Parameters<GameScene['applyCarsUpdate']>[0]): void {
  if (!scene || !state) return;
  for (const c of update.cars) {
    const existing = state.cars.find((x) => x.id === c.id);
    if (existing) Object.assign(existing, c);
    else state.cars.push({ ...c, checkpoint: 0 });
  }
  const myCar = state.cars.find((c) => c.id === net.myId());
  if (myCar?.eliminated) {
    hudPlace.textContent = `OUT${myCar.eliminateReason ? ': ' + myCar.eliminateReason : ''}`;
  }
  scene.applyCarsUpdate(update);
}
net.onError((msg) => { menuError.textContent = msg; });

function startLoop(): void {
  if (loopTimer) return;
  lastTick = performance.now();
  const tick = () => {
    loopTimer = requestAnimationFrame(tick) as unknown as number;
    debugHandle.frames++;
    const now = performance.now();
    const dt = Math.min(0.05, (now - lastTick) / 1000);
    lastTick = now;
    if (!state || !scene) return;
    try {
      tickGame(dt);
    } catch (err) {
      reportError('tick', err);
    }
  };
  tick();
}

function tickGame(dt: number): void {
    if (!state || !scene) return;
    // Grace countdown after the first finisher
    if (state.phase === 'racing' && state.graceLeftMs > 0) {
      const left = Math.max(0, state.graceLeftMs - (performance.now() - graceReceivedAt));
      hudGrace.textContent = `⏱ ${Math.ceil(left / 1000)}s to finish!`;
      show(hudGrace);
    } else hide(hudGrace);

    if (state.phase === 'racing') {
      const myCar = state.cars.find((c) => c.id === net.myId());
      if (!myCar?.eliminated && !myCar?.finished) {
        const result = scene.tickLocal(keys, dt, state.obstacles);
        poseAccum += dt;
        if (poseAccum >= 1 / 20) {
          poseAccum = 0;
          const pose = scene.getLocalPose();
          if (pose) {
            net.sendPose({ ...pose, input: { ...keys } });
          }
        }
        // Dropped below the death plane: tell the server right away (it eliminates)
        if (result.fellOff) {
          const pose = scene.getLocalPose();
          if (pose) net.sendPose({ ...pose, input: { ...keys } });
        }
      }
    }
    if (scene.isBuildView()) {
      // WASD / arrows pan, Q/E rotate
      const k = dt * 60;
      const right = (keys.right ? 1 : 0) - (keys.left ? 1 : 0);
      const up = (keys.forward ? 1 : 0) - (keys.back ? 1 : 0);
      if (right || up) scene.panBuildView(right * 1.2 * k, up * 1.2 * k);
      const rot = (camKeys.e ? 1 : 0) - (camKeys.q ? 1 : 0);
      if (rot) scene.rotateBuildView(rot * 1.6 * dt);
      // camera may have moved under a still mouse: keep the ghost glued to the cursor
      if (scene.placing && lastMouse) {
        const hit = scene.screenToTrack(lastMouse.x, lastMouse.y);
        if (hit) scene.updateGhostCursor(hit.x, hit.z, buildMode === 'track');
      }
    }
}

function bindKey(code: string, down: boolean): void {
  switch (code) {
    case 'KeyW': case 'ArrowUp': keys.forward = down; break;
    case 'KeyS': case 'ArrowDown': keys.back = down; break;
    case 'KeyA': case 'ArrowLeft': keys.left = down; break;
    case 'KeyD': case 'ArrowRight': keys.right = down; break;
    case 'Space': keys.jump = down; break;
    case 'KeyR': if (down && scene?.placing && buildMode === 'trap') scene.rotateGhost(Math.PI / 4); break;
    case 'KeyQ': camKeys.q = down; break;
    case 'KeyE': camKeys.e = down; break;
    case 'KeyF': case 'KeyC': if (down && scene?.isBuildView()) scene.resetBuildView(); break;
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
  const set = (v: boolean) => { if (key in keys) (keys as unknown as Record<string, boolean>)[key] = v; };
  btn.addEventListener('touchstart', (e) => { e.preventDefault(); set(true); });
  btn.addEventListener('touchend', (e) => { e.preventDefault(); set(false); });
  btn.addEventListener('mousedown', () => set(true));
  btn.addEventListener('mouseup', () => set(false));
  btn.addEventListener('mouseleave', () => set(false));
});

const params = new URLSearchParams(location.search);
const roomParam = params.get('room');
if (roomParam) {
  joinCodeInput.value = roomParam.toUpperCase();
  const join = () => {
    if (!nameInput.value.trim()) nameInput.value = 'Runner' + Math.floor(Math.random() * 90 + 10);
    void doJoin(roomParam);
  };
  net.getSocket().once('connect', join);
  if (net.getSocket().connected) join();
}
