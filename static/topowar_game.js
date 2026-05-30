// === GLOBALS ===
const gameId = window.TOPOS_GAME_ID;

// === BUILD PHASE MUSIC ===
let _bgMusic = null;
let _musicEnabled = localStorage.getItem('tw_music_enabled') !== 'false';
let _wasBuildPhase = false;
let _musicPendingPlay = false;
let _musicFading = false;
let _musicFadeTimer = null;

function _ensureBgMusic() {
  if (_bgMusic) return;
  _bgMusic = new Audio('/static/build_music.mp3');
  _bgMusic.loop = true;
  _bgMusic.volume = 0.6;
  _bgMusic.preload = 'auto';
}

function startBuildMusic() {
  if (!_musicEnabled) return;
  _ensureBgMusic();
  if (_musicFadeTimer) { clearInterval(_musicFadeTimer); _musicFadeTimer = null; }
  _musicFading = false;
  _bgMusic.volume = 0.6;
  if (_bgMusic.paused) {
    _bgMusic.play().then(() => { _musicPendingPlay = false; }).catch(() => { _musicPendingPlay = true; });
  }
}

function fadeBuildMusic() {
  if (!_bgMusic || _bgMusic.paused) return;
  if (_musicFadeTimer) clearInterval(_musicFadeTimer);
  _musicFading = true;
  _musicFadeTimer = setInterval(() => {
    if (!_bgMusic || _bgMusic.volume <= 0.03) {
      if (_bgMusic) { _bgMusic.pause(); _bgMusic.volume = 0.6; }
      clearInterval(_musicFadeTimer);
      _musicFadeTimer = null;
      _musicFading = false;
      return;
    }
    _bgMusic.volume = Math.max(0, _bgMusic.volume - 0.025);
  }, 80);
}

function updateMusicBtn() {
  const btn = document.getElementById('tw-music-btn');
  if (!btn) return;
  btn.classList.toggle('off', !_musicEnabled);
  btn.title = _musicEnabled ? 'Music: On (click to mute)' : 'Music: Off (click to unmute)';
}

function toggleBuildMusic() {
  _musicEnabled = !_musicEnabled;
  localStorage.setItem('tw_music_enabled', String(_musicEnabled));
  if (!_musicEnabled) {
    if (_musicFadeTimer) { clearInterval(_musicFadeTimer); _musicFadeTimer = null; }
    if (_bgMusic) { _bgMusic.pause(); _bgMusic.volume = 0.6; }
  } else if (_wasBuildPhase) {
    startBuildMusic();
  }
  updateMusicBtn();
}

// Unlock deferred play after first user interaction
document.addEventListener('pointerdown', () => {
  if (_musicPendingPlay && _musicEnabled && _wasBuildPhase) {
    _musicPendingPlay = false;
    startBuildMusic();
  }
}, { capture: true });


const playerKey = new URLSearchParams(window.location.search).get('player') || '';
const board = document.getElementById('board');
const boardScroll = document.getElementById('board-scroll');
const ctx = board.getContext('2d');

let ws = null;
let state = null;
let mode = 'select';
let selectedUnits = new Set();
let selectedMg = null;
let selectedMortar = null;
let retargetMortarId = null;
let plan = [];
let pendingBuildTile = null;
let pendingBuildFacing = null; // degrees, null = not yet set
let pendingMgDispatch = false;
let pendingMortarTile = null;
let pendingMortarTarget = null;
let pendingMortarDispatch = false;
let boardZoom = 1;

let mouseCanvas = { x: 0, y: 0 };

let lastStateTime = performance.now();
let moveOrderPings = []; // {x, y, age} — brief confirmation ring at a move destination
let smokeParticles = [];
let smokeLayer = null;  // offscreen canvas for mortar puffs — caps stacking opacity
let lastSmokeTick = performance.now();
let poppedAirburstShells = new Set();
let lastPanelHtml = '';
let elevMap = new Map();
const pendingWaypoints = new Map(); // unit_id → [[x,y],...] queued after current path
let planDragging = false;
let formationCount = 1;
let formationShape = 'horizontal';
let selectedSquad = null;
let buildFlyoutOpen = false;
// Squad tactical boxes: squadId → {kind:'killbox'|'defend', x0,y0,x1,y1 (tile coords), ax,ay (approach corner tile)}
let squadBoxes = new Map();
let armedBoxKind = null;       // 'killbox' | 'defend' when the next board-drag will define a box
let boxInteraction = null;     // active drag: {squadId, kind, mode:'create'|'resize', handle, ax, ay}
const BUILD_MODES = new Set(['build', 'mortar', 'sandbag', 'wire', 'bunker']);

// Smooth soldier interpolation: display position trails toward server position.
const soldierDisplayPos = new Map(); // unit_id → {x, y}

// Box / marquee selection state.
let selectBox = null; // {x0, y0, x1, y1} in canvas coords, null when inactive

// Impact particle effects — dirt puffs (miss) and kill sparks (hit)
let impactParticles = []; // {x, y, vx, vy, alpha, r, color, age, maxAge}
let _prevProjectiles = []; // previous frame's projectile list for disappearance detection

const CELL = 24;
const OX = 20;
const OY = 20;
const RIFLE_RANGE = 10;
const RIFLE_RANGE_HILL = 12;
const RIFLE_RANGE_MOUNTAIN = 14;
const GRENADIER_RANGE = 7;
const MG_RANGE = 20;
const MIN_BOARD_ZOOM = 0.6;
const MAX_BOARD_ZOOM = 1.8;

function el(id) { return document.getElementById(id); }
function wsUrl() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/ws/game/${encodeURIComponent(gameId)}?player=${encodeURIComponent(playerKey)}`;
}
function send(payload) { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload)); }
let _lastErrMsg = null;
let _lastErrTime = 0;
const ERR_PERSIST_MS = 4000;

function setStatus(msg, bad = false) {
  const e = el('status-line');
  if (!e) return;
  if (bad) {
    _lastErrMsg = msg;
    _lastErrTime = Date.now();
    e.textContent = msg || '';
    e.style.color = '#ff9a9a';
  } else {
    if (_lastErrMsg && (Date.now() - _lastErrTime) < ERR_PERSIST_MS) return;
    _lastErrMsg = null;
    e.textContent = msg || '';
    e.style.color = '';
  }
}

function clampZoom(z) {
  return Math.max(MIN_BOARD_ZOOM, Math.min(MAX_BOARD_ZOOM, z));
}

function applyBoardZoom() {
  if (!board || !boardScroll) return;
  boardZoom = clampZoom(boardZoom);
  board.style.width = `${Math.round(board.width * boardZoom)}px`;
  board.style.height = `${Math.round(board.height * boardZoom)}px`;
}

function setupBoardZoomControl() {
  const dock = el('topowar-zoom-dock');
  const track = el('topowar-zoom-track');
  const thumb = el('topowar-zoom-thumb');
  if (!dock || !track || !thumb) return;

  let dragging = false;
  const toZoom = (evt) => {
    const rect = track.getBoundingClientRect();
    const y = Math.max(0, Math.min(rect.height, evt.clientY - rect.top));
    const ratio = 1 - (y / rect.height);
    return MIN_BOARD_ZOOM + ratio * (MAX_BOARD_ZOOM - MIN_BOARD_ZOOM);
  };
  const syncControl = () => {
    const ratio = (boardZoom - MIN_BOARD_ZOOM) / (MAX_BOARD_ZOOM - MIN_BOARD_ZOOM);
    const y = (1 - Math.max(0, Math.min(1, ratio))) * track.clientHeight;
    thumb.style.top = `${y}px`;
    track.setAttribute('aria-valuenow', String(Math.round(boardZoom * 100)));
  };
  const setFromEvent = (evt) => {
    boardZoom = toZoom(evt);
    applyBoardZoom();
    syncControl();
  };

  const onMove = (evt) => {
    if (!dragging) return;
    setFromEvent(evt);
  };
  const stopDragging = () => {
    if (!dragging) return;
    dragging = false;
    document.body.style.cursor = '';
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', stopDragging);
  };

  const startDragging = (evt) => {
    dragging = true;
    document.body.style.cursor = 'ns-resize';
    thumb.setPointerCapture(evt.pointerId);
    setFromEvent(evt);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', stopDragging);
  };

  thumb.addEventListener('pointerdown', (evt) => {
    evt.preventDefault();
    startDragging(evt);
  });
  track.addEventListener('pointerdown', (evt) => {
    evt.preventDefault();
    startDragging(evt);
  });
  track.addEventListener('keydown', (evt) => {
    if (evt.key === 'ArrowUp' || evt.key === 'ArrowRight') {
      boardZoom = clampZoom(boardZoom + 0.05);
    } else if (evt.key === 'ArrowDown' || evt.key === 'ArrowLeft') {
      boardZoom = clampZoom(boardZoom - 0.05);
    } else {
      return;
    }
    evt.preventDefault();
    applyBoardZoom();
    syncControl();
  });

  syncControl();
}

function connect() {
  ws = new WebSocket(wsUrl());
  ws.onopen = () => setStatus('Connected.');
  ws.onmessage = (evt) => {
    const payload = JSON.parse(evt.data);
    if (payload.type === 'state') {
      if (payload.message && state) state.log = [...(state.log || []), payload.message].slice(-20);
      const prevTw = state?.topowar;
      state = payload.state;
      lastStateTime = performance.now();
      const newTw = state?.topowar;
      if (newTw?.map) rebuildElevMap(newTw.map);
      // Prune tactical boxes for squads that no longer exist or have no living members.
      for (const squadId of [...squadBoxes.keys()]) {
        if (!getSquad(squadId) || squadSoldierIds(squadId).length === 0) squadBoxes.delete(squadId);
      }
      if (prevTw && newTw) {
        const prevPos = new Set((prevTw.explosions || []).map(e => `${Math.round(e.x)},${Math.round(e.y)}`));
        for (const ex of newTw.explosions || []) {
          if (!prevPos.has(`${Math.round(ex.x)},${Math.round(ex.y)}`)) {
            if (ex.airburst) {
              const kr = ex.kill_radius || 3.0;
              const cx = Math.round(ex.x), cy = Math.round(ex.y);
              for (let dy = -Math.ceil(kr); dy <= Math.ceil(kr); dy++) {
                for (let dx = -Math.ceil(kr); dx <= Math.ceil(kr); dx++) {
                  if (Math.sqrt(dx * dx + dy * dy) > kr) continue;
                  const tx = cx + dx, ty = cy + dy;
                  if ((tx + ty) % 2 !== (cx + cy) % 2) continue;
                  spawnAirburstTileSmoke(tx + 0.5, ty + 0.5);
                }
              }
            } else {
              spawnSmoke(ex.x, ex.y);
            }
          }
        }
        // Detect airburst shells newly popped server-side and spawn pop smoke.
        const prevShellMap = new Map(
          (prevTw.mortar_shells || [])
            .filter(ms => ms.round_type === 'airburst')
            .map(ms => [`${ms.sx},${ms.sy},${ms.target[0]},${ms.target[1]}`, ms])
        );
        for (const ms of (newTw.mortar_shells || [])) {
          if (ms.round_type !== 'airburst' || !ms.popped) continue;
          const popKey = `${ms.sx},${ms.sy},${ms.target[0]},${ms.target[1]}`;
          if (!poppedAirburstShells.has(popKey)) {
            poppedAirburstShells.add(popKey);
            spawnAirburstPop(ms.x, ms.y);
          }
        }
        // Clean up popped-shell keys for shells that are no longer in flight
        const activeShellKeys = new Set(
          (newTw.mortar_shells || []).map(ms => `${ms.sx},${ms.sy},${ms.target[0]},${ms.target[1]}`)
        );
        for (const k of poppedAirburstShells) {
          if (!activeShellKeys.has(k)) poppedAirburstShells.delete(k);
        }

        // Hit/miss tells: new death_marks → kill spark; vanished projectiles → dirt puff
        const prevDmKeys = new Set((_prevProjectiles._dmKeys) || []);
        const newDmKeys = new Set((newTw.death_marks || []).map(dm => `${dm.x.toFixed(1)},${dm.y.toFixed(1)}`));
        for (const key of newDmKeys) {
          if (!prevDmKeys.has(key)) {
            const dm = (newTw.death_marks || []).find(d => `${d.x.toFixed(1)},${d.y.toFixed(1)}` === key);
            if (dm) spawnKillSpark(dm.x, dm.y);
          }
        }
        // Detect rifle/mg projectiles that vanished (not a kill) → dirt puff at last position
        // Match using owner+source+rounded_direction (constant per projectile lifetime).
        const newProjSig = {};
        for (const p of (newTw.projectiles || [])) {
          const norm = Math.hypot(p.dx, p.dy);
          const sig = `${p.owner},${p.source},${norm > 0 ? Math.round(p.dx/norm*8) : 0},${norm > 0 ? Math.round(p.dy/norm*8) : 0}`;
          newProjSig[sig] = (newProjSig[sig] || 0) + 1;
        }
        for (const pp of _prevProjectiles) {
          const norm = Math.hypot(pp.dx, pp.dy);
          const sig = `${pp.owner},${pp.source},${norm > 0 ? Math.round(pp.dx/norm*8) : 0},${norm > 0 ? Math.round(pp.dy/norm*8) : 0}`;
          if (!newProjSig[sig] || newProjSig[sig] <= 0) {
            if (!pp.will_hit) spawnDirtPuff(pp.x, pp.y);
          } else {
            newProjSig[sig]--;
          }
        }
        const nextPrev = [...(newTw.projectiles || [])];
        nextPrev._dmKeys = newDmKeys;
        _prevProjectiles = nextPrev;
      }
      reconcilePendingBuildState();
      // Track build phase transitions for background music
      const _nowBuildPhase = (state?.topowar?.build_phase_remaining || 0) > 0;
      if (_nowBuildPhase && !_wasBuildPhase) startBuildMusic();
      if (!_nowBuildPhase && _wasBuildPhase) fadeBuildMusic();
      _wasBuildPhase = _nowBuildPhase;
      // Drain waypoint queues: send next waypoint when a unit finishes its current path
      for (const s of state?.topowar?.soldiers || []) {
        if (s.owner !== mySeat()) continue;
        const queue = pendingWaypoints.get(s.unit_id);
        if (!queue || queue.length === 0) continue;
        const idle = (!s.path || s.path.length === 0) &&
                     (!s.current_task || s.current_task.type === 'move');
        if (idle) {
          const next = queue.shift();
          send({ type: 'tw_move_unit', unit_id: s.unit_id, tile: next });
        }
      }
      render();
    } else if (payload.type === 'error') {
      pendingMgDispatch = false;
      pendingMortarDispatch = false;
      setStatus(payload.message || 'Error', true);
    }
  };
  ws.onclose = () => { setStatus('Disconnected. Reconnecting…', true); setTimeout(connect, 1200); };
}

function mySeat() { return state?.my_seat ?? null; }
// A side can issue squad/formation orders only while it has a living officer.
function hasCommand() {
  const seat = mySeat();
  if (seat === null) return false;
  const ca = tw()?.command_available;
  return ca ? !!ca[String(seat)] : true;
}
function tw() { return state?.topowar || null; }

function tileFromEvent(evt) {
  if (!tw()) return null;
  const rect = board.getBoundingClientRect();
  const px = (evt.clientX - rect.left) * (board.width / rect.width);
  const py = (evt.clientY - rect.top) * (board.height / rect.height);
  return tileFromCanvas(px, py);
}

function tileFromCanvas(px, py) {
  if (!tw()) return null;
  const tx = Math.floor((px - OX) / CELL);
  let gy = Math.floor((py - OY) / CELL);
  if (tx < 0 || gy < 0 || tx >= tw().map.width || gy >= tw().map.height) return null;
  // Convert visual row back to game coordinate for player 2
  if (mySeat() === 1) gy = tw().map.height - 1 - gy;
  return [tx, gy];
}

function soldiersAt(tile) {
  return (tw()?.soldiers || []).filter(s => s.tile[0] === tile[0] && s.tile[1] === tile[1]);
}
function mySoldiersAt(tile) { return soldiersAt(tile).filter(s => s.owner === mySeat()); }
function tileHasEquipment(tile) {
  const d = tw(); if (!d) return false;
  const [tx, ty] = tile;
  const at = t => t[0] === tx && t[1] === ty;
  return (d.machine_guns || []).some(m => m.hp > 0 && at(m.tile)) ||
         (d.mortars || []).some(m => m.hp > 0 && at(m.tile)) ||
         (d.sandbags || []).some(s => s.hp > 0 && at(s.tile)) ||
         (d.barbed_wire || []).some(w => w.hp > 0 && w.built && at(w.tile));
}
function myOfficer() {
  const seat = mySeat();
  if (seat === null) return null;
  return (tw()?.soldiers || []).find(s => s.owner === seat && s.is_officer) || null;
}
function mgAt(tile) {
  return (tw()?.machine_guns || []).find(m => m.tile[0] === tile[0] && m.tile[1] === tile[1]) || null;
}
function myMgAt(tile) {
  const mg = mgAt(tile);
  return (mg && mg.owner === mySeat()) ? mg : null;
}
function firstSelected() {
  for (const uid of selectedUnits) {
    if ((tw()?.soldiers || []).find(s => s.unit_id === uid)) return uid;
  }
  return null;
}
// Auto-assign the nearest N friendly soldiers to crew an MG or mortar.
function crewStructure(kind, struct, n) {
  const seat = mySeat();
  const ops = (tw().soldiers || [])
    .filter(s => s.owner === seat && s.hp > 0)
    .sort((a, b) =>
      Math.hypot(a.tile[0]-struct.tile[0], a.tile[1]-struct.tile[1]) -
      Math.hypot(b.tile[0]-struct.tile[0], b.tile[1]-struct.tile[1]))
    .slice(0, n).map(s => s.unit_id);
  if (!ops.length) { setStatus('No soldiers available to crew.', true); return; }
  if (kind === 'mg') send({ type: 'tw_toggle_operate_mg', mg_id: struct.structure_id, unit_ids: ops });
  else send({ type: 'tw_toggle_operate_mortar', mortar_id: struct.structure_id, unit_ids: ops });
}
function getSelectedSoldier() {
  const uid = firstSelected();
  return uid ? ((tw()?.soldiers || []).find(s => s.unit_id === uid) || null) : null;
}
function getSelectedMg() {
  return selectedMg ? ((tw()?.machine_guns || []).find(m => m.structure_id === selectedMg) || null) : null;
}
function mortarAt(tile) {
  return (tw()?.mortars || []).find(m => m.tile[0] === tile[0] && m.tile[1] === tile[1] && m.hp > 0) || null;
}
function myMortarAt(tile) {
  const m = mortarAt(tile);
  return (m && m.owner === mySeat()) ? m : null;
}
function getSelectedMortar() {
  return selectedMortar ? ((tw()?.mortars || []).find(m => m.structure_id === selectedMortar) || null) : null;
}

function getSquad(squadId) {
  return (tw()?.squads || []).find(sq => sq.squad_id === squadId) || null;
}

function getSquadColor(color) {
  const map = {
    red: '#e03030', green: '#30c050', blue: '#3060d0',
    purple: '#9030c0', orange: '#e07820', white: '#d8d8d8',
    black: '#404048', gold: '#f0c030',
  };
  return map[color] || '#ffffff';
}

function spawnMovePing(tile) {
  if (tile) moveOrderPings.push({ x: tile[0], y: tile[1], age: 0 });
}

function selectSquad(squadId) {
  selectedSquad = (selectedSquad === squadId) ? null : squadId;
  render();
}

function disbandSquad(squadId) {
  send({ type: 'tw_disband_squad', squad_id: squadId });
  if (selectedSquad === squadId) selectedSquad = null;
  squadBoxes.delete(squadId);
  render();
}

function getFormationPositions(targetTile, shape, count, mapData) {
  const [tx, ty] = targetTile;
  const W = mapData.width, H = mapData.height;
  let raw = [];
  if (shape === 'horizontal') {
    const half = Math.floor((count - 1) / 2);
    for (let i = 0; i < count; i++) raw.push([tx - half + i, ty]);
  } else if (shape === 'vertical') {
    const half = Math.floor((count - 1) / 2);
    for (let i = 0; i < count; i++) raw.push([tx, ty - half + i]);
  } else {
    raw = [[tx, ty]];
  }
  // Clamp into bounds and de-duplicate so no two preview tiles overlap (mirrors backend).
  const used = new Set();
  const result = [];
  for (let [x, y] of raw) {
    let cx = Math.max(0, Math.min(W - 1, x)), cy = Math.max(0, Math.min(H - 1, y));
    if (used.has(`${cx},${cy}`)) [cx, cy] = nearestUnusedTile(cx, cy, used, W, H);
    used.add(`${cx},${cy}`);
    result.push([cx, cy]);
  }
  return result;
}

function nearestUnusedTile(sx, sy, used, W, H) {
  const seen = new Set([`${sx},${sy}`]);
  const queue = [[sx, sy]];
  while (queue.length) {
    const [x, y] = queue.shift();
    if (x >= 0 && x < W && y >= 0 && y < H && !used.has(`${x},${y}`)) return [x, y];
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy, k = `${nx},${ny}`;
      if (!seen.has(k) && nx >= 0 && nx < W && ny >= 0 && ny < H) { seen.add(k); queue.push([nx, ny]); }
    }
  }
  return [sx, sy];
}

// === SQUAD TACTICAL BOXES (Kill Box / Defend) ===

// Live alive soldier ids of a squad.
function squadSoldierIds(squadId) {
  const sq = getSquad(squadId);
  if (!sq) return [];
  return (sq.soldier_ids || []).filter(uid => (tw()?.soldiers || []).find(s => s.unit_id === uid));
}

// Defensive value of a tile: trenches rank highest (best cover), then high ground.
function defenseScore(x, y) {
  const tier = elevMap.get(`${x},${y}`);  // 0=trench, 2=hill, 3=mountain, undefined=ground
  if (tier === 0) return 1000 + 2;          // trench: best cover (with its low base elev)
  if (tier === 3) return 6;                 // mountain
  if (tier === 2) return 5;                 // hill
  return 4;                                 // ground
}

// Defend: spread the squad across the best-scoring ground inside the box, max-separated.
function computeDefendPositions(box, n) {
  const W = tw().map.width, H = tw().map.height;
  const x0 = Math.max(0, Math.min(box.x0, box.x1)), x1 = Math.min(W - 1, Math.max(box.x0, box.x1));
  const y0 = Math.max(0, Math.min(box.y0, box.y1)), y1 = Math.min(H - 1, Math.max(box.y0, box.y1));
  const tiles = [];
  for (let y = y0; y <= y1; y++)
    for (let x = x0; x <= x1; x++)
      tiles.push({ x, y, score: defenseScore(x, y) });
  tiles.sort((a, b) => b.score - a.score);
  // Greedy max-spread: prefer high score, but keep picks apart.
  const chosen = [];
  let minSpacing = Math.max(1, Math.floor(Math.min(x1 - x0, y1 - y0) / Math.max(1, n)));
  while (chosen.length < n && minSpacing >= 0) {
    for (const t of tiles) {
      if (chosen.length >= n) break;
      if (chosen.some(c => Math.max(Math.abs(c.x - t.x), Math.abs(c.y - t.y)) < minSpacing)) continue;
      if (chosen.some(c => c.x === t.x && c.y === t.y)) continue;
      chosen.push(t);
    }
    minSpacing--;
  }
  return chosen.slice(0, n).map(t => [t.x, t.y]);
}

// Kill Box: arrange the squad in an L on the two outer edges adjacent to the
// approach corner, standing a couple tiles back so their fire reaches into the box.
function computeKillBoxPositions(box, n) {
  const W = tw().map.width, H = tw().map.height;
  const minX = Math.min(box.x0, box.x1), maxX = Math.max(box.x0, box.x1);
  const minY = Math.min(box.y0, box.y1), maxY = Math.max(box.y0, box.y1);
  const cornerOnLeft = box.ax <= minX;
  const cornerOnTop = box.ay <= minY;
  const OFF = 2;  // tiles to stand back from the edge (outside the box)
  const edgeX = cornerOnLeft ? minX - OFF : maxX + OFF;  // x for the vertical arm
  const edgeY = cornerOnTop ? minY - OFF : maxY + OFF;   // y for the horizontal arm
  // Split: longer edge gets proportionally more soldiers.
  const wLen = maxX - minX + 1, hLen = maxY - minY + 1;
  let nHoriz = Math.round(n * wLen / (wLen + hLen));
  nHoriz = Math.max(0, Math.min(n, nHoriz));
  let nVert = n - nHoriz;
  if (n >= 2 && nHoriz === 0) { nHoriz = 1; nVert = n - 1; }
  if (n >= 2 && nVert === 0) { nVert = 1; nHoriz = n - 1; }
  const spread = (count, lo, hi) => {
    const out = [];
    if (count <= 0) return out;
    if (count === 1) { out.push(Math.round((lo + hi) / 2)); return out; }
    for (let i = 0; i < count; i++) out.push(Math.round(lo + (hi - lo) * i / (count - 1)));
    return out;
  };
  const raw = [];
  for (const px of spread(nHoriz, minX, maxX)) raw.push([px, edgeY]);   // horizontal arm
  for (const py of spread(nVert, minY, maxY)) raw.push([edgeX, py]);    // vertical arm
  const used = new Set();
  const result = [];
  for (let [x, y] of raw) {
    let cx = Math.max(0, Math.min(W - 1, x)), cy = Math.max(0, Math.min(H - 1, y));
    if (used.has(`${cx},${cy}`)) [cx, cy] = nearestUnusedTile(cx, cy, used, W, H);
    used.add(`${cx},${cy}`);
    result.push([cx, cy]);
  }
  return result;
}

// Compute and dispatch moves for a squad's tactical box.
function dispatchSquadBox(squadId) {
  const box = squadBoxes.get(squadId);
  if (!box) return;
  const ids = squadSoldierIds(squadId);
  if (!ids.length) return;
  const positions = box.kind === 'defend'
    ? computeDefendPositions(box, ids.length)
    : computeKillBoxPositions(box, ids.length);
  // Assign nearest soldier to nearest position (greedy) to minimise crossing.
  const soldiers = ids.map(uid => {
    const s = (tw().soldiers || []).find(s => s.unit_id === uid);
    return { uid, x: s.x, y: s.y };
  });
  const remaining = [...positions];
  for (const sol of soldiers) {
    if (!remaining.length) break;
    let bi = 0, bd = Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const d = Math.hypot(remaining[i][0] - sol.x, remaining[i][1] - sol.y);
      if (d < bd) { bd = d; bi = i; }
    }
    const tile = remaining.splice(bi, 1)[0];
    send({ type: 'tw_move_unit', unit_id: sol.uid, tile });
  }
  for (const p of positions) spawnMovePing(p);
}

// Canvas-space rectangle for a box (handles the player-2 vertical flip).
function boxCanvasRect(box) {
  const minX = Math.min(box.x0, box.x1), maxX = Math.max(box.x0, box.x1);
  const minY = Math.min(box.y0, box.y1), maxY = Math.max(box.y0, box.y1);
  const left = OX + minX * CELL;
  const right = OX + (maxX + 1) * CELL;
  const ya = tileTop(minY), yb = tileTop(maxY);
  const top = Math.min(ya, yb);
  const bottom = Math.max(ya, yb) + CELL;
  return { left, top, right, bottom };
}

// Hit-test a canvas point against own squad boxes. Returns {squadId, hit} or null.
function boxHitAt(cx, cy) {
  for (const [squadId, box] of squadBoxes) {
    const r = boxCanvasRect(box);
    // Delete X at the visual top-right corner.
    if (cx >= r.right - 18 && cx <= r.right && cy >= r.top && cy <= r.top + 18) {
      return { squadId, hit: 'x' };
    }
    // Resize grab near the opposite corner (x1,y1) tile centre.
    const rx = cpx(box.x1), ry = cpy(box.y1);
    if (Math.hypot(cx - rx, cy - ry) <= 12) {
      return { squadId, hit: 'resize' };
    }
  }
  return null;
}

// === MODE MANAGEMENT ===

function updateModeButtons() {
  const modes = ['select','move','dig','build','mortar','sandbag','wire','bunker','flare'];
  for (const m of modes) {
    const btn = el('mode-' + m);
    if (btn) btn.classList.toggle('active', mode === m);
  }
  applyBuildFlyout();
}

function applyBuildFlyout() {
  const fl = el('build-flyout');
  const tg = el('build-flyout-toggle');
  const inBuild = BUILD_MODES.has(mode);
  const open = buildFlyoutOpen || inBuild;
  if (fl) fl.classList.toggle('open', open);
  if (tg) {
    tg.classList.toggle('open', open);
    tg.classList.toggle('active', inBuild);
  }
}

function setMode(m) {
  if (mode === m) {
    mode = 'select';
    plan = [];
    pendingBuildTile = null; pendingBuildFacing = null; pendingMgDispatch = false;
    pendingMortarTile = null; pendingMortarTarget = null; pendingMortarDispatch = false;
    retargetMortarId = null;
    armedBoxKind = null;
    selectedSquad = null;
  } else {
    mode = m;
    if (m !== 'dig') plan = [];
    if (m !== 'build') { pendingBuildTile = null; pendingBuildFacing = null; pendingMgDispatch = false; }
    if (m !== 'mortar') { pendingMortarTile = null; pendingMortarTarget = null; pendingMortarDispatch = false; }
    if (m !== 'select' && m !== 'move') { armedBoxKind = null; }
    if (BUILD_MODES.has(m)) selectedUnits = new Set();
  }
  // Keep the build flyout open while a build mode is active; collapse otherwise.
  buildFlyoutOpen = BUILD_MODES.has(mode);
  updateModeButtons();
  updateModeLabel();
  if (mode === 'build') refreshBuildStatus();
}

function updateModeLabel() {
  const labels = {
    select: 'Select', move: 'Move',
    dig: 'Dig/Plan', build: 'Build MG', mortar: 'Build Mortar', sandbag: 'Build Sandbag', wire: 'Wire', bunker: 'Bunker', flare: 'Flare',
  };
  const e = el('mode-line');
  if (e) e.textContent = labels[mode] || 'Select / Move';
}

function clearPendingMgBuild() {
  pendingBuildTile = null;
  pendingBuildFacing = null;
  pendingMgDispatch = false;
  selectedUnits = new Set();
}

function clearPendingMortarBuild() {
  pendingMortarTile = null;
  pendingMortarTarget = null;
  pendingMortarDispatch = false;
  selectedUnits = new Set();
}

function reconcilePendingBuildState() {
  const data = tw();
  if (!data) return;
  if (pendingBuildTile) {
    const placedMg = (data.machine_guns || []).find(
      m => m.owner === mySeat() && m.tile[0] === pendingBuildTile[0] && m.tile[1] === pendingBuildTile[1]
    );
    if (placedMg) {
      clearPendingMgBuild();
      selectedMg = placedMg.structure_id;  // keep selected so Cancel can cancel the build
      setMode('select');
      setStatus('MG construction started — press C or click Cancel to abort.');
    }
  }
  if (pendingMortarTile) {
    const placedMortar = (data.mortars || []).find(
      m => m.owner === mySeat() && m.tile[0] === pendingMortarTile[0] && m.tile[1] === pendingMortarTile[1]
    );
    if (placedMortar) {
      clearPendingMortarBuild();
      selectedMortar = placedMortar.structure_id;  // keep selected so Cancel can cancel the build
      setMode('select');
      setStatus('Mortar construction started — press C or click Cancel to abort.');
    }
  }
}

function refreshBuildStatus() {
  if (mode !== 'build') return;
  if (pendingMgDispatch) {
    setStatus('Build MG — awaiting server response…');
    return;
  }
  if (!pendingBuildTile) {
    setStatus('Build MG — Step 1: click a tile to place the MG (ground, hill, or mountain).');
    return;
  }
  const needFacing = pendingBuildFacing === null;
  const needBuilder = selectedUnits.size < 1;
  if (needFacing && needBuilder) {
    setStatus('Build MG — Step 2: click to aim barrel direction, then click a soldier to assign as builder.');
  } else if (needFacing) {
    setStatus('Build MG — Click to aim the barrel direction.');
  } else if (needBuilder) {
    setStatus('Build MG — Click a soldier to assign as builder.');
  } else {
    setStatus('Sending build order…');
  }
}

function refreshMortarStatus() {
  if (mode !== 'mortar') return;
  if (pendingMortarDispatch) {
    setStatus('Build Mortar — awaiting server response…');
    return;
  }
  if (!pendingMortarTile) {
    setStatus('Build Mortar — Step 1: click a tile (all 8 neighbours must be same ground type).');
    return;
  }
  if (!pendingMortarTarget) {
    setStatus('Build Mortar — Step 2: click the target tile to aim at.');
    return;
  }
  const need = Math.max(0, 2 - selectedUnits.size);
  setStatus(need > 0
    ? `Build Mortar — Step 3: select ${need} more soldier${need > 1 ? 's' : ''} to build.`
    : 'Sending build order…');
}

// === KEYBOARD SHORTCUTS ===

document.addEventListener('keydown', (evt) => {
  if (evt.target.tagName === 'INPUT' || evt.target.tagName === 'TEXTAREA') return;
  const key = evt.key.toUpperCase();

  if (evt.key === 'Escape') {
    plan = [];
    pendingBuildTile = null; pendingBuildFacing = null; pendingMgDispatch = false;
    pendingMortarTile = null; pendingMortarTarget = null; pendingMortarDispatch = false;
    retargetMortarId = null;
    selectedUnits = new Set();
    selectedMg = null;
    setMode('select');
    render();
    return;
  }

  const shortcutMap = { '1':'select','2':'move','V':'move','D':'dig','B':'build','M':'mortar','G':'sandbag','W':'wire','U':'bunker','F':'flare' };
  if (shortcutMap[key]) {
    evt.preventDefault();
    setMode(shortcutMap[key]);
    render();
    return;
  }

  if (key === 'C') {
    evt.preventDefault();
    const smg = getSelectedMg();
    if (smg && !smg.built) {
      send({ type: 'tw_cancel_build_mg', mg_id: smg.structure_id });
      selectedMg = null;
    } else {
      const sm = getSelectedMortar();
      if (sm && !sm.built) {
        send({ type: 'tw_cancel_build_mortar', mortar_id: sm.structure_id });
        selectedMortar = null;
      } else {
        for (const uid of selectedUnits) send({ type: 'tw_cancel_task', unit_id: uid });
      }
    }
    render();
  }
});

// === CLICK HANDLER ===

board.addEventListener('click', (evt) => {
  if (selectBoxConsumedClick) { selectBoxConsumedClick = false; return; }
  if (!tw() || mySeat() === null) return;
  if (state.status !== 'active') return;
  const tile = tileFromEvent(evt);
  if (!tile) return;

  const myS = mySoldiersAt(tile);
  const myMg = myMgAt(tile);

  const myMortar = myMortarAt(tile);

  if (retargetMortarId !== null) {
    send({ type: 'tw_set_mortar_target', mortar_id: retargetMortarId, target: tile });
    retargetMortarId = null;
    setStatus('Mortar retarget requested.');
    render();
    return;
  }

  if (mode === 'select' || mode === 'move') {
    if (myS.length) {
      const uid = myS[0].unit_id;
      // If an unbuilt MG is selected, clicking a soldier resumes its construction.
      const selMg = getSelectedMg();
      if (selMg && !selMg.built) {
        send({ type: 'tw_resume_build_mg', mg_id: selMg.structure_id, unit_id: uid });
        selectedMg = null;
      } else {
        // Left-click own soldier: select (Ctrl toggles for multi-select)
        if (evt.ctrlKey) {
          if (selectedUnits.has(uid)) selectedUnits.delete(uid);
          else selectedUnits.add(uid);
        } else {
          selectedUnits = new Set([uid]);
        }
        selectedMg = null; selectedMortar = null; selectedSquad = null;
      }
    } else if (myMortar) {
      selectedMortar = myMortar.structure_id; selectedMg = null; selectedUnits = new Set();
      if (myMortar.built) {
        if (myMortar.ready && (myMortar.hold_fire ?? false)) {
          send({ type: 'tw_fire_mortar', mortar_id: myMortar.structure_id });
        } else {
          // Auto-crew with the nearest 2 available soldiers.
          crewStructure('mortar', myMortar, 2);
        }
      }
    } else if (myMg) {
      selectedMg = myMg.structure_id; selectedMortar = null; selectedUnits = new Set();
      if (myMg.built) {
        // Toggle crew: if already crewed, stand down; otherwise crew nearest soldier.
        if ((myMg.operators || []).length > 0) {
          send({ type: 'tw_toggle_operate_mg', mg_id: myMg.structure_id, unit_ids: [] });
        } else {
          crewStructure('mg', myMg, 1);
        }
      }
    } else if (selectedMg !== null || selectedMortar !== null) {
      // A structure was selected; clicking empty ground just deselects it (no move).
      selectedMg = null; selectedMortar = null;
    } else if (mode === 'move' && soldiersAt(tile).length === 0 && !tileHasEquipment(tile)) {
      if (selectedUnits.size === 1 && selectedSquad === null) {
        // Single selected soldier: direct move, ignore formation count/shape
        const [uid] = selectedUnits;
        send({ type: 'tw_move_unit', unit_id: uid, tile });
        selectedUnits = new Set();
      } else {
        // Formation move (multi-select, squad, or no selection)
        const payload = { type: 'tw_formation_move', tile, count: formationCount, formation: formationShape };
        if (selectedSquad !== null) {
          payload.squad_id = selectedSquad;
          selectedSquad = null;
        } else if (selectedUnits.size > 0) {
          payload.unit_ids = [...selectedUnits];
          selectedUnits = new Set();
        }
        send(payload);
      }
      spawnMovePing(tile);
    }
    // In pure select mode, clicking empty ground does nothing — no accidental moves.

  } else if (mode === 'dig') {
    if (myS.length) {
      // Click own soldier: select it; if a plan was traced, assign it immediately
      const uid = myS[0].unit_id;
      selectedUnits = new Set([uid]);
      if (plan.length) { send({ type: 'tw_assign_dig', unit_id: uid, plan: [...plan] }); plan = []; }
    } else {
      const uid = firstSelected();
      if (uid !== null && plan.length === 0) {
        // Soldier selected, no plan started: immediate single-tile dig
        send({ type: 'tw_assign_dig', unit_id: uid, plan: [tile] });
      } else {
        // Accumulate plan (no soldier yet, or plan already started)
        addToPlan(tile);
      }
    }

  } else if (mode === 'build') {
    const tryDispatch = () => {
      if (pendingBuildTile && pendingBuildFacing !== null && selectedUnits.size >= 1 && !pendingMgDispatch) {
        send({ type: 'tw_assign_build_mg', unit_ids: [...selectedUnits], tile: pendingBuildTile, facing: pendingBuildFacing });
        pendingMgDispatch = true;
      }
    };
    if (!pendingBuildTile) {
      // Step 1: place MG tile
      pendingBuildTile = tile;
    } else if (myS.length) {
      // Clicking a soldier: select as builder (replace any prior selection)
      const uid = myS[0].unit_id;
      if (selectedUnits.has(uid) && selectedUnits.size === 1) {
        selectedUnits.delete(uid); // deselect if clicking same soldier
      } else {
        selectedUnits = new Set([uid]);
      }
      // If facing not yet set, derive from click position relative to MG tile
      if (pendingBuildFacing === null) {
        const r = board.getBoundingClientRect();
        const cx = (evt.clientX - r.left) * (board.width / r.width);
        const cy = (evt.clientY - r.top) * (board.height / r.height);
        const dx = cx - cpx(pendingBuildTile[0]);
        const dy = cy - cpy(pendingBuildTile[1]);
        const gameDy = mySeat() === 1 ? -dy : dy;
        pendingBuildFacing = Math.atan2(gameDy, dx) * 180 / Math.PI;
      }
    } else {
      // Clicking an empty tile: set/update barrel facing direction
      const r = board.getBoundingClientRect();
      const cx = (evt.clientX - r.left) * (board.width / r.width);
      const cy = (evt.clientY - r.top) * (board.height / r.height);
      const dx = cx - cpx(pendingBuildTile[0]);
      const dy = cy - cpy(pendingBuildTile[1]);
      const gameDy = mySeat() === 1 ? -dy : dy;
      pendingBuildFacing = Math.atan2(gameDy, dx) * 180 / Math.PI;
    }
    tryDispatch();
    refreshBuildStatus();

  } else if (mode === 'mortar') {
    const tryDispatchMortar = () => {
      if (pendingMortarTile && pendingMortarTarget && selectedUnits.size >= 2 && !pendingMortarDispatch) {
        send({ type: 'tw_assign_build_mortar', unit_ids: [...selectedUnits], tile: pendingMortarTile, target: pendingMortarTarget });
        pendingMortarDispatch = true;
      }
    };
    if (!pendingMortarTile) {
      pendingMortarTile = tile;
    } else if (!pendingMortarTarget) {
      pendingMortarTarget = tile;
      tryDispatchMortar();
    } else if (myS.length) {
      const uid = myS[0].unit_id;
      if (selectedUnits.has(uid)) selectedUnits.delete(uid);
      else {
        if (selectedUnits.size >= 2) selectedUnits = new Set();
        selectedUnits.add(uid);
      }
      tryDispatchMortar();
    }
    refreshMortarStatus();

  } else if (mode === 'sandbag') {
    const inBuildPhase = (tw()?.build_phase_remaining || 0) > 0;
    if (myS.length) {
      selectedUnits = new Set([myS[0].unit_id]);
    } else if (inBuildPhase && firstSelected() === null) {
      // Build-phase free instant placement (no soldier required)
      const sbRem = tw()?.build_sandbags_remaining ?? 0;
      if (sbRem <= 0) {
        setStatus('No build-phase sandbags remaining.', true);
      } else {
        send({ type: 'tw_build_phase_place_sandbag', tile });
      }
    } else {
      const uid = firstSelected();
      if (uid !== null) {
        const sol = (tw().soldiers || []).find(s => s.unit_id === uid);
        if (sol) {
          const dx = Math.abs(tile[0] - sol.tile[0]);
          const dy = Math.abs(tile[1] - sol.tile[1]);
          if (Math.max(dx, dy) === 1) {
            send({ type: 'tw_assign_build_sandbag', unit_id: uid, tile });
          } else {
            setStatus('Sandbag must be placed on a tile adjacent to the soldier.', true);
          }
        }
      }
    }

  } else if (mode === 'flare') {
    const fr = tw()?.flares_remaining;
    const remaining = fr ? (fr[String(mySeat())] ?? 0) : 0;
    if (!myOfficer()) {
      setStatus('No living officer available to fire flares.', true);
    } else if (remaining > 0) {
      send({ type: 'tw_fire_flare', tile });
      setStatus('Flare request sent…');
    } else {
      setStatus('No flares remaining.', true);
    }

  } else if (mode === 'wire') {
    const inBuildPhase = (tw()?.build_phase_remaining || 0) > 0;
    if (myS.length) {
      selectedUnits = new Set([myS[0].unit_id]);
    } else if (inBuildPhase && firstSelected() === null) {
      // Build-phase free instant placement
      const wireRem = tw()?.build_wire_remaining ?? 0;
      const trenchSet = new Set((tw().map?.trenches || []).map(t => `${t[0]},${t[1]}`));
      const wireSet = new Set((tw().barbed_wire || []).filter(w => w.hp > 0).map(w => `${w.tile[0]},${w.tile[1]}`));
      const wireStructSet = new Set([
        ...(tw().machine_guns || []).filter(m => m.hp > 0).map(m => `${m.tile[0]},${m.tile[1]}`),
        ...(tw().mortars || []).filter(m => m.hp > 0).map(m => `${m.tile[0]},${m.tile[1]}`),
        ...(tw().sandbags || []).filter(s => s.hp > 0).map(s => `${s.tile[0]},${s.tile[1]}`),
      ]);
      const wkey = `${tile[0]},${tile[1]}`;
      if (wireRem <= 0) {
        setStatus('No build-phase wire remaining.', true);
      } else if (trenchSet.has(wkey) || wireSet.has(wkey) || wireStructSet.has(wkey)) {
        setStatus('Cannot place wire on an occupied or trench tile.', true);
      } else {
        send({ type: 'tw_build_phase_place_wire', tile });
      }
    } else {
      const uid = firstSelected();
      if (uid !== null) {
        const sol = (tw().soldiers || []).find(s => s.unit_id === uid);
        if (sol) {
          const dx = Math.abs(tile[0] - sol.tile[0]);
          const dy = Math.abs(tile[1] - sol.tile[1]);
          const trenchSet = new Set((tw().map?.trenches || []).map(t => `${t[0]},${t[1]}`));
          const wireSet = new Set((tw().barbed_wire || []).filter(w => w.hp > 0).map(w => `${w.tile[0]},${w.tile[1]}`));
          const wireStructSet = new Set([
            ...(tw().machine_guns || []).filter(m => m.hp > 0).map(m => `${m.tile[0]},${m.tile[1]}`),
            ...(tw().mortars || []).filter(m => m.hp > 0).map(m => `${m.tile[0]},${m.tile[1]}`),
            ...(tw().sandbags || []).filter(s => s.hp > 0).map(s => `${s.tile[0]},${s.tile[1]}`),
          ]);
          const wkey = `${tile[0]},${tile[1]}`;
          if (Math.max(dx, dy) === 1 && !trenchSet.has(wkey) && !wireSet.has(wkey) && !wireStructSet.has(wkey)) {
            send({ type: 'tw_assign_wire', unit_id: uid, tile });
          } else {
            setStatus('Wire must be placed on an adjacent non-trench tile.', true);
          }
        }
      }
    }

  } else if (mode === 'bunker') {
    const inBuildPhase = (tw()?.build_phase_remaining || 0) > 0;
    if (!inBuildPhase) {
      setStatus('Bunkers can only be placed during the build phase.', true);
    } else {
      const bunkerRem = tw()?.build_bunkers_remaining ?? 0;
      const trenchSet = new Set((tw().map?.trenches || []).map(t => `${t[0]},${t[1]}`));
      const sbSet = new Set((tw().sandbags || []).filter(s => s.hp > 0).map(s => `${s.tile[0]},${s.tile[1]}`));
      const bkey = `${tile[0]},${tile[1]}`;
      if (bunkerRem <= 0) {
        setStatus('No build-phase bunkers remaining.', true);
      } else if (!trenchSet.has(bkey)) {
        setStatus('Bunkers can only be placed on trench tiles.', true);
      } else if (sbSet.has(bkey)) {
        setStatus('Cannot place a bunker on a sandbag.', true);
      } else {
        send({ type: 'tw_build_phase_place_bunker', tile });
      }
    }
  }

  render();
});

board.addEventListener('contextmenu', (evt) => {
  evt.preventDefault();
  if (!tw() || mySeat() === null || state.status !== 'active') return;
  const tile = tileFromEvent(evt);
  if (!tile) return;

  const myS = mySoldiersAt(tile);

  // Right-click own soldier: cancel their task immediately (any mode)
  if (myS.length) {
    send({ type: 'tw_cancel_task', unit_id: myS[0].unit_id });
    setStatus('Task cancelled.');
    render();
    return;
  }

  const myMg = myMgAt(tile);
  if (myMg && myMg.built && (myMg.operators || []).length > 0) {
    // Right-click a crewed MG: stand the crew down.
    send({ type: 'tw_toggle_operate_mg', mg_id: myMg.structure_id, unit_ids: [] });
    setStatus('MG crew stood down.');
    render();
    return;
  }
  const myMortar = myMortarAt(tile);
  if (myMortar && myMortar.built) {
    retargetMortarId = myMortar.structure_id;
    setStatus('Mortar retarget: click a new target tile.');
    render();
  }
});

// Adds a tile to the plan, walking tile-by-tile from the last entry so the
// chain is always 4-connected (handles fast drags that skip tiles).
function addToPlan(tile) {
  const last = plan[plan.length - 1];
  if (!last) { plan.push(tile); return; }
  if (last[0] === tile[0] && last[1] === tile[1]) return;
  // Walk from last to tile: horizontal first, then vertical
  let cx = last[0], cy = last[1];
  const tx = tile[0], ty = tile[1];
  while (cx !== tx || cy !== ty) {
    if (cx !== tx) cx += (tx > cx ? 1 : -1);
    else cy += (ty > cy ? 1 : -1);
    const prev = plan[plan.length - 1];
    if (prev[0] === cx && prev[1] === cy) continue;
    plan.push([cx, cy]);
  }
}

let _selectBoxStart = null; // {cx, cy} canvas coords where drag began
let selectBoxConsumedClick = false; // suppress click when a drag was completed

board.addEventListener('mousedown', (evt) => {
  if (evt.button !== 0) return;
  const r0 = board.getBoundingClientRect();
  const mcx = (evt.clientX - r0.left) * (board.width / r0.width);
  const mcy = (evt.clientY - r0.top) * (board.height / r0.height);

  // Arming a new tactical box: this drag defines it (approach corner = start tile).
  if (armedBoxKind && selectedSquad !== null) {
    const tile = tileFromEvent(evt);
    if (tile) {
      boxInteraction = { squadId: selectedSquad, kind: armedBoxKind, mode: 'create', ax: tile[0], ay: tile[1] };
      squadBoxes.set(selectedSquad, { kind: armedBoxKind, x0: tile[0], y0: tile[1], x1: tile[0], y1: tile[1], ax: tile[0], ay: tile[1] });
      armedBoxKind = null;
      render();
    }
    return;
  }
  // Clicking an existing box's delete-X or resize handle.
  const hit = boxHitAt(mcx, mcy);
  if (hit) {
    if (hit.hit === 'x') {
      squadBoxes.delete(hit.squadId);
      setStatus('Box removed.');
      render();
      return;
    }
    if (hit.hit === 'resize') {
      if (!hasCommand()) { setStatus('No officer — squad orders unavailable.', true); return; }
      boxInteraction = { squadId: hit.squadId, kind: squadBoxes.get(hit.squadId).kind, mode: 'resize' };
      return;
    }
  }

  if (mode === 'dig') { planDragging = true; return; }
  if (mode === 'select' || mode === 'move') {
    // Start a potential box-select drag only if clicking empty ground.
    const tile = tileFromEvent(evt);
    const myS = tile ? mySoldiersAt(tile) : [];
    const hasMg = tile ? !!myMgAt(tile) : false;
    const hasMortar = tile ? !!myMortarAt(tile) : false;
    if (!myS.length && !hasMg && !hasMortar) {
      const r = board.getBoundingClientRect();
      const cx = (evt.clientX - r.left) * (board.width / r.width);
      const cy = (evt.clientY - r.top) * (board.height / r.height);
      _selectBoxStart = { cx, cy };
    }
  }
});

board.addEventListener('mouseup', (evt) => {
  planDragging = false;
  if (boxInteraction) {
    const squadId = boxInteraction.squadId;
    boxInteraction = null;
    selectBoxConsumedClick = true;  // don't let the click fall through to a move/select
    dispatchSquadBox(squadId);
    render();
    return;
  }
  if (selectBox !== null) {
    // Finalise box-select: pick all own soldiers whose tile falls inside the box.
    const x0 = Math.min(selectBox.x0, selectBox.x1);
    const x1 = Math.max(selectBox.x0, selectBox.x1);
    const y0 = Math.min(selectBox.y0, selectBox.y1);
    const y1 = Math.max(selectBox.y0, selectBox.y1);
    const picked = new Set();
    for (const s of tw()?.soldiers || []) {
      if (s.owner !== mySeat() || s.hp <= 0) continue;
      const dp = soldierDisplayPos.get(s.unit_id) || { x: s.x, y: s.y };
      const px = cpx(dp.x), py = cpy(dp.y);
      if (px >= x0 && px <= x1 && py >= y0 && py <= y1) picked.add(s.unit_id);
    }
    if (picked.size > 0) {
      selectedUnits = picked;
      selectedMg = null; selectedMortar = null; selectedSquad = null;
      selectBoxConsumedClick = true;
    }
    selectBox = null;
    _selectBoxStart = null;
    render();
  } else {
    _selectBoxStart = null;
  }
});

board.addEventListener('mousemove', (evt) => {
  const r = board.getBoundingClientRect();
  mouseCanvas.x = (evt.clientX - r.left) * (board.width / r.width);
  mouseCanvas.y = (evt.clientY - r.top) * (board.height / r.height);
  // Dragging a tactical box (create or resize): the moving corner follows the cursor.
  if (boxInteraction) {
    const tile = tileFromEvent(evt);
    if (tile) {
      const box = squadBoxes.get(boxInteraction.squadId);
      if (box) { box.x1 = tile[0]; box.y1 = tile[1]; render(); }
    }
    return;
  }
  if (mode === 'dig' && planDragging) {
    const tile = tileFromEvent(evt);
    if (tile) { addToPlan(tile); render(); }
  }
  if ((mode === 'select' || mode === 'move') && _selectBoxStart) {
    const cx = mouseCanvas.x, cy = mouseCanvas.y;
    const dist = Math.sqrt((cx - _selectBoxStart.cx) ** 2 + (cy - _selectBoxStart.cy) ** 2);
    if (dist > 6) {
      selectBox = { x0: _selectBoxStart.cx, y0: _selectBoxStart.cy, x1: cx, y1: cy };
    } else if (selectBox) {
      selectBox.x1 = cx; selectBox.y1 = cy;
    }
    render();
  } else {
    if (mode === 'build' && pendingBuildTile && pendingBuildFacing === null) render();
    if (mode === 'mortar' && pendingMortarTile && !pendingMortarTarget) render();
    if (retargetMortarId !== null) render();
    if (mode === 'flare') render();
    if (mode === 'select' || mode === 'move') render();
  }
});

// === DRAW ===

function cpx(gx) { return OX + gx * CELL + CELL / 2; }
// For player 2 the board is flipped vertically so their units appear at the bottom.
function flipY(gy) {
  return (mySeat() === 1 && tw()) ? (tw().map.height - 1 - gy) : gy;
}
function cpy(gy) { return OY + flipY(gy) * CELL + CELL / 2; }
// Top-left pixel y of a tile (integer or float game-y).
function tileTop(gy) { return OY + Math.floor(flipY(gy)) * CELL; }

// Deterministic per-tile brightness noise: returns a small offset in [-1, 1].
function tileNoise(x, y) {
  let h = ((x * 374761393 + y * 668265263) | 0);
  h = ((h ^ (h >>> 13)) * 1274126177) | 0;
  h = h ^ (h >>> 16);
  return ((h & 0xFFFF) / 65535.0) * 2.0 - 1.0;
}

// Apply ±magnitude noise to a hex color string and return adjusted rgb string.
function noisedColor(hexR, hexG, hexB, magnitude, x, y) {
  const n = tileNoise(x, y);
  const d = Math.round(n * magnitude);
  return `rgb(${Math.max(0,Math.min(255,hexR+d))},${Math.max(0,Math.min(255,hexG+d))},${Math.max(0,Math.min(255,hexB+d))})`;
}

function hasTrenchLos(trenchSet, x0, y0, x1, y1) {
  const dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
  const sx = x1 >= x0 ? 1 : -1, sy = y1 >= y0 ? 1 : -1;
  let err = dx - dy, cx = x0, cy = y0;
  while (true) {
    if (cx === x1 && cy === y1) return true;
    if ((cx !== x0 || cy !== y0) && !trenchSet.has(`${cx},${cy}`)) return false;
    const e2 = 2 * err;
    if (e2 > -dy) { err -= dy; cx += sx; }
    if (e2 < dx) { err += dx; cy += sy; }
  }
}

function drawRangeCircle(cx, cy, radius, color) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 4]);
  ctx.globalAlpha = 0.55;
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

function rebuildElevMap(mapData) {
  elevMap = new Map();
  for (const t of mapData.mountains || []) elevMap.set(`${t[0]},${t[1]}`, 3);
  for (const t of mapData.hills || []) elevMap.set(`${t[0]},${t[1]}`, 2);
  for (const t of mapData.trenches || []) elevMap.set(`${t[0]},${t[1]}`, 0);
}

function spawnSmoke(gx, gy) {
  const count = 7 + Math.floor(Math.random() * 5);
  for (let i = 0; i < count; i++) {
    const angle = Math.random() * Math.PI * 2;
    const spd = 0.15 + Math.random() * 0.35;
    smokeParticles.push({
      x: gx + (Math.random() - 0.5) * 0.6,
      y: gy + (Math.random() - 0.5) * 0.6,
      vx: Math.cos(angle) * spd * 0.4 + 0.18,  // eastward bias
      vy: Math.sin(angle) * spd - 0.28,
      alpha: 0.55 + Math.random() * 0.3,
      age: 0,
      maxAge: 2.8 + Math.random() * 2.2,
      r: 0.14 + Math.random() * 0.22,
    });
  }
}

function spawnAirburstPop(gx, gy) {
  const count = 4 + Math.floor(Math.random() * 3);
  for (let i = 0; i < count; i++) {
    const angle = Math.random() * Math.PI * 2;
    const spd = 0.08 + Math.random() * 0.18;
    smokeParticles.push({
      x: gx + (Math.random() - 0.5) * 0.5,
      y: gy + (Math.random() - 0.5) * 0.5,
      vx: Math.cos(angle) * spd * 0.4 + 0.14,
      vy: Math.sin(angle) * spd * 0.4 - 0.12,
      alpha: 0.4 + Math.random() * 0.25,
      age: 0,
      maxAge: 1.6 + Math.random() * 1.0,
      r: 0.09 + Math.random() * 0.13,
    });
  }
}

function spawnAirburstTileSmoke(gx, gy) {
  const count = 1 + Math.floor(Math.random() * 2);
  for (let i = 0; i < count; i++) {
    smokeParticles.push({
      x: gx + (Math.random() - 0.5) * 0.6,
      y: gy + (Math.random() - 0.5) * 0.6,
      vx: 0.08 + Math.random() * 0.14,
      vy: -0.04 + (Math.random() - 0.5) * 0.08,
      alpha: 0.28 + Math.random() * 0.18,
      age: 0,
      maxAge: 2.2 + Math.random() * 1.4,
      r: 0.05 + Math.random() * 0.09,
    });
  }
}

function spawnDirtPuff(gx, gy) {
  const count = 4 + Math.floor(Math.random() * 3);
  for (let i = 0; i < count; i++) {
    const angle = -Math.PI / 2 + (Math.random() - 0.5) * Math.PI * 0.8;  // upward cone
    const spd = 0.14 + Math.random() * 0.20;
    impactParticles.push({
      x: gx + (Math.random() - 0.5) * 0.15,
      y: gy + (Math.random() - 0.5) * 0.15,
      vx: Math.cos(angle) * spd,
      vy: Math.sin(angle) * spd,  // negative = upward
      alpha: 0.60 + Math.random() * 0.25,
      r: 0.05 + Math.random() * 0.07,
      color: '185,160,115',  // dusty tan
      age: 0,
      maxAge: 0.22 + Math.random() * 0.18,
    });
  }
}

function spawnKillSpark(gx, gy) {
  const count = 5 + Math.floor(Math.random() * 4);
  for (let i = 0; i < count; i++) {
    const angle = Math.random() * Math.PI * 2;
    const spd = 0.12 + Math.random() * 0.22;
    impactParticles.push({
      x: gx,
      y: gy,
      vx: Math.cos(angle) * spd,
      vy: Math.sin(angle) * spd - 0.12,
      alpha: 0.9 + Math.random() * 0.1,
      r: 0.05 + Math.random() * 0.08,
      color: '255,80,30',
      age: 0,
      maxAge: 0.25 + Math.random() * 0.2,
    });
  }
}

function flareScatterRadius(targetTile) {
  const data = tw();
  if (!data || !targetTile) return 0;
  const srcX = data.map.width / 2;
  const srcY = mySeat() === 0 ? data.map.height - 1 : 0;
  const dist = Math.hypot(targetTile[0] - srcX, targetTile[1] - srcY);
  return 3 + Math.max(0, Math.floor(Math.max(0, dist - 10) / 5));
}

function drawBuildPhaseOverlay(data) {
  const seat = mySeat();
  const remaining = Math.max(0, Number(data.build_phase_remaining || 0));
  if (seat === null || remaining <= 0) return;
  const mid = Math.floor(data.map.height / 2);
  const isOffLimitsY = seat === 0
    ? (gy) => gy < mid
    : (gy) => gy >= mid;

  for (let y = 0; y < data.map.height; y++) {
    if (!isOffLimitsY(y)) continue;
    for (let x = 0; x < data.map.width; x++) {
      const left = OX + x * CELL;
      const top = tileTop(y);
      ctx.fillStyle = 'rgba(190, 20, 20, 0.11)';
      ctx.fillRect(left, top, CELL - 1, CELL - 1);
      ctx.strokeStyle = 'rgba(240, 50, 50, 0.38)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(left + 1, top + 1);
      ctx.lineTo(left + CELL - 2, top + CELL - 2);
      ctx.moveTo(left + CELL - 2, top + 1);
      ctx.lineTo(left + 1, top + CELL - 2);
      ctx.stroke();
    }
  }

  const seconds = Math.ceil(remaining);
  const mm = Math.floor(seconds / 60);
  const ss = String(seconds % 60).padStart(2, '0');
  const timerLabel = `BUILD PHASE ${mm}:${ss}`;
  const sbRem = data.build_sandbags_remaining ?? 0;
  const wireRem = data.build_wire_remaining ?? 0;
  const bunkerRem = data.build_bunkers_remaining ?? 0;
  const resourceLabel = `Sandbags: ${sbRem}   Wire: ${wireRem}   Bunkers: ${bunkerRem}`;
  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  const textX = board.width / 2;
  const textY = OY + 6;
  ctx.font = 'bold 18px system-ui';
  const timerWidth = ctx.measureText(timerLabel).width;
  ctx.font = '13px system-ui';
  const resWidth = ctx.measureText(resourceLabel).width;
  const boxWidth = Math.max(timerWidth, resWidth) + 20;
  ctx.fillStyle = 'rgba(30, 0, 0, 0.85)';
  ctx.fillRect(textX - boxWidth / 2, textY - 2, boxWidth, 46);
  ctx.font = 'bold 18px system-ui';
  ctx.fillStyle = '#ff4a4a';
  ctx.fillText(timerLabel, textX, textY);
  ctx.font = '13px system-ui';
  ctx.fillStyle = '#ffaa66';
  ctx.fillText(resourceLabel, textX, textY + 24);
  ctx.restore();
}

function draw() {
  const data = tw();
  if (!data) return;

  board.width  = OX * 2 + data.map.width  * CELL;
  board.height = OY * 2 + data.map.height * CELL;
  applyBoardZoom();

  ctx.fillStyle = '#1a1d20';
  ctx.fillRect(0, 0, board.width, board.height);

  // Ground tiles — slight olive shift from original #445a48, with subtle per-tile noise
  for (let y = 0; y < data.map.height; y++) {
    for (let x = 0; x < data.map.width; x++) {
      ctx.fillStyle = noisedColor(78, 93, 62, 5, x, y);  // base #4e5d3e, midpoint between old/new
      ctx.fillRect(OX + x * CELL, tileTop(y), CELL - 1, CELL - 1);
    }
  }

  // Mountain tiles — slight warm shift from original #8c8c8c, subtle noise
  for (const t of data.map.mountains || []) {
    const tty = tileTop(t[1]);
    ctx.fillStyle = noisedColor(130, 124, 115, 6, t[0], t[1]);  // base #827c73, midpoint
    ctx.fillRect(OX + t[0] * CELL, tty, CELL - 1, CELL - 1);
    ctx.strokeStyle = 'rgba(190,180,165,0.25)';
    ctx.lineWidth = 0.5;
    ctx.strokeRect(OX + t[0] * CELL + 0.5, tty + 0.5, CELL - 2, CELL - 2);
    ctx.lineWidth = 1;
  }

  // Hill tiles — slight olive shift from original #68736a, subtle noise
  for (const t of data.map.hills || []) {
    const tty = tileTop(t[1]);
    ctx.fillStyle = noisedColor(104, 112, 86, 5, t[0], t[1]);  // base #687056, midpoint
    ctx.fillRect(OX + t[0] * CELL, tty, CELL - 1, CELL - 1);
    ctx.strokeStyle = 'rgba(110,120,90,0.28)';
    ctx.lineWidth = 0.5;
    ctx.strokeRect(OX + t[0] * CELL + 0.5, tty + 0.5, CELL - 2, CELL - 2);
    ctx.lineWidth = 1;
  }

  // Trench tiles — connected channel style
  {
    const trenchConnSet = new Set((data.map.trenches || []).map(t => `${t[0]},${t[1]}`));
    const CH = 10;  // channel width in pixels
    for (const t of data.map.trenches) {
      const [tx, ty] = t;
      const tlx = OX + tx * CELL;
      const tty = tileTop(ty);
      const sz = CELL - 1;
      const N = trenchConnSet.has(`${tx},${ty - 1}`);
      const S = trenchConnSet.has(`${tx},${ty + 1}`);
      const E = trenchConnSet.has(`${tx + 1},${ty}`);
      const W = trenchConnSet.has(`${tx - 1},${ty}`);

      // Dirt rim — midpoint between old trench (#2e2a24) and new warm earth
      ctx.fillStyle = noisedColor(50, 44, 34, 3, tx, ty);  // #322c22
      ctx.fillRect(tlx, tty, sz, sz);

      // Channel cut: cross-shaped dug shadow
      const cOff = Math.round((sz - CH) / 2);
      ctx.fillStyle = '#201c14';  // slightly lighter than before

      ctx.fillRect(tlx + cOff, tty + cOff, CH, CH);
      if (N) ctx.fillRect(tlx + cOff, tty, CH, cOff + 1);
      if (S) ctx.fillRect(tlx + cOff, tty + cOff + CH - 1, CH, sz - (cOff + CH - 1));
      if (E) ctx.fillRect(tlx + cOff + CH - 1, tty + cOff, sz - (cOff + CH - 1), CH);
      if (W) ctx.fillRect(tlx, tty + cOff, cOff + 1, CH);

      // Subtle rim highlight
      ctx.strokeStyle = 'rgba(140,115,80,0.18)';
      ctx.lineWidth = 0.5;
      if (!N) {
        ctx.beginPath(); ctx.moveTo(tlx, tty + 0.5); ctx.lineTo(tlx + sz, tty + 0.5); ctx.stroke();
      }
      if (!W) {
        ctx.beginPath(); ctx.moveTo(tlx + 0.5, tty); ctx.lineTo(tlx + 0.5, tty + sz); ctx.stroke();
      }
    }
  }

  // Elevation shading: north-side shadow where a tile is south of a higher neighbour.
  // Tiers: 0=trench, 1=ground, 2=hill, 3=mountain.
  {
    const isFlipped = mySeat() === 1;
    for (let y = 1; y < data.map.height; y++) {
      for (let x = 0; x < data.map.width; x++) {
        const northTier = elevMap.get(`${x},${y - 1}`) ?? 1;
        const curTier   = elevMap.get(`${x},${y}`)     ?? 1;
        const td = northTier - curTier;
        if (td <= 0) continue;
        const alpha = 0.16 + 0.12 * (td - 1);
        const shH   = 3 + td;
        const tlx   = OX + x * CELL;
        const tly   = tileTop(y);
        const topEdge = isFlipped ? tly + CELL - 1 - shH : tly;
        ctx.fillStyle = `rgba(0,0,0,${alpha})`;
        ctx.fillRect(tlx, topEdge, CELL - 1, shH);
        // crisp shadow edge line
        ctx.strokeStyle = `rgba(0,0,0,${Math.min(0.45, alpha + 0.08)})`;
        ctx.lineWidth = 1;
        ctx.beginPath();
        const lineY = isFlipped ? topEdge + shH - 0.5 : topEdge + 0.5;
        ctx.moveTo(tlx, lineY);
        ctx.lineTo(tlx + CELL - 1, lineY);
        ctx.stroke();
      }
    }
  }

  // Slight global darken so muzzle flashes and flares feel more illuminating
  ctx.fillStyle = 'rgba(0,0,0,0.06)';
  ctx.fillRect(OX, OY, data.map.width * CELL, data.map.height * CELL);

  drawBuildPhaseOverlay(data);

  // Draw bunkers: dark grey brick texture with ownership dot and crack degradation
  const bunkerTileSet = new Set((data.bunkers || []).map(b => `${b.tile[0]},${b.tile[1]}`));
  for (const b of data.bunkers || []) {
    const [bx, by] = b.tile;
    const tlx = OX + bx * CELL;
    const tly = tileTop(by);
    const hp = b.hp ?? 3;
    const sz = CELL - 1; // 23px drawable area

    // Dark mortar-joint background
    ctx.fillStyle = '#484850';
    ctx.fillRect(tlx, tly, sz, sz);

    // Staggered brick rows (10×5 bricks, 1px mortar joints)
    const bW = 10, bH = 5, mW = 1, mH = 1, rowH = bH + mH;
    ctx.fillStyle = hp === 3 ? '#8a8a92' : hp === 2 ? '#7a7a82' : '#6a6a72';
    for (let row = 0; row * rowH < sz; row++) {
      const ry = tly + row * rowH;
      const drawH = Math.min(bH, tly + sz - ry);
      if (drawH <= 0) break;
      const offset = (row & 1) ? Math.floor((bW + mW) / 2) : 0;
      for (let x = -offset; x < sz; x += bW + mW) {
        const clipX = Math.max(tlx + x, tlx);
        const clipW = Math.min(tlx + x + bW, tlx + sz) - clipX;
        if (clipW <= 0) continue;
        ctx.fillRect(clipX, ry, clipW, drawH);
      }
    }

    // Cracks for damaged bunkers
    if (hp < 3) {
      ctx.strokeStyle = 'rgba(15,15,15,0.8)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(tlx + 3, tly + 2); ctx.lineTo(tlx + sz / 2, tly + sz / 2);
      if (hp === 1) {
        ctx.moveTo(tlx + sz - 3, tly + 3); ctx.lineTo(tlx + sz / 2, tly + sz / 2);
        ctx.moveTo(tlx + sz / 2, tly + sz / 2); ctx.lineTo(tlx + sz / 2 - 2, tly + sz - 3);
      }
      ctx.stroke();
    }

    // Small corner dot indicating side ownership
    ctx.fillStyle = b.owner === 0 ? 'rgba(220,60,60,0.9)' : 'rgba(60,110,220,0.9)';
    ctx.fillRect(tlx + 1, tly + 1, 3, 3);
  }

  // Active dig plan overlays from assigned soldier tasks
  for (const s of data.soldiers || []) {
    if (!s.task || s.task.type !== 'dig' || !s.task.plan || !s.task.plan.length) continue;
    const digPlan = s.task.plan;
    const isOwn = s.owner === mySeat();
    const lineColor = isOwn ? 'rgba(244,200,78,0.65)' : 'rgba(255,110,110,0.65)';
    const fillColor = isOwn ? 'rgba(244,200,78,0.12)' : 'rgba(255,110,110,0.10)';
    ctx.strokeStyle = lineColor;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    digPlan.forEach((t, i) => {
      if (i === 0) ctx.moveTo(cpx(t[0]), cpy(t[1]));
      else ctx.lineTo(cpx(t[0]), cpy(t[1]));
    });
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.lineWidth = 1;
    ctx.fillStyle = fillColor;
    for (const t of digPlan) ctx.fillRect(OX + t[0] * CELL, tileTop(t[1]), CELL - 1, CELL - 1);
  }

  // Local (unsent) dig plan overlay
  if (plan.length) {
    ctx.strokeStyle = '#f4c84e';
    ctx.lineWidth = 2;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    plan.forEach((t, i) => {
      if (i === 0) ctx.moveTo(cpx(t[0]), cpy(t[1]));
      else ctx.lineTo(cpx(t[0]), cpy(t[1]));
    });
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.lineWidth = 1;
    ctx.fillStyle = 'rgba(244,200,78,0.18)';
    for (const t of plan) ctx.fillRect(OX + t[0] * CELL, tileTop(t[1]), CELL - 1, CELL - 1);
    ctx.strokeStyle = '#f4c84e';
    ctx.strokeRect(OX + plan[0][0] * CELL + 1, tileTop(plan[0][1]) + 1, CELL - 3, CELL - 3);
  }

  if (mode === 'build' && pendingBuildTile) {
    const [bx, by] = pendingBuildTile;
    ctx.strokeStyle = '#f4c84e';
    ctx.setLineDash([5, 3]);
    ctx.lineWidth = 2;
    ctx.strokeRect(OX + bx * CELL + 1, tileTop(by) + 1, CELL - 2, CELL - 2);
    ctx.setLineDash([]);
    ctx.lineWidth = 1;
  }

  // Sandbag mode: highlight valid adjacent tiles for selected soldier
  if (mode === 'sandbag') {
    const selSb = getSelectedSoldier();
    if (selSb) {
      const structSet = new Set([
        ...(tw().machine_guns || []).filter(m => m.hp > 0).map(m => `${m.tile[0]},${m.tile[1]}`),
        ...(tw().mortars || []).filter(m => m.hp > 0).map(m => `${m.tile[0]},${m.tile[1]}`),
        ...(tw().sandbags || []).filter(s => s.hp > 0).map(s => `${s.tile[0]},${s.tile[1]}`),
        ...(tw().bunkers || []).filter(b => b.hp > 0).map(b => `${b.tile[0]},${b.tile[1]}`),
      ]);
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          if (dx === 0 && dy === 0) continue;
          const ax = selSb.tile[0] + dx, ay = selSb.tile[1] + dy;
          if (ax < 0 || ay < 0 || ax >= tw().map.width || ay >= tw().map.height) continue;
          if (structSet.has(`${ax},${ay}`)) continue;
          ctx.fillStyle = 'rgba(180,160,100,0.30)';
          ctx.fillRect(OX + ax * CELL, tileTop(ay), CELL - 1, CELL - 1);
          ctx.strokeStyle = 'rgba(200,180,120,0.7)';
          ctx.lineWidth = 1;
          ctx.strokeRect(OX + ax * CELL + 0.5, tileTop(ay) + 0.5, CELL - 2, CELL - 2);
        }
      }
    }
  }

  // Range circle for selected soldier
  const selSoldier = getSelectedSoldier();
  if (selSoldier) {
    const effectiveRange = selSoldier.range ?? RIFLE_RANGE;  // grenadiers use rifle range (10/12/14)
    const _sdp = soldierDisplayPos.get(selSoldier.unit_id) || { x: selSoldier.x, y: selSoldier.y };
    drawRangeCircle(cpx(_sdp.x), cpy(_sdp.y), effectiveRange * CELL, 'rgba(255,180,50,0.8)');
  }

  // Build mode: pending MG arc preview (before MG sprites so it renders underneath)
  if (mode === 'build' && pendingBuildTile) {
    const [bx, by] = pendingBuildTile;
    const pmcx = cpx(bx), pmcy = cpy(by);
    let previewAngle;
    if (pendingBuildFacing !== null) {
      const gr = pendingBuildFacing * Math.PI / 180;
      previewAngle = mySeat() === 1 ? -gr : gr;
    } else {
      const dx = mouseCanvas.x - pmcx;
      const dy = mouseCanvas.y - pmcy;
      previewAngle = Math.atan2(dy, dx);
    }
    const arcHalfRad = 45 * Math.PI / 180;
    // MG range depends on elevation of build tile
    const bElevTier = elevMap.get(`${bx},${by}`) ?? 1;
    const mgBuildRange = bElevTier === 3 ? 20 : (bElevTier === 2 ? 17 : 15);
    // Arc sector fill
    const previewFill = mySeat() === 0 ? 'rgba(139,21,21,0.22)' : 'rgba(26,63,160,0.22)';
    ctx.beginPath();
    ctx.moveTo(pmcx, pmcy);
    ctx.arc(pmcx, pmcy, CELL * 1.8, previewAngle - arcHalfRad, previewAngle + arcHalfRad);
    ctx.closePath();
    ctx.fillStyle = previewFill;
    ctx.fill();
    // Range arc
    ctx.strokeStyle = pendingBuildFacing !== null ? '#f4c84e' : 'rgba(255,200,80,0.45)';
    ctx.lineWidth = 1;
    ctx.setLineDash([5, 3]);
    ctx.beginPath();
    ctx.arc(pmcx, pmcy, mgBuildRange * CELL, previewAngle - arcHalfRad, previewAngle + arcHalfRad);
    ctx.stroke();
    ctx.setLineDash([]);
    // Tile highlight
    ctx.strokeStyle = pendingBuildFacing !== null ? '#f4c84e' : 'rgba(255,200,80,0.7)';
    ctx.lineWidth = 2;
    ctx.strokeRect(OX + bx * CELL + 1, tileTop(by) + 1, CELL - 2, CELL - 2);
    // Barrel preview
    ctx.strokeStyle = '#ddd';
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(pmcx, pmcy);
    ctx.lineTo(pmcx + Math.cos(previewAngle) * CELL * 0.6, pmcy + Math.sin(previewAngle) * CELL * 0.6);
    ctx.stroke();
    ctx.lineCap = 'butt';
    ctx.lineWidth = 1;
  }

  // Machine guns
  for (const mg of data.machine_guns || []) {
    const [mx, my] = mg.tile;
    const tlx = OX + mx * CELL, tly = tileTop(my);
    const mcx = cpx(mx), mcy = cpy(my);

    const gameAngleRad = (mg.facing || 0) * Math.PI / 180;
    const va = mySeat() === 1 ? -gameAngleRad : gameAngleRad;
    // Arc/range uses the fixed arc_center so they don't animate during a turn
    const arcCenterRad = ((mg.arc_center !== undefined ? mg.arc_center : mg.facing) || 0) * Math.PI / 180;
    const arcVa = mySeat() === 1 ? -arcCenterRad : arcCenterRad;
    const arcHalfRad = (mg.arc_half || 45) * Math.PI / 180;
    const teamFill = mg.owner === 0 ? '#8b1515' : '#1a3fa0';
    const teamAlpha = mg.owner === 0 ? 'rgba(139,21,21,0.22)' : 'rgba(26,63,160,0.22)';
    const isSelected = mg.structure_id === selectedMg;

    if (mg.built) {
      // Firing arc sector (pinned to arc_center)
      ctx.beginPath();
      ctx.moveTo(mcx, mcy);
      ctx.arc(mcx, mcy, CELL * 1.8, arcVa - arcHalfRad, arcVa + arcHalfRad);
      ctx.closePath();
      ctx.fillStyle = teamAlpha;
      ctx.fill();
      ctx.strokeStyle = teamFill;
      ctx.lineWidth = 0.5;
      ctx.globalAlpha = 0.5;
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.lineWidth = 1;

      if (isSelected) {
        // Range arc for selected MG (pinned to arc_center, elevation-dependent)
        const mgEffRange = (mg.effective_range ?? MG_RANGE);
        ctx.strokeStyle = 'rgba(255,220,80,0.75)';
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.arc(mcx, mcy, mgEffRange * CELL, arcVa - arcHalfRad, arcVa + arcHalfRad);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.lineWidth = 1;
      }
    }

    // Circle body
    ctx.beginPath();
    ctx.arc(mcx, mcy, CELL * 0.38, 0, Math.PI * 2);
    ctx.fillStyle = teamFill;
    ctx.fill();
    ctx.strokeStyle = '#ccc';
    ctx.lineWidth = 1;
    ctx.stroke();

    // Barrel line (tracks actual facing, not arc_center)
    const barrelLen = CELL * 0.55;
    ctx.strokeStyle = '#e0e0e0';
    ctx.lineWidth = 2.5;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(mcx, mcy);
    ctx.lineTo(mcx + Math.cos(va) * barrelLen, mcy + Math.sin(va) * barrelLen);
    ctx.stroke();
    ctx.lineCap = 'butt';
    ctx.lineWidth = 1;

    // Selection ring
    if (isSelected) {
      ctx.strokeStyle = '#7aff9e';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(mcx, mcy, CELL * 0.46, 0, Math.PI * 2);
      ctx.stroke();
      ctx.lineWidth = 1;
    }

    // HP bar
    const hpFrac = mg.hp / (mg.hp_max || 20);
    ctx.fillStyle = '#111';
    ctx.fillRect(tlx + 2, tly - 5, CELL - 4, 3);
    ctx.fillStyle = hpFrac > 0.5 ? '#65e06f' : (hpFrac > 0.25 ? '#f4c84e' : '#e04040');
    ctx.fillRect(tlx + 2, tly - 5, (CELL - 4) * hpFrac, 3);

    if (!mg.built) {
      const bpFrac = mg.build_progress / (mg.build_required || 30);
      ctx.fillStyle = '#222';
      ctx.fillRect(tlx + 2, tly + CELL + 1, CELL - 4, 3);
      ctx.fillStyle = '#f4c84e';
      ctx.fillRect(tlx + 2, tly + CELL + 1, (CELL - 4) * bpFrac, 3);
      ctx.fillStyle = 'rgba(244,200,78,0.85)';
      ctx.font = '8px system-ui';
      ctx.textAlign = 'center';
      ctx.fillText('BUILD', mcx, tly + CELL - 2);
      ctx.textAlign = 'left';
    }

    if (mg.built && mg.operators && mg.operators.length) {
      ctx.fillStyle = '#7aff9e';
      ctx.font = 'bold 9px system-ui';
      ctx.textAlign = 'right';
      ctx.fillText(`\xd7${mg.operators.length}`, tlx + CELL - 2, tly + CELL - 2);
      ctx.textAlign = 'left';
    }
  }

  // Sandbags
  for (const sb of data.sandbags || []) {
    const [sx, sy] = sb.tile;
    const tlx = OX + sx * CELL, tly = tileTop(sy);
    const hitsReceived = (sb.hp_max || 3) - sb.hp;

    // Body — darkens with damage
    const bodyColors = ['#8d7f66', '#7a6e57', '#68604c'];
    ctx.fillStyle = bodyColors[Math.min(hitsReceived, 2)];
    ctx.fillRect(tlx + 3, tly + 5, CELL - 6, CELL - 10);
    ctx.strokeStyle = '#c9bca5';
    ctx.lineWidth = 1;
    ctx.strokeRect(tlx + 3, tly + 5, CELL - 6, CELL - 10);

    // Damage spots — seeded by structure_id for stable positions
    if (hitsReceived > 0) {
      const spotCounts = [0, 3, 7];
      const numSpots = spotCounts[Math.min(hitsReceived, 2)];
      const seed = sb.structure_id;
      const rng = (n) => (((seed * 1664525 + n * 22695477 + 1013904223) >>> 0) & 0x7fff) / 0x7fff;
      ctx.fillStyle = 'rgba(20,10,0,0.55)';
      for (let i = 0; i < numSpots; i++) {
        const px = tlx + 5 + rng(i * 3) * (CELL - 10);
        const py = tly + 7 + rng(i * 3 + 1) * (CELL - 14);
        const r = 1 + rng(i * 3 + 2);
        ctx.fillRect(px, py, r, r);
      }
    }

    // Build progress bar (only while under construction)
    if (!sb.built) {
      const bpFrac = sb.build_progress / (sb.build_required || 5);
      ctx.fillStyle = '#1a1a1a';
      ctx.fillRect(tlx + 2, tly + CELL + 1, CELL - 4, 3);
      ctx.fillStyle = '#d8c07a';
      ctx.fillRect(tlx + 2, tly + CELL + 1, (CELL - 4) * bpFrac, 3);
    }
  }

  // Barbed wire
  for (const w of data.barbed_wire || []) {
    const [wx, wy] = w.tile;
    const tlx = OX + wx * CELL, tly = tileTop(wy);
    const alpha = w.built ? 1.0 : 0.35 + 0.55 * (w.build_progress / (w.build_required || 2));
    const seed = w.structure_id;
    const rng = (n) => (((seed * 1664525 + n * 22695477 + 1013904223) >>> 0) & 0x7fff) / 0x7fff;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = '#4e4e4e';
    ctx.lineWidth = 1.5;
    ctx.lineCap = 'round';
    for (let i = 0; i < 4; i++) {
      const x0 = tlx + 2 + rng(i * 8 + 0) * (CELL - 4);
      const y0 = tly + 2 + rng(i * 8 + 1) * (CELL - 4);
      const x1 = tlx + 2 + rng(i * 8 + 2) * (CELL - 4);
      const y1 = tly + 2 + rng(i * 8 + 3) * (CELL - 4);
      const cx1 = tlx + 2 + rng(i * 8 + 4) * (CELL - 4);
      const cy1 = tly + 2 + rng(i * 8 + 5) * (CELL - 4);
      const cx2 = tlx + 2 + rng(i * 8 + 6) * (CELL - 4);
      const cy2 = tly + 2 + rng(i * 8 + 7) * (CELL - 4);
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.bezierCurveTo(cx1, cy1, cx2, cy2, x1, y1);
      ctx.stroke();
    }
    ctx.fillStyle = '#3a3a3a';
    for (let i = 0; i < 5; i++) {
      const bx = tlx + 3 + rng(i * 2 + 33) * (CELL - 6);
      const by = tly + 3 + rng(i * 2 + 34) * (CELL - 6);
      ctx.beginPath();
      ctx.arc(bx, by, 1, 0, Math.PI * 2);
      ctx.fill();
    }
    if (!w.built) {
      ctx.globalAlpha = 1;
      ctx.fillStyle = '#111';
      ctx.fillRect(tlx + 2, tly + CELL + 1, CELL - 4, 3);
      ctx.fillStyle = '#888';
      ctx.fillRect(tlx + 2, tly + CELL + 1, (CELL - 4) * (w.build_progress / (w.build_required || 2)), 3);
    }
    ctx.restore();
  }

  // Wire mode: highlight valid adjacent non-trench tiles for selected soldier
  if (mode === 'wire') {
    const selW = getSelectedSoldier();
    if (selW) {
      const trenchSet = new Set((tw().map?.trenches || []).map(t => `${t[0]},${t[1]}`));
      const blockedSet = new Set([
        ...(tw().barbed_wire || []).filter(w => w.hp > 0).map(w => `${w.tile[0]},${w.tile[1]}`),
        ...(tw().sandbags || []).filter(s => s.hp > 0).map(s => `${s.tile[0]},${s.tile[1]}`),
        ...(tw().machine_guns || []).filter(m => m.hp > 0).map(m => `${m.tile[0]},${m.tile[1]}`),
        ...(tw().mortars || []).filter(m => m.hp > 0).map(m => `${m.tile[0]},${m.tile[1]}`),
      ]);
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          if (dx === 0 && dy === 0) continue;
          const ax = selW.tile[0] + dx, ay = selW.tile[1] + dy;
          if (ax < 0 || ay < 0 || ax >= tw().map.width || ay >= tw().map.height) continue;
          const wk = `${ax},${ay}`;
          if (trenchSet.has(wk) || blockedSet.has(wk)) continue;
          ctx.fillStyle = 'rgba(100,100,100,0.28)';
          ctx.fillRect(OX + ax * CELL, tileTop(ay), CELL - 1, CELL - 1);
          ctx.strokeStyle = 'rgba(160,160,160,0.7)';
          ctx.lineWidth = 1;
          ctx.strokeRect(OX + ax * CELL + 0.5, tileTop(ay) + 0.5, CELL - 2, CELL - 2);
        }
      }
    }
  }

  // Soldiers
  for (const s of data.soldiers || []) {
    const dp = soldierDisplayPos.get(s.unit_id) || { x: s.x, y: s.y };
    const scx = cpx(dp.x);
    const scy = cpy(dp.y);
    const onBunker = bunkerTileSet.has(`${Math.round(s.x)},${Math.round(s.y)}`);
    if (onBunker) ctx.globalAlpha = 0.5;

    // Firing flash halo
    if (s.rifle_cooldown > 1.5) {
      ctx.fillStyle = 'rgba(255,255,180,0.4)';
      ctx.beginPath();
      ctx.arc(scx, scy, 10, 0, Math.PI * 2);
      ctx.fill();
    }

    // Body (officers are star-shaped; grenadiers and riflemen are circles)
    if (s.is_officer) {
      ctx.fillStyle = s.owner === 0 ? '#f5e642' : '#22d4c8';
      ctx.beginPath();
      const pts = 5, outerR = 7, innerR = 3.5;
      for (let i = 0; i < pts * 2; i++) {
        const angle = (i * Math.PI / pts) - Math.PI / 2;
        const r = i % 2 === 0 ? outerR : innerR;
        if (i === 0) ctx.moveTo(scx + r * Math.cos(angle), scy + r * Math.sin(angle));
        else ctx.lineTo(scx + r * Math.cos(angle), scy + r * Math.sin(angle));
      }
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = s.owner === 0 ? '#a89a00' : '#0a8a82';
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.lineWidth = 1;
      // Circle border in the same fill color as the star
      ctx.beginPath();
      ctx.arc(scx, scy, 9, 0, Math.PI * 2);
      ctx.strokeStyle = s.owner === 0 ? '#f5e642' : '#22d4c8';
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.lineWidth = 1;
    } else {
      ctx.fillStyle = s.owner === 0 ? '#e83030' : '#3d6cdf';
      ctx.beginPath();
      ctx.arc(scx, scy, 6, 0, Math.PI * 2);
      ctx.fill();
      if (s.is_grenadier) {
        // Diagonal slash to distinguish grenadiers from riflemen
        ctx.save();
        ctx.strokeStyle = 'rgba(255,255,255,0.88)';
        ctx.lineWidth = 1.8;
        ctx.beginPath();
        ctx.moveTo(scx - 3.5, scy + 3.5);
        ctx.lineTo(scx + 3.5, scy - 3.5);
        ctx.stroke();
        ctx.restore();
      }
    }

    // Thin dashed path preview for moving soldiers.
    if (s.owner === mySeat() && s.path && s.path.length) {
      ctx.strokeStyle = 'rgba(255,255,255,0.9)';
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(scx, scy);
      for (const p of s.path) ctx.lineTo(cpx(p[0]), cpy(p[1]));
      ctx.stroke();
      ctx.setLineDash([]);
    }
    // Queued waypoints: fainter chain continuing from path end
    if (s.owner === mySeat()) {
      const queue = pendingWaypoints.get(s.unit_id);
      if (queue && queue.length) {
        const last = s.path && s.path.length ? s.path[s.path.length - 1] : s.tile;
        ctx.strokeStyle = 'rgba(255,255,255,0.4)';
        ctx.lineWidth = 1;
        ctx.setLineDash([2, 5]);
        ctx.beginPath();
        ctx.moveTo(cpx(last[0]), cpy(last[1]));
        for (const wp of queue) ctx.lineTo(cpx(wp[0]), cpy(wp[1]));
        ctx.stroke();
        ctx.setLineDash([]);
        for (const wp of queue) {
          ctx.fillStyle = 'rgba(255,255,255,0.4)';
          ctx.beginPath();
          ctx.arc(cpx(wp[0]), cpy(wp[1]), 2, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }

    // Selection box
    if (selectedUnits.has(s.unit_id)) {
      ctx.strokeStyle = '#ffd45a';
      ctx.lineWidth = 2;
      ctx.strokeRect(OX + s.tile[0] * CELL + 1, tileTop(s.tile[1]) + 1, CELL - 2, CELL - 2);
      ctx.lineWidth = 1;
    }

    // Blocked indicator
    if (s.blocked) {
      ctx.fillStyle = 'rgba(255,80,80,0.9)';
      ctx.font = 'bold 9px system-ui';
      ctx.textAlign = 'center';
      ctx.fillText('!', scx, scy - 9);
      ctx.textAlign = 'left';
    }

    // Dig progress bar on target tile
    if (s.task && s.task.type === 'dig' && s.task.target) {
      const [tx, ty] = s.task.target;
      const prog = Math.max(0, Math.min(1, (s.task.progress || 0) / (data.rules.dig_seconds_per_tile || 5)));
      ctx.fillStyle = '#000';
      ctx.fillRect(OX + tx * CELL + 2, tileTop(ty) + CELL - 5, CELL - 4, 3);
      ctx.fillStyle = '#f4c84e';
      ctx.fillRect(OX + tx * CELL + 2, tileTop(ty) + CELL - 5, (CELL - 4) * prog, 3);
    }

    // Task / combat-state label
    {
      let lbl = null;
      if (s.combat_halt) {
        lbl = '■';  // halted to engage open enemy
      } else if (s.task) {
        const taskLabels = { dig: 'DIG', build_mg: 'BLD', operate_mg: 'CREW', move: '→' };
        lbl = taskLabels[s.task.type] || null;
      }
      if (lbl) {
        ctx.fillStyle = s.combat_halt ? 'rgba(255,80,80,0.95)' : 'rgba(255,220,80,0.95)';
        ctx.font = '7px system-ui';
        ctx.textAlign = 'center';
        ctx.fillText(lbl, scx, scy - 9);
        ctx.textAlign = 'left';
      }
    }

    // Name label
    if (s.name) {
      ctx.fillStyle = s.owner === mySeat() ? 'rgba(220,255,220,0.92)' : 'rgba(255,210,210,0.92)';
      ctx.font = '5px system-ui';
      ctx.textAlign = 'center';
      ctx.fillText(s.name, scx, scy + 14);
      ctx.textAlign = 'left';
    }
    if (onBunker) ctx.globalAlpha = 1.0;
  }

  // Squad color dots on soldiers (drawn after all soldiers so dots appear on top)
  const squadMap = new Map((data.squads || []).map(sq => [sq.squad_id, sq]));
  for (const s of data.soldiers || []) {
    if (s.squad_id === null || s.squad_id === undefined) continue;
    const squad = squadMap.get(s.squad_id);
    if (!squad) continue;
    const _dp = soldierDisplayPos.get(s.unit_id) || { x: s.x, y: s.y };
    const scx = cpx(_dp.x);
    const scy = cpy(_dp.y);
    const color = getSquadColor(squad.color);
    ctx.beginPath();
    ctx.arc(scx + 7, scy - 7, 3.5, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.7)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.lineWidth = 1;
  }

  // Formation move preview (Move mode, hovering ground)
  if (mode === 'move' && tw()) {
    const hoverTile = tileFromCanvas(mouseCanvas.x, mouseCanvas.y);
    const overEquip = hoverTile && (soldiersAt(hoverTile).length > 0 || tileHasEquipment(hoverTile));
    // Only preview when the click would actually issue a move (not over a unit/structure).
    if (hoverTile && !overEquip && selectedMg === null && selectedMortar === null) {
      let previewCount = formationCount;
      if (selectedSquad !== null) {
        const sq = getSquad(selectedSquad);
        if (sq) previewCount = sq.soldier_ids.filter(uid => (tw().soldiers || []).find(s => s.unit_id === uid && s.hp > 0)).length;
      } else if (selectedUnits.size > 0) {
        previewCount = selectedUnits.size;
      }
      const fPositions = getFormationPositions(hoverTile, formationShape, previewCount, tw().map);
      ctx.save();
      ctx.fillStyle = 'rgba(100, 210, 255, 0.22)';
      ctx.strokeStyle = 'rgba(100, 210, 255, 0.8)';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([3, 3]);
      for (const [px, py] of fPositions) {
        const tlx = OX + px * CELL;
        const tly = tileTop(py);
        ctx.fillRect(tlx, tly, CELL - 1, CELL - 1);
        ctx.strokeRect(tlx + 0.5, tly + 0.5, CELL - 2, CELL - 2);
      }
      ctx.setLineDash([]);
      ctx.restore();
    }
  }

  // Mortars – retarget preview: snap to hovered tile, show line + crosshair + scatter ring
  if (retargetMortarId !== null) {
    const retargetMortar = (data.mortars || []).find(m => m.structure_id === retargetMortarId && m.owner === mySeat());
    if (retargetMortar) {
      const hoverTile = tileFromCanvas(mouseCanvas.x, mouseCanvas.y);
      const tcx = hoverTile ? cpx(hoverTile[0]) : mouseCanvas.x;
      const tcy = hoverTile ? cpy(hoverTile[1]) : mouseCanvas.y;
      const mcx = cpx(retargetMortar.tile[0]);
      const mcy = cpy(retargetMortar.tile[1]);
      const dTiles = Math.hypot(tcx - mcx, tcy - mcy) / CELL;
      const previewScatterR = 2 + Math.max(0, Math.floor(Math.max(0, dTiles - 10) / 5));
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = 'rgba(244,160,32,0.7)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(mcx, mcy); ctx.lineTo(tcx, tcy);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.moveTo(tcx - CELL * 0.6, tcy); ctx.lineTo(tcx + CELL * 0.6, tcy);
      ctx.moveTo(tcx, tcy - CELL * 0.6); ctx.lineTo(tcx, tcy + CELL * 0.6);
      ctx.stroke();
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = 'rgba(244,160,32,0.4)';
      ctx.beginPath();
      ctx.arc(tcx, tcy, previewScatterR * CELL, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.lineWidth = 1;
    }
  }

  if (mode === 'mortar') {
    if (pendingMortarTile) {
      const [bx, by] = pendingMortarTile;
      ctx.strokeStyle = '#f4a020';
      ctx.setLineDash([5, 3]);
      ctx.lineWidth = 2;
      ctx.strokeRect(OX + bx * CELL + 1, tileTop(by) + 1, CELL - 2, CELL - 2);
      ctx.setLineDash([]);
      ctx.lineWidth = 1;
    }
    if (pendingMortarTarget) {
      const [bx2, by2] = pendingMortarTile;
      const [tx, ty] = pendingMortarTarget;
      const tcx = cpx(tx), tcy = cpy(ty);
      const buildDist = Math.hypot(tx - bx2, ty - by2);
      const buildScatterR = 2 + Math.max(0, Math.floor(Math.max(0, buildDist - 10) / 5));
      ctx.strokeStyle = '#f4a020';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(tcx - CELL * 0.6, tcy); ctx.lineTo(tcx + CELL * 0.6, tcy);
      ctx.moveTo(tcx, tcy - CELL * 0.6); ctx.lineTo(tcx, tcy + CELL * 0.6);
      ctx.stroke();
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = 'rgba(244,160,32,0.5)';
      ctx.beginPath();
      ctx.arc(tcx, tcy, buildScatterR * CELL, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.lineWidth = 1;
    } else if (pendingMortarTile) {
      // Preview: scatter circle follows mouse
      const [bx, by] = pendingMortarTile;
      const dx = mouseCanvas.x - cpx(bx), dy = mouseCanvas.y - cpy(by);
      const dPixels = Math.hypot(dx, dy);
      if (dPixels > CELL * 0.5) {
        const previewScatterR = 2 + Math.max(0, Math.floor(Math.max(0, dPixels / CELL - 10) / 5));
        ctx.setLineDash([4, 4]);
        ctx.strokeStyle = 'rgba(244,160,32,0.35)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(mouseCanvas.x, mouseCanvas.y, previewScatterR * CELL, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }
  }

  for (const mortar of data.mortars || []) {
    const [mx, my] = mortar.tile;
    const tlx = OX + mx * CELL, tly = tileTop(my);
    const mcx = cpx(mx), mcy = cpy(my);
    const isSelected = mortar.structure_id === selectedMortar;
    const teamFill = mortar.owner === 0 ? '#8b1515' : '#1a3fa0';

    // Show target crosshair + scatter ring
    if (mortar.target && mortar.built && (isSelected || mortar.owner === mySeat())) {
      const [ttx, tty] = mortar.target;
      const tcx = cpx(ttx), tcy = cpy(tty);
      ctx.strokeStyle = 'rgba(244,160,32,0.6)';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(mcx, mcy); ctx.lineTo(tcx, tcy);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.moveTo(tcx - CELL * 0.5, tcy); ctx.lineTo(tcx + CELL * 0.5, tcy);
      ctx.moveTo(tcx, tcy - CELL * 0.5); ctx.lineTo(tcx, tcy + CELL * 0.5);
      ctx.stroke();
      if (isSelected) {
        const tgtDist = Math.hypot(ttx - mx, tty - my);
        const tgtScatterR = 2 + Math.max(0, Math.floor(Math.max(0, tgtDist - 10) / 5));
        ctx.strokeStyle = 'rgba(244,160,32,0.35)';
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.arc(tcx, tcy, tgtScatterR * CELL, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      ctx.lineWidth = 1;
    }

    // Square body
    ctx.fillStyle = teamFill;
    ctx.fillRect(tlx + 3, tly + 3, CELL - 6, CELL - 6);
    ctx.strokeStyle = '#ccc';
    ctx.lineWidth = 1;
    ctx.strokeRect(tlx + 3, tly + 3, CELL - 6, CELL - 6);
    // Inner circle (barrel)
    ctx.beginPath();
    ctx.arc(mcx, mcy, CELL * 0.2, 0, Math.PI * 2);
    ctx.fillStyle = '#333';
    ctx.fill();
    ctx.strokeStyle = '#aaa';
    ctx.stroke();

    // Ready indicator
    if (mortar.built && mortar.ready) {
      ctx.strokeStyle = '#f4a020';
      ctx.lineWidth = 2;
      ctx.strokeRect(tlx + 2, tly + 2, CELL - 4, CELL - 4);
      ctx.lineWidth = 1;
    }
    // Selection ring
    if (isSelected) {
      ctx.strokeStyle = '#7aff9e';
      ctx.lineWidth = 2;
      ctx.strokeRect(tlx + 1, tly + 1, CELL - 2, CELL - 2);
      ctx.lineWidth = 1;
    }

    // HP bar
    const hpFrac = mortar.hp / (mortar.hp_max || 10);
    ctx.fillStyle = '#111';
    ctx.fillRect(tlx + 2, tly - 5, CELL - 4, 3);
    ctx.fillStyle = hpFrac > 0.5 ? '#65e06f' : (hpFrac > 0.25 ? '#f4c84e' : '#e04040');
    ctx.fillRect(tlx + 2, tly - 5, (CELL - 4) * hpFrac, 3);

    if (!mortar.built) {
      const bpFrac = mortar.build_progress / (mortar.build_required || 60);
      ctx.fillStyle = '#222';
      ctx.fillRect(tlx + 2, tly + CELL + 1, CELL - 4, 3);
      ctx.fillStyle = '#f4a020';
      ctx.fillRect(tlx + 2, tly + CELL + 1, (CELL - 4) * bpFrac, 3);
      ctx.fillStyle = 'rgba(244,160,32,0.85)';
      ctx.font = '8px system-ui';
      ctx.textAlign = 'center';
      ctx.fillText('BUILD', mcx, tly + CELL - 2);
      ctx.textAlign = 'left';
    } else if (!mortar.ready) {
      const cdFrac = 1 - mortar.cooldown / 15;
      ctx.fillStyle = '#222';
      ctx.fillRect(tlx + 2, tly + CELL + 1, CELL - 4, 3);
      ctx.fillStyle = '#f4a020';
      ctx.fillRect(tlx + 2, tly + CELL + 1, (CELL - 4) * cdFrac, 3);
    }
    if (mortar.built && mortar.operators && mortar.operators.length) {
      ctx.fillStyle = '#7aff9e';
      ctx.font = 'bold 9px system-ui';
      ctx.textAlign = 'right';
      ctx.fillText(`\xd7${mortar.operators.length}`, tlx + CELL - 2, tly + CELL - 2);
      ctx.textAlign = 'left';
    }
  }

  // Mortar shells (lobbed arc) — positions dead-reckoned between server updates
  {
    const elapsed = (performance.now() - lastStateTime) / 1000;
    for (const ms of data.mortar_shells || []) {
      const ddx = ms.target[0] - ms.x, ddy = ms.target[1] - ms.y;
      const nd = Math.hypot(ddx, ddy);
      const advance = nd > 0 ? Math.min(nd, 5.0 * elapsed) : 0;
      const ex = ms.x + (nd > 0 ? (ddx / nd) * advance : 0);
      const ey = ms.y + (nd > 0 ? (ddy / nd) * advance : 0);
      const totalDist = Math.hypot(ms.target[0] - ms.sx, ms.target[1] - ms.sy);
      const traveledDist = Math.hypot(ex - ms.sx, ey - ms.sy);
      const progress = totalDist > 0 ? Math.min(1, traveledDist / totalDist) : 0;

      if (ms.round_type === 'airburst') {
        const popKey = `${ms.sx},${ms.sy},${ms.target[0]},${ms.target[1]}`;
        // Server is authoritative: if popped flag is set, stop rendering.
        if (ms.popped) continue;
        // Client-side fallback: hide and spawn smoke once dead-reckoned progress ≥ 75%
        // (covers the brief window before the server state confirms the pop).
        if (progress >= 0.75) {
          if (!poppedAirburstShells.has(popKey)) {
            poppedAirburstShells.add(popKey);
            const pop75x = ms.sx + (ms.target[0] - ms.sx) * 0.75;
            const pop75y = ms.sy + (ms.target[1] - ms.sy) * 0.75;
            spawnAirburstPop(pop75x, pop75y);
          }
          continue;
        }
      }

      const arcHeight = Math.sin(progress * Math.PI);
      const radius = 2 + arcHeight * 5;
      const alpha = 0.5 + arcHeight * 0.5;
      const sx = cpx(ex), sy = cpy(ey);
      ctx.globalAlpha = 0.3;
      ctx.fillStyle = '#333';
      ctx.beginPath();
      ctx.arc(sx, sy, 2, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = alpha;
      ctx.fillStyle = ms.round_type === 'smoke' ? '#c8c8c8' : (ms.owner === 0 ? '#e05020' : '#5050e0');
      ctx.beginPath();
      ctx.arc(sx, sy - arcHeight * CELL * 0.8, radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;

      // Pre-impact telegraph: shrinking crosshair at target tile when shell > 40% of way
      if (progress > 0.40) {
        const impactAlpha = Math.min(1, (progress - 0.40) / 0.3) * 0.85;
        const shrink = 1 - progress;  // shrinks to 0 at impact
        const tcx = cpx(ms.target[0]), tcy = cpy(ms.target[1]);
        const impR = Math.max(2, CELL * 0.55 * shrink);
        ctx.save();
        ctx.globalAlpha = impactAlpha;
        ctx.strokeStyle = ms.owner === 0 ? '#ff6040' : '#6080ff';
        ctx.lineWidth = 1.5;
        const armLen = impR * 1.3;
        ctx.beginPath();
        ctx.moveTo(tcx - armLen, tcy); ctx.lineTo(tcx + armLen, tcy);
        ctx.moveTo(tcx, tcy - armLen); ctx.lineTo(tcx, tcy + armLen);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(tcx, tcy, impR, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }
    }
  }

  // Grenade shells — dead-reckoned with pre-impact telegraph
  {
    const elapsed = (performance.now() - lastStateTime) / 1000;
    for (const gs of data.grenade_shells || []) {
      const ddx = gs.target[0] - gs.x, ddy = gs.target[1] - gs.y;
      const nd = Math.hypot(ddx, ddy);
      const advance = nd > 0 ? Math.min(nd, 5.0 * elapsed) : 0;
      const ex = gs.x + (nd > 0 ? (ddx / nd) * advance : 0);
      const ey = gs.y + (nd > 0 ? (ddy / nd) * advance : 0);
      const gTotalDist = Math.hypot(gs.target[0] - gs.sx, gs.target[1] - gs.sy);
      const gProgress = gTotalDist > 0 ? Math.min(1, Math.hypot(ex - gs.sx, ey - gs.sy) / gTotalDist) : 0;
      const gx = cpx(ex), gy = cpy(ey);
      ctx.fillStyle = '#9ad26d';
      ctx.beginPath();
      ctx.arc(gx, gy, 3, 0, Math.PI * 2);
      ctx.fill();

      // Pre-impact indicator at target tile when grenade > 50% of way
      if (gProgress > 0.50) {
        const impAlpha = Math.min(1, (gProgress - 0.5) / 0.25) * 0.75;
        const shrink = 1 - gProgress;
        const tcx = cpx(gs.target[0]), tcy = cpy(gs.target[1]);
        const impR = Math.max(1.5, CELL * 0.4 * shrink);
        ctx.save();
        ctx.globalAlpha = impAlpha;
        ctx.strokeStyle = '#c8f060';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(tcx, tcy, impR, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }
    }
  }

  // Flare shells — illumination glow + projectile dot, dead-reckoned
  {
    const elapsed = (performance.now() - lastStateTime) / 1000;
    for (const fs of data.flare_shells || []) {
      const ddx = fs.target[0] - fs.x, ddy = fs.target[1] - fs.y;
      const nd = Math.hypot(ddx, ddy);
      const advance = nd > 0 ? Math.min(nd, 2.5 * elapsed) : 0;
      const ex = fs.x + (nd > 0 ? (ddx / nd) * advance : 0);
      const ey = fs.y + (nd > 0 ? (ddy / nd) * advance : 0);
      const totalDist = Math.hypot(fs.target[0] - fs.sx, fs.target[1] - fs.sy);
      const traveledDist = Math.hypot(ex - fs.sx, ey - fs.sy);
      const progress = totalDist > 0 ? Math.min(1, traveledDist / totalDist) : 0;
      const illumR = (2 + 2 * (1 - Math.abs(2 * progress - 1))) * CELL;
      const fcx = cpx(ex), fcy = cpy(ey);
      const grad = ctx.createRadialGradient(fcx, fcy, 0, fcx, fcy, illumR);
      grad.addColorStop(0, 'rgba(255,240,160,0.28)');
      grad.addColorStop(0.6, 'rgba(255,220,80,0.10)');
      grad.addColorStop(1, 'rgba(255,200,0,0)');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(fcx, fcy, illumR, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#fffde0';
      ctx.shadowColor = '#ffe060';
      ctx.shadowBlur = 8;
      ctx.beginPath();
      ctx.arc(fcx, fcy, 3.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;
    }
  }

  // Grenadier windup telegraph: pulsing ring at the locked throw tile for own grenadiers
  for (const s of data.soldiers || []) {
    if (!s.grenade_target || s.owner !== mySeat()) continue;
    const [gx, gy] = s.grenade_target;
    const gcx = cpx(gx), gcy = cpy(gy);
    const wind = s.grenade_windup ?? 0;
    const windFrac = Math.max(0, Math.min(1, wind / 3.0));
    const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 120);
    ctx.save();
    ctx.strokeStyle = `rgba(154,210,109,${0.55 + 0.35 * pulse})`;
    ctx.lineWidth = 2;
    ctx.setLineDash([3, 2]);
    ctx.strokeRect(OX + gx * CELL + 2, tileTop(gy) + 2, CELL - 4, CELL - 4);
    ctx.setLineDash([]);
    // Shrinking inner ring shows windup progress (full → small as it nears throw)
    const r = CELL * 0.45 * windFrac + 2;
    ctx.beginPath();
    ctx.arc(gcx, gcy, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  // Flare targeting preview (scatter area around selected tile)
  if (mode === 'flare') {
    const hover = tileFromCanvas(mouseCanvas.x, mouseCanvas.y);
    if (hover) {
      const scatter = flareScatterRadius(hover);
      const cx = cpx(hover[0]);
      const cy = cpy(hover[1]);
      drawRangeCircle(cx, cy, scatter * CELL, 'rgba(255, 235, 120, 0.95)');
      ctx.fillStyle = 'rgba(255, 235, 120, 0.14)';
      ctx.beginPath();
      ctx.arc(cx, cy, scatter * CELL, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // Projectiles — dead-reckoned with tracer trails
  {
    const elapsed = (performance.now() - lastStateTime) / 1000;
    const projSpeed = data.rules?.projectile_speed ?? 8.0;
    for (const p of data.projectiles || []) {
      const norm = Math.hypot(p.dx ?? 0, p.dy ?? 0);
      const ex = norm > 0 ? p.x + (p.dx / norm) * projSpeed * elapsed : p.x;
      const ey = norm > 0 ? p.y + (p.dy / norm) * projSpeed * elapsed : p.y;
      const pcx = cpx(ex);
      const pcy = cpy(ey);
      const isMg = p.source === 'mg';

      if (norm > 0) {
        const ux = p.dx / norm, uy = p.dy / norm;
        const trailLen = isMg ? 22 : 14;
        const tailX = pcx - ux * trailLen;
        const tailY = pcy - uy * trailLen;
        const trailGrad = ctx.createLinearGradient(tailX, tailY, pcx, pcy);
        if (isMg) {
          trailGrad.addColorStop(0, 'rgba(255,220,80,0)');
          trailGrad.addColorStop(0.5, 'rgba(255,200,60,0.35)');
          trailGrad.addColorStop(1, 'rgba(255,255,180,0.9)');
        } else {
          trailGrad.addColorStop(0, 'rgba(255,255,255,0)');
          trailGrad.addColorStop(1, 'rgba(255,255,255,0.55)');
        }
        ctx.save();
        ctx.strokeStyle = trailGrad;
        ctx.lineWidth = isMg ? 2.0 : 1.2;
        ctx.beginPath();
        ctx.moveTo(tailX, tailY);
        ctx.lineTo(pcx, pcy);
        ctx.stroke();
        ctx.restore();
      }

      // Bright tip
      if (isMg) {
        const grad = ctx.createRadialGradient(pcx, pcy, 0, pcx, pcy, 4);
        grad.addColorStop(0, '#ffffff');
        grad.addColorStop(0.4, '#ffe060');
        grad.addColorStop(1, 'rgba(255,200,0,0)');
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(pcx, pcy, 4, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.fillStyle = 'rgba(255,255,255,0.92)';
        ctx.beginPath();
        ctx.arc(pcx, pcy, 1.5, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  // Muzzle flashes — bright core with wide ambient glow and directional streak
  for (const mf of data.muzzle_flashes || []) {
    const t = mf.age / mf.duration;
    const alpha = (1 - t) * 0.95;
    const norm = Math.hypot(mf.dx ?? 0, mf.dy ?? 0);
    const fx = cpx(mf.x);
    const fy = cpy(mf.y);
    const dirX = norm > 0 ? mf.dx / norm : 1;
    const dirY = norm > 0 ? mf.dy / norm : 0;
    ctx.save();
    // Wide ambient glow (makes surrounding tiles feel lit)
    const glowR = 20 * (1 - t * 0.6);
    ctx.globalAlpha = alpha * 0.22;
    const glowGrad = ctx.createRadialGradient(fx, fy, 0, fx, fy, glowR);
    glowGrad.addColorStop(0, '#ffe880');
    glowGrad.addColorStop(1, 'rgba(255,200,0,0)');
    ctx.fillStyle = glowGrad;
    ctx.beginPath();
    ctx.arc(fx, fy, glowR, 0, Math.PI * 2);
    ctx.fill();
    // Bright core circle
    ctx.globalAlpha = alpha;
    const coreR = 5 * (1 - t * 0.5);
    const grad = ctx.createRadialGradient(fx, fy, 0, fx, fy, coreR * 2.2);
    grad.addColorStop(0, '#ffffff');
    grad.addColorStop(0.25, '#ffffc0');
    grad.addColorStop(0.6, '#ffcc44');
    grad.addColorStop(1, 'rgba(255,140,0,0)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(fx, fy, coreR * 2.2, 0, Math.PI * 2);
    ctx.fill();
    // Short directional streak
    const streakLen = 11 * (1 - t);
    ctx.strokeStyle = `rgba(255,245,200,${0.9 * (1 - t)})`;
    ctx.lineWidth = 2.5;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(fx, fy);
    ctx.lineTo(fx + dirX * streakLen, fy + dirY * streakLen);
    ctx.stroke();
    ctx.restore();
  }

  // Explosions
  const trenchSet = new Set((data.map.trenches || []).map(t => `${t[0]},${t[1]}`));
  const hillSet = new Set((data.map.hills || []).map(t => `${t[0]},${t[1]}`));
  const mountainSet = new Set((data.map.mountains || []).map(t => `${t[0]},${t[1]}`));
  const sandbagTileSet = new Set((data.sandbags || []).filter(sb => sb.built && sb.hp > 0).map(sb => `${sb.tile[0]},${sb.tile[1]}`));
  const bunkerTileSetBlast = new Set((data.bunkers || []).filter(b => b.hp > 0).map(b => `${b.tile[0]},${b.tile[1]}`));

  const ELEV_TRENCH_VAL = 2, ELEV_HILL_VAL = 5, ELEV_MOUNTAIN_VAL = 6;
  function tileElevStr(tSet, hSet, mSet, tx, ty) {
    const key = `${tx},${ty}`;
    if (tSet.has(key)) return 'trench';
    if (hSet.has(key)) return 'hill';
    if (mSet.has(key)) return 'mountain';
    return 'ground';
  }
  function elevNumToStr(n) {
    if (n === ELEV_TRENCH_VAL) return 'trench';
    if (n === ELEV_HILL_VAL) return 'hill';
    if (n === ELEV_MOUNTAIN_VAL) return 'mountain';
    return 'ground';
  }
  // Bresenham cover check: true if any tile in blockSet lies strictly between (x0,y0) and (x1,y1)
  function hasCoverBetween(blockSet, x0, y0, x1, y1) {
    let dx = Math.abs(x1-x0), dy = Math.abs(y1-y0);
    let sx = x1>=x0?1:-1, sy = y1>=y0?1:-1;
    let err = dx-dy, cx = x0, cy = y0;
    while (true) {
      if (cx===x1 && cy===y1) return false;
      if ((cx!==x0||cy!==y0) && blockSet.has(`${cx},${cy}`)) return true;
      const e2 = 2*err;
      if (e2>-dy){err-=dy;cx+=sx;}
      if (e2<dx){err+=dx;cy+=sy;}
    }
  }

  for (const ex of data.explosions || []) {
    const kr = ex.kill_radius || 0;

    if (ex.airburst) {
      // Airburst: checkerboard highlight at all elevations, no cover/elevation check
      if (kr > 0 && ex.age < 1.0) {
        const fadeAlpha = (1 - ex.age) * 0.42;
        const cx = Math.round(ex.x), cy = Math.round(ex.y);
        ctx.fillStyle = `rgba(255,210,70,${fadeAlpha.toFixed(3)})`;
        for (let dy = -Math.ceil(kr); dy <= Math.ceil(kr); dy++) {
          for (let dx = -Math.ceil(kr); dx <= Math.ceil(kr); dx++) {
            if (Math.sqrt(dx * dx + dy * dy) > kr) continue;
            const tx = cx + dx, ty = cy + dy;
            if (tx < 0 || ty < 0 || tx >= data.map.width || ty >= data.map.height) continue;
            if ((tx + ty) % 2 !== (cx + cy) % 2) continue;
            ctx.fillRect(OX + tx * CELL, tileTop(ty), CELL - 1, CELL - 1);
          }
        }
      }
    } else {
      // HE: Blast light flash on same-elevation tiles in kill zone, fades over 1s
      if (kr > 0 && ex.age < 1.0) {
        const fadeAlpha = (1 - ex.age) * 0.42;
        const cx = Math.round(ex.x), cy = Math.round(ex.y);
        const landingElev = ex.landing_elev != null ? elevNumToStr(ex.landing_elev)
          : (ex.landing_in_trench ? 'trench' : tileElevStr(trenchSet, hillSet, mountainSet, cx, cy));
        // For trench blasts, augment the trench set with tiles that were collapsed by this blast
        // so the LOS check uses the pre-impact trench network.
        let losSet = trenchSet;
        if (landingElev === 'trench' && ex.collapsed_trenches && ex.collapsed_trenches.length) {
          losSet = new Set(trenchSet);
          for (const ct of ex.collapsed_trenches) losSet.add(`${ct[0]},${ct[1]}`);
        }
        ctx.fillStyle = `rgba(255,210,70,${fadeAlpha.toFixed(3)})`;
        for (let dy = -Math.ceil(kr); dy <= Math.ceil(kr); dy++) {
          for (let dx = -Math.ceil(kr); dx <= Math.ceil(kr); dx++) {
            if (Math.sqrt(dx * dx + dy * dy) > kr) continue;
            const tx = cx + dx, ty = cy + dy;
            if (tx < 0 || ty < 0 || tx >= data.map.width || ty >= data.map.height) continue;
            // Only highlight tiles at the same elevation as the impact
            if (tileElevStr(trenchSet, hillSet, mountainSet, tx, ty) !== landingElev) continue;
            if (landingElev === 'trench') {
              if (!hasTrenchLos(losSet, cx, cy, tx, ty)) continue;
            } else {
              if (hasCoverBetween(sandbagTileSet, cx, cy, tx, ty)) continue;
              if (hasCoverBetween(bunkerTileSetBlast, cx, cy, tx, ty)) continue;
            }
            ctx.fillRect(OX + tx * CELL, tileTop(ty), CELL - 1, CELL - 1);
          }
        }
      }
    }

    const t = ex.age / ex.duration;
    const alpha = 1 - t;
    const radius = (0.5 + t * 3) * CELL;
    ctx.globalAlpha = alpha * 0.75;
    const ecx = cpx(ex.x), ecy = cpy(ex.y);
    const grad = ctx.createRadialGradient(ecx, ecy, 0, ecx, ecy, radius);
    grad.addColorStop(0, '#fff8c0');
    grad.addColorStop(0.3, '#ff8800');
    grad.addColorStop(1, 'rgba(180,30,0,0)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(ecx, ecy, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  // Smoke-round zone overlays — grow east then fade from the west
  {
    const GROW_SPEED = 0.70, FADE_START = 12.0, FADE_SPEED = 1.125;
    for (const src of data.smoke_sources || []) {
      const { origin_x, origin_y, age, duration } = src;
      if (age >= duration) continue;
      const grown = Math.min(9, Math.floor(age * GROW_SPEED) + 1);
      const faded = age > FADE_START ? Math.min(grown, Math.floor((age - FADE_START) * FADE_SPEED)) : 0;
      if (grown <= faded) continue;
      const x0 = Math.round(origin_x);
      const yCtr = Math.round(origin_y);
      ctx.save();
      ctx.globalAlpha = 0.10;
      ctx.fillStyle = '#c8c8be';
      for (let x = x0 + faded; x < x0 + grown; x++) {
        ctx.fillRect(OX + x * CELL, tileTop(yCtr), CELL, CELL);
      }
      ctx.restore();
    }
  }

  // Smoke particles — explosion/airburst drawn directly; mortar puffs go through an
  // offscreen canvas so the composite alpha caps at 0.45 regardless of stacking.
  if (smokeParticles.length) {
    ctx.save();
    // Explosion/airburst smoke: draw directly (brief, stacking is fine)
    for (const p of smokeParticles) {
      if (p.no_wind) continue;
      const t = p.age / p.maxAge;
      const a = p.alpha * (1 - t * t);
      if (a < 0.015) continue;
      const r = p.r * CELL * (1 + t * (p.r_grow ?? 1.8));
      ctx.globalAlpha = a * 0.7;
      ctx.fillStyle = '#b8a898';
      ctx.beginPath();
      ctx.arc(cpx(p.x), cpy(p.y), r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();

    // Mortar smoke puffs: render to offscreen layer, then composite at capped alpha
    const mortarPuffs = smokeParticles.filter(p => p.no_wind);
    if (mortarPuffs.length) {
      if (!smokeLayer || smokeLayer.width !== board.width || smokeLayer.height !== board.height) {
        smokeLayer = document.createElement('canvas');
        smokeLayer.width = board.width;
        smokeLayer.height = board.height;
      }
      const sctx = smokeLayer.getContext('2d');
      sctx.clearRect(0, 0, smokeLayer.width, smokeLayer.height);
      for (const p of mortarPuffs) {
        const t = p.age / p.maxAge;
        const a = p.alpha * (1 - t * t);
        if (a < 0.015) continue;
        const dist = Math.max(0, p.x - p.ox) / 9;
        const r = p.r * CELL * (1 + dist * (p.r_grow ?? 1.8));
        sctx.globalAlpha = a;
        sctx.fillStyle = '#b8a898';
        sctx.beginPath();
        sctx.arc(cpx(p.x), cpy(p.y), r, 0, Math.PI * 2);
        sctx.fill();
      }
      ctx.save();
      ctx.globalAlpha = 0.45;
      ctx.drawImage(smokeLayer, 0, 0);
      ctx.restore();
    }
  }

  // Move-order confirmation pings: a quick contracting ring at the destination.
  for (const ping of moveOrderPings) {
    const t = ping.age / 0.6;
    const pcx = cpx(ping.x), pcy = cpy(ping.y);
    const r = CELL * (0.9 - 0.5 * t);
    ctx.save();
    ctx.globalAlpha = (1 - t) * 0.9;
    ctx.strokeStyle = 'rgba(120, 220, 255, 1)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(pcx, pcy, Math.max(1, r), 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  // Death crosses
  for (const dm of data.death_marks || []) {
    const alpha = 1 - dm.age / dm.duration;
    const dcx = cpx(dm.x);
    const dcy = cpy(dm.y);
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1.5;
    const s = 5;
    ctx.beginPath();
    ctx.moveTo(dcx - s, dcy - s); ctx.lineTo(dcx + s, dcy + s);
    ctx.moveTo(dcx + s, dcy - s); ctx.lineTo(dcx - s, dcy + s);
    ctx.stroke();
    ctx.lineWidth = 1;
    ctx.globalAlpha = 1;
  }

  // Impact particles — dirt puffs (miss) and kill sparks (hit)
  if (impactParticles.length) {
    ctx.save();
    for (const p of impactParticles) {
      const t = p.age / p.maxAge;
      const a = p.alpha * (1 - t * t);
      if (a < 0.01) continue;
      ctx.globalAlpha = a;
      ctx.fillStyle = `rgb(${p.color})`;
      ctx.beginPath();
      ctx.arc(cpx(p.x), cpy(p.y), Math.max(0.5, p.r * CELL * (1 - t * 0.4)), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  // Draw build-phase fog/hatching late so enemy-side units/structures are obscured.
  drawBuildPhaseOverlay(data);

  // Game-over overlay
  if (state && state.winner !== null && state.winner !== undefined) {
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(0, 0, board.width, board.height);
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 28px system-ui';
    ctx.textAlign = 'center';
    const msg = state.winner_name ? `${state.winner_name} wins!` : (state.win_reason || 'Game over');
    ctx.fillText(msg, board.width / 2, board.height / 2);
    if (state.win_reason && state.winner_name) {
      ctx.font = '16px system-ui';
      ctx.fillStyle = '#ccc';
      ctx.fillText(state.win_reason, board.width / 2, board.height / 2 + 32);
    }
    ctx.textAlign = 'left';
  }

  // Squad tactical boxes (Kill Box = red, Defend = blue)
  drawSquadBoxes();

  // Box / marquee selection overlay
  if (selectBox !== null) {
    const bx = Math.min(selectBox.x0, selectBox.x1);
    const by = Math.min(selectBox.y0, selectBox.y1);
    const bw = Math.abs(selectBox.x1 - selectBox.x0);
    const bh = Math.abs(selectBox.y1 - selectBox.y0);
    ctx.save();
    ctx.strokeStyle = 'rgba(100,200,255,0.9)';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 3]);
    ctx.strokeRect(bx, by, bw, bh);
    ctx.fillStyle = 'rgba(100,200,255,0.08)';
    ctx.fillRect(bx, by, bw, bh);
    ctx.setLineDash([]);
    ctx.restore();
  }
}

// Draw the persistent squad tactical boxes with hatching, delete-X, and (for
// Kill Box) an approach arrow in the corner the squad attacks from.
function drawSquadBoxes() {
  for (const [squadId, box] of squadBoxes) {
    const r = boxCanvasRect(box);
    const w = r.right - r.left, h = r.bottom - r.top;
    const isKill = box.kind === 'killbox';
    const stroke = isKill ? 'rgba(230,70,60,0.95)' : 'rgba(70,120,230,0.95)';
    const fill = isKill ? 'rgba(230,70,60,0.10)' : 'rgba(70,120,230,0.10)';
    const hatch = isKill ? 'rgba(230,70,60,0.16)' : 'rgba(70,120,230,0.16)';
    ctx.save();
    // Fill
    ctx.fillStyle = fill;
    ctx.fillRect(r.left, r.top, w, h);
    // Diagonal hatching, clipped to the box
    ctx.save();
    ctx.beginPath();
    ctx.rect(r.left, r.top, w, h);
    ctx.clip();
    ctx.strokeStyle = hatch;
    ctx.lineWidth = 1;
    for (let d = -h; d < w; d += 8) {
      ctx.beginPath();
      ctx.moveTo(r.left + d, r.top);
      ctx.lineTo(r.left + d + h, r.bottom);
      ctx.stroke();
    }
    ctx.restore();
    // Border
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 2;
    ctx.strokeRect(r.left + 1, r.top + 1, w - 2, h - 2);

    // Approach arrow for Kill Box: from the approach corner diagonally across.
    if (isKill) {
      const ax = cpx(box.ax), ay = cpy(box.ay);
      const ox = cpx(box.x1), oy = cpy(box.y1);
      const dx = ox - ax, dy = oy - ay;
      const len = Math.hypot(dx, dy) || 1;
      const ux = dx / len, uy = dy / len;
      const tipX = ax + ux * Math.min(len, 26), tipY = ay + uy * Math.min(len, 26);
      ctx.strokeStyle = stroke;
      ctx.fillStyle = stroke;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(tipX, tipY);
      ctx.stroke();
      // arrowhead
      const ah = 6;
      ctx.beginPath();
      ctx.moveTo(tipX, tipY);
      ctx.lineTo(tipX - ux * ah - uy * ah * 0.6, tipY - uy * ah + ux * ah * 0.6);
      ctx.lineTo(tipX - ux * ah + uy * ah * 0.6, tipY - uy * ah - ux * ah * 0.6);
      ctx.closePath();
      ctx.fill();
    }

    // Delete-X button (top-right)
    ctx.fillStyle = 'rgba(20,20,24,0.8)';
    ctx.fillRect(r.right - 18, r.top, 18, 18);
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(r.right - 14, r.top + 4); ctx.lineTo(r.right - 4, r.top + 14);
    ctx.moveTo(r.right - 4, r.top + 4); ctx.lineTo(r.right - 14, r.top + 14);
    ctx.stroke();

    // Resize handle at the opposite corner
    const rx = cpx(box.x1), ry = cpy(box.y1);
    ctx.fillStyle = stroke;
    ctx.fillRect(rx - 4, ry - 4, 8, 8);

    ctx.restore();
  }
}

// === SELECTION PANEL ===

function setMortarRound(roundType) {
  if (selectedMortar === null) return;
  send({ type: 'tw_set_mortar_round', mortar_id: selectedMortar, round_type: roundType });
}

function toggleMortarHoldFire() {
  if (selectedMortar === null) return;
  send({ type: 'tw_toggle_mortar_hold_fire', mortar_id: selectedMortar });
}

function updateSelectionPanel() {
  const panel = el('selection-panel');
  if (!panel) return;

  const soldier = getSelectedSoldier();
  const mg = getSelectedMg();
  const mortar = getSelectedMortar();

  let html = '';

  if (!soldier && !mg && !mortar) {
    if (selectedUnits.size > 1) {
      const alive = [...selectedUnits].filter(uid => (tw()?.soldiers || []).some(s => s.unit_id === uid));
      html = `<div class="sel-row"><strong>${alive.length}</strong>&nbsp;soldiers selected</div>`;
    } else {
      html = '<div class="muted">Nothing selected.</div>';
    }
  } else if (soldier) {
    const modeLabel = { select: '—', move: 'Move' };
    const taskLabel = { dig: 'Digging', build_mg: 'Building MG', operate_mg: 'Crewing MG', move: 'Moving' };
    const side = soldier.owner === 0 ? 'Red' : 'Blue';
    const hp = Math.round((soldier.hp / (soldier.hp_max || 5)) * 100);
    const tsk = soldier.combat_halt ? 'Engaging' : (soldier.task ? (taskLabel[soldier.task.type] || soldier.task.type) : '—');
    const blockedTag = soldier.blocked ? '<span class="sel-blocked">BLOCKED</span>' : '';
    const rangeRow = !soldier.is_grenadier
      ? `<span class="sel-label">Range</span><span class="sel-val">${soldier.range ?? RIFLE_RANGE}</span>`
      : '';
    html = `
      <div class="sel-grid">
        <span class="sel-label">Side</span><span class="sel-val">${side}</span>
        <span class="sel-label">Role</span><span class="sel-val">${soldier.is_grenadier ? 'Grenadier' : 'Rifleman'}</span>
        <span class="sel-label">HP</span><span class="sel-val">${hp}%</span>
        ${rangeRow}
        <span class="sel-label">Mode</span><span class="sel-val">${modeLabel[soldier.mode] || soldier.mode}</span>
        <span class="sel-label">Task</span><span class="sel-val">${tsk}</span>
      </div>${blockedTag}`;
  } else if (mg) {
    const side = mg.owner === 0 ? 'Red' : 'Blue';
    const hp = Math.round((mg.hp / (mg.hp_max || 20)) * 100);
    const ops = (mg.operators || []).length;
    html = `
      <div class="sel-grid">
        <span class="sel-label">Side</span><span class="sel-val">${side}</span>
        <span class="sel-label">HP</span><span class="sel-val">${hp}%</span>
        <span class="sel-label">Built</span><span class="sel-val">${mg.built ? 'Yes' : 'No'}</span>
        <span class="sel-label">Crew</span><span class="sel-val">${ops}/1</span>
      </div>`;
  } else if (mortar) {
    const side = mortar.owner === 0 ? 'Red' : 'Blue';
    const hp = Math.round((mortar.hp / (mortar.hp_max || 10)) * 100);
    const ops = (mortar.operators || []).length;
    const holdFire = mortar.hold_fire ?? false;
    let stateStr;
    if (!mortar.built) {
      stateStr = `Building ${Math.round((mortar.build_progress / (mortar.build_required || 60)) * 100)}%`;
    } else if (mortar.ready) {
      stateStr = holdFire
        ? '<span style="color:#f4a020">READY — click to fire</span>'
        : '<span style="color:#65e06f">READY — auto-firing</span>';
    } else {
      stateStr = `Reloading ${mortar.cooldown.toFixed(1)}s`;
    }
    const tgt = mortar.target ? `(${mortar.target[0]}, ${mortar.target[1]})` : '—';
    const operableTag = mortar.operable === false ? '<span class="sel-blocked">Inoperable: restore 3×3 ground</span>' : '';
    const isAirburst = mortar.round_type === 'airburst';
    const isSmoke = mortar.round_type === 'smoke';
    const ammoRow = mortar.built && mortar.owner === mySeat() ? `
      <div class="sel-ammo-btns">
        <button class="sel-ammo-btn${!isAirburst && !isSmoke ? ' active' : ''}" onclick="setMortarRound('he')">HE</button>
        <button class="sel-ammo-btn${isAirburst ? ' active' : ''}" onclick="setMortarRound('airburst')">Airburst</button>
        <button class="sel-ammo-btn${isSmoke ? ' active' : ''}" onclick="setMortarRound('smoke')">Smoke</button>
        <button class="sel-ammo-btn${holdFire ? ' active' : ''}" onclick="toggleMortarHoldFire()">Hold Fire</button>
      </div>` : '';
    html = `
      <div class="sel-grid">
        <span class="sel-label">Side</span><span class="sel-val">${side}</span>
        <span class="sel-label">HP</span><span class="sel-val">${hp}%</span>
        <span class="sel-label">Crew</span><span class="sel-val">${ops}/2</span>
        <span class="sel-label">Target</span><span class="sel-val">${tgt}</span>
        <span class="sel-label">State</span><span class="sel-val">${stateStr}</span>
      </div>${ammoRow}${operableTag}`;
  }

  // Only replace DOM when content has actually changed — avoids destroying
  // button elements mid-click in the 60 fps render loop.
  if (html !== lastPanelHtml) {
    lastPanelHtml = html;
    panel.innerHTML = html;
  }
}

let _lastSquadHtml = '';
function updateSquadWindow() {
  const winEl = el('squad-window');
  if (!winEl || !tw()) return;
  const mySquads = (tw().squads || []).filter(sq => sq.owner === mySeat());
  let html = '';
  if (mySquads.length === 0) {
    html = '<span class="squad-window-empty">No squads</span>';
  } else {
    for (const squad of mySquads) {
      const aliveCount = (tw().soldiers || []).filter(s => s.squad_id === squad.squad_id).length;
      const isSelected = selectedSquad === squad.squad_id;
      const colorHex = getSquadColor(squad.color);
      html += `<div class="squad-tab${isSelected ? ' selected' : ''}" style="border-left:3px solid ${colorHex};" onclick="selectSquad(${squad.squad_id})">` +
        `<span class="squad-dot" style="background:${colorHex}"></span>` +
        `<span class="squad-count">${aliveCount}</span>` +
        `<button class="squad-disband" onclick="event.stopPropagation();disbandSquad(${squad.squad_id})">×</button>` +
        `</div>`;
    }
  }
  if (html !== _lastSquadHtml) {
    _lastSquadHtml = html;
    winEl.innerHTML = html;
  }
}

// Grey out squad/formation controls while the side has no officer.
function updateCommandState() {
  const disabled = !hasCommand();
  for (const id of ['formation-controls', 'squad-window']) {
    const e = el(id);
    if (e) e.classList.toggle('command-disabled', disabled);
  }
  const hint = el('command-lost-hint');
  if (hint) hint.style.display = disabled ? 'block' : 'none';
}

// === RENDER ===

function render() {
  if (!state) return;
  draw();
  updateSelectionPanel();
  updateSquadWindow();
  updateCommandState();

  if (state.status === 'open') {
    setStatus('Waiting for opponent…');
  } else if (state.winner !== null && state.winner !== undefined) {
    const msg = state.winner_name
      ? `${state.winner_name} wins — ${state.win_reason || ''}`
      : (state.win_reason || 'Game over.');
    setStatus(msg);
  } else if (mode === 'dig') {
    if (plan.length) setStatus(`Dig/Plan — ${plan.length} tile plan traced. Click a soldier to assign, or keep dragging.`);
    else if (!selectedUnits.size) setStatus('Dig/Plan — click a soldier to select, then click a tile. Or drag to trace a multi-tile plan.');
    else setStatus('Dig/Plan — click a tile to dig. Drag to trace a longer plan.');
  } else if (mode === 'sandbag') {
    const inBuildPhase = (tw()?.build_phase_remaining || 0) > 0;
    if (inBuildPhase) {
      const sbRem = tw()?.build_sandbags_remaining ?? 0;
      if (!selectedUnits.size) setStatus(`Sandbag — click any tile to place instantly (${sbRem} remaining), or select a soldier to place manually.`);
      else setStatus('Sandbag — click an adjacent open tile to build (manual, no cost).');
    } else {
      if (!selectedUnits.size) setStatus('Sandbag — click a soldier, then click an adjacent open tile.');
      else setStatus('Sandbag — click an adjacent open tile to build.');
    }
  } else if (mode === 'wire') {
    const inBuildPhase = (tw()?.build_phase_remaining || 0) > 0;
    if (inBuildPhase) {
      const wireRem = tw()?.build_wire_remaining ?? 0;
      if (!selectedUnits.size) setStatus(`Wire — click any tile to place instantly (${wireRem} remaining), or select a soldier to place manually.`);
      else setStatus('Wire — click an adjacent open tile to place wire (manual, no cost).');
    } else {
      if (!selectedUnits.size) setStatus('Wire — click a soldier, then click an adjacent open tile to place wire.');
      else setStatus('Wire — click an adjacent open tile to place wire (2 s build).');
    }
  } else if (mode === 'bunker') {
    const inBuildPhase = (tw()?.build_phase_remaining || 0) > 0;
    if (inBuildPhase) {
      const bunkerRem = tw()?.build_bunkers_remaining ?? 0;
      setStatus(`Bunker — click a trench tile to place (${bunkerRem} remaining). Direct mortar hits negated; protects trench from collapse.`);
    } else {
      setStatus('Bunker placement is only available during the build phase.', true);
    }
  } else if (mode === 'flare') {
    const fr = tw()?.flares_remaining;
    const rem = fr ? (fr[String(mySeat())] ?? 0) : 0;
    if (!myOfficer()) setStatus('Flare — unavailable (no living officer).', true);
    else setStatus(`Flare — click any tile to illuminate it (${rem} remaining). Reveals all units in radius.`);
  } else if (mode === 'select') {
    const selCount = selectedUnits.size;
    if (selCount > 0) setStatus(`Select — ${selCount} selected. Switch to Move (2/V) to issue orders.`);
    else setStatus('Select — click a soldier to select it. Drag to box-select. Switch to Move (2/V) to issue move orders.');
  } else if (mode === 'move') {
    let n = formationCount;
    let who = `${n} nearest`;
    if (selectedSquad !== null) {
      n = (getSquad(selectedSquad)?.soldier_ids || []).filter(uid => (tw()?.soldiers || []).find(s => s.unit_id === uid)).length || 1;
      who = `squad (${n})`;
    } else if (selectedUnits.size > 0) {
      n = selectedUnits.size;
      who = `${n} selected`;
    }
    setStatus(`Move — left-click ground to move ${who} in ${formationShape} formation.`);
  } else {
    const bpr = tw()?.build_phase_remaining || 0;
    if (bpr > 0) setStatus(`Build phase: ${Math.ceil(bpr)}s (no firing / no crossing midline).`);
    else setStatus('Active.');
  }

  const shareEl = el('share-line');
  if (shareEl) shareEl.textContent = state.join_code ? `Join code: ${state.join_code}` : `ID: ${state.game_id}`;

  const seatEl = el('seat-line');
  const chipEl = el('seat-chip');
  const seat = mySeat();
  if (seatEl) seatEl.textContent = seat === null ? 'Spectator' : (seat === 0 ? 'Red' : 'Blue');
  if (chipEl) {
    chipEl.classList.toggle('seat-red', seat === 0);
    chipEl.classList.toggle('seat-blue', seat === 1);
  }

  const remaining = Math.max(0, Math.floor(tw()?.time_remaining || 0));
  const clockEl = el('clock-line');
  if (clockEl) clockEl.textContent = `${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, '0')}`;

  const k = tw()?.kill_counts || {};
  const k0 = el('kills0'), k1 = el('kills1');
  if (k0) k0.textContent = String(k['0'] || 0);
  if (k1) k1.textContent = String(k['1'] || 0);

  const rt = tw()?.recruit_timers || {};
  const r0 = el('recruit0'), r1 = el('recruit1');
  function fmtTimer(s) { s = Math.ceil(s); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; }
  if (r0) r0.textContent = fmtTimer(rt['0'] ?? 180);
  if (r1) r1.textContent = fmtTimer(rt['1'] ?? 180);

  const fr = tw()?.flares_remaining || {};
  const f0 = el('flares0'), f1 = el('flares1');
  if (f0) f0.textContent = fr['0'] ?? 5;
  if (f1) f1.textContent = fr['1'] ?? 5;

  const logEl = el('log');
  if (logEl) logEl.innerHTML = (state.log || []).slice(-20).map(m => `<div class="log-entry">${m}</div>`).join('');

  updateModeButtons();
  updateModeLabel();
}

// === BUTTON WIRING ===

[
  ['mode-select','select'], ['mode-move','move'],
  ['mode-dig','dig'], ['mode-build','build'], ['mode-mortar','mortar'], ['mode-sandbag','sandbag'], ['mode-wire','wire'], ['mode-bunker','bunker'], ['mode-flare','flare'],
].forEach(([id, m]) => {
  const btn = el(id);
  if (btn) btn.addEventListener('click', (evt) => { evt.stopPropagation(); setMode(m); render(); });
});

const buildToggle = el('build-flyout-toggle');
if (buildToggle) buildToggle.addEventListener('click', (evt) => {
  evt.stopPropagation();
  // If a build mode is active, the flyout is forced open; clicking returns to Select.
  if (BUILD_MODES.has(mode)) { setMode('select'); render(); return; }
  buildFlyoutOpen = !buildFlyoutOpen;
  applyBuildFlyout();
});

[1, 2, 3, 4].forEach(n => {
  const btn = el(`fcount-${n}`);
  if (btn) btn.addEventListener('click', () => {
    formationCount = n;
    document.querySelectorAll('.fcount-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    render();
  });
});

['horizontal', 'vertical'].forEach(shape => {
  const btn = el(`fshape-${shape}`);
  if (btn) btn.addEventListener('click', () => {
    formationShape = shape;
    document.querySelectorAll('.fshape-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    render();
  });
});

// Squad tactical boxes: arm a Kill Box / Defend draw (requires a selected squad + command).
for (const [btnId, kind] of [['tactic-killbox', 'killbox'], ['tactic-defend', 'defend']]) {
  const btn = el(btnId);
  if (btn) btn.addEventListener('click', () => {
    if (!hasCommand()) { setStatus('No officer — squad orders unavailable.', true); return; }
    if (selectedSquad === null) { setStatus('Select a squad first, then draw a box.', true); return; }
    armedBoxKind = kind;
    setStatus(kind === 'killbox'
      ? 'Kill Box — drag a box on the map from the corner your squad attacks from.'
      : 'Defend — drag a box; the squad holds the best ground inside it.');
    render();
  });
}

el('cancel-task').addEventListener('click', () => {
  const smg = getSelectedMg();
  if (smg && !smg.built) {
    send({ type: 'tw_cancel_build_mg', mg_id: smg.structure_id });
    selectedMg = null;
  } else {
    const sm = getSelectedMortar();
    if (sm && !sm.built) {
      send({ type: 'tw_cancel_build_mortar', mortar_id: sm.structure_id });
      selectedMortar = null;
    } else {
      for (const uid of selectedUnits) send({ type: 'tw_cancel_task', unit_id: uid });
    }
  }
  render();
});

el('resign').addEventListener('click', () => {
  if (confirm('Resign this game?')) send({ type: 'resign' });
});

// === INIT ===

connect();
setupBoardZoomControl();
applyBoardZoom();
setInterval(() => send({ type: 'ping' }), 200);

// Mortar smoke puffs — originate at impact, drift east to fill the 1×9 zone.
// r_grow: 7.5    → at 9 tiles east, radius ≈ 1.5 tiles (diameter ≈ 3 tiles).
// damp_x: 0.12   → base eastward damping; particles slow considerably over the zone.
// size_damp: 0.06 → per unit of growFactor above 1; at full size xDamp ≈ 0.57 (nearly stopped).
// damp_y: 0.9    → strong vertical damping keeps puffs on the row.
// no_wind: true  → skip the shared eastward wind acceleration.
function spawnSmokeMortarPuff(gx, gy) {
  smokeParticles.push({
    x: gx + (Math.random() - 0.5) * 0.2,
    y: gy + (Math.random() - 0.5) * 0.2,
    ox: gx,
    vx: 0.8 + Math.random() * 2.0,
    vy: (Math.random() - 0.5) * 0.10,
    alpha: 0.18 + Math.random() * 0.12,
    age: 0,
    maxAge: 12 + Math.random() * 6,
    r: 0.14 + Math.random() * 0.08,
    r_grow: 7.5,
    damp_x: 0.12,
    size_damp: 0.06,
    damp_y: 0.9,
    no_wind: true,
  });
}

function updateSmoke() {
  const now = performance.now();
  const dt = Math.min(0.1, (now - lastSmokeTick) / 1000);
  lastSmokeTick = now;
  for (const p of smokeParticles) {
    if (!p.no_wind) p.vx += 0.9 * dt;
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    const dist = p.ox != null ? Math.max(0, p.x - p.ox) / 9 : 0;
    const growFactor = 1 + dist * (p.r_grow ?? 0);
    const xDamp = (p.damp_x ?? 3) + (p.size_damp ?? 0) * (growFactor - 1);
    p.vx *= 1 - xDamp * dt;
    p.vy *= 1 - (p.damp_y ?? 2) * dt;
    p.age += dt;
  }
  smokeParticles = smokeParticles.filter(p => p.age < p.maxAge);
}

function updateImpactParticles() {
  const now = performance.now();
  const dt = Math.min(0.05, (now - lastSmokeTick) / 1000);
  for (const p of impactParticles) {
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.vy += 0.3 * dt;  // gravity
    p.age += dt;
  }
  impactParticles = impactParticles.filter(p => p.age < p.maxAge);
}

// Move each soldier's display position toward its server position at twice soldier speed.
// This gives smooth tile-to-tile glide without needing move_cooldown data from the server.
let _lastRafTime = performance.now();
function updateSoldierDisplayPos() {
  const now = performance.now();
  const dt = Math.min(0.1, (now - _lastRafTime) / 1000);
  _lastRafTime = now;
  const DISPLAY_SPEED = 2.6; // tiles per second (soldier moves at 1.25; catch-up is fast)
  const soldiers = tw()?.soldiers || [];
  // Remove entries for dead/gone soldiers.
  const liveIds = new Set(soldiers.map(s => s.unit_id));
  for (const id of soldierDisplayPos.keys()) {
    if (!liveIds.has(id)) soldierDisplayPos.delete(id);
  }
  for (const s of soldiers) {
    if (!soldierDisplayPos.has(s.unit_id)) {
      soldierDisplayPos.set(s.unit_id, { x: s.x, y: s.y });
      continue;
    }
    const dp = soldierDisplayPos.get(s.unit_id);
    const dx = s.x - dp.x, dy = s.y - dp.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const step = DISPLAY_SPEED * dt;
    if (dist <= step) {
      dp.x = s.x; dp.y = s.y;
    } else {
      dp.x += (dx / dist) * step;
      dp.y += (dy / dist) * step;
    }
  }
}

(function rafLoop() {
  updateSoldierDisplayPos();
  // Age move-order pings (~0.6s lifetime).
  for (const ping of moveOrderPings) ping.age += 0.016;
  moveOrderPings = moveOrderPings.filter(p => p.age < 0.6);
  updateSmoke();
  updateImpactParticles();
  // Spawn billowy puffs from the impact origin; their velocity carries them east to cover the zone.
  // Stop spawning once the fade phase starts — existing long-lived puffs handle the tail.
  const FADE_START = 12.0;
  for (const src of tw()?.smoke_sources || []) {
    if (src.age >= FADE_START) continue;
    if (Math.random() > 0.10) continue;
    spawnSmokeMortarPuff(src.origin_x, src.origin_y);
  }
  if (state) render();
  requestAnimationFrame(rafLoop);
})();
updateModeButtons();
updateModeLabel();
updateMusicBtn();
(function() {
  const musicBtn = document.getElementById('tw-music-btn');
  if (musicBtn) musicBtn.addEventListener('click', toggleBuildMusic);
})();
