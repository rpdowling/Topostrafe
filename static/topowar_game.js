// === GLOBALS ===
const gameId = window.TOPOS_GAME_ID;
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
let smokeParticles = [];
let lastSmokeTick = performance.now();
let poppedAirburstShells = new Set();
let lastPanelHtml = '';
let elevMap = new Map();

const CELL = 24;
const OX = 20;
const OY = 20;
const RIFLE_RANGE = 5;
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
      }
      reconcilePendingBuildState();
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

// === MODE MANAGEMENT ===

function updateModeButtons() {
  const modes = ['select','move','dig','plan','build','operate','mortar','grenade','sandbag','wire','bunker','flare'];
  for (const m of modes) {
    const btn = el('mode-' + m);
    if (btn) btn.classList.toggle('active', mode === m);
  }
}

function setMode(m) {
  if (mode === m) {
    mode = 'select';
    plan = [];
    pendingBuildTile = null; pendingBuildFacing = null; pendingMgDispatch = false;
    pendingMortarTile = null; pendingMortarTarget = null; pendingMortarDispatch = false;
    retargetMortarId = null;
  } else {
    mode = m;
    if (m !== 'plan') plan = [];
    if (m !== 'build') { pendingBuildTile = null; pendingBuildFacing = null; pendingMgDispatch = false; }
    if (m !== 'mortar') { pendingMortarTile = null; pendingMortarTarget = null; pendingMortarDispatch = false; }
    if (m === 'build' || m === 'mortar' || m === 'sandbag' || m === 'wire' || m === 'bunker' || m === 'move') selectedUnits = new Set();
  }
  updateModeButtons();
  updateModeLabel();
  if (mode === 'build') refreshBuildStatus();
}

function updateModeLabel() {
  const labels = {
    select: 'Select', move: 'Move',
    dig: 'Dig', plan: 'Plan Dig', build: 'Build MG', operate: 'Crew', mortar: 'Build Mortar', grenade: 'Grenade', sandbag: 'Build Sandbag', wire: 'Wire', bunker: 'Bunker', flare: 'Flare',
  };
  const e = el('mode-line');
  if (e) e.textContent = labels[mode] || 'Select';
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
      setStatus('MG construction started.');
    }
  }
  if (pendingMortarTile) {
    const placedMortar = (data.mortars || []).find(
      m => m.owner === mySeat() && m.tile[0] === pendingMortarTile[0] && m.tile[1] === pendingMortarTile[1]
    );
    if (placedMortar) {
      clearPendingMortarBuild();
      setStatus('Mortar construction started.');
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

  const shortcutMap = { '1':'select','2':'move','D':'dig','P':'plan','B':'build','O':'operate','M':'mortar','N':'grenade','G':'sandbag','W':'wire','F':'flare' };
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

  if (mode === 'select') {
    if (myS.length) {
      const uid = myS[0].unit_id;
      if (evt.ctrlKey) {
        if (selectedUnits.has(uid)) selectedUnits.delete(uid);
        else selectedUnits.add(uid);
      } else {
        selectedUnits = new Set([uid]);
      }
      selectedMg = null; selectedMortar = null;
    } else if (myMortar) {
      selectedMortar = myMortar.structure_id; selectedMg = null; selectedUnits = new Set();
      if (myMortar.built && myMortar.ready) {
        send({ type: 'tw_fire_mortar', mortar_id: myMortar.structure_id });
      }
    } else if (myMg) {
      selectedMg = myMg.structure_id; selectedMortar = null; selectedUnits = new Set();
    } else {
      selectedUnits = new Set(); selectedMg = null; selectedMortar = null;
    }

  } else if (mode === 'move') {
    if (selectedUnits.size && !evt.ctrlKey) {
      if (myS.length) {
        // Clicking a friendly soldier: change selection instead of moving
        selectedUnits = new Set([myS[0].unit_id]);
      } else if (soldiersAt(tile).length === 0 && !tileHasEquipment(tile)) {
        // Empty tile: send move orders
        for (const uid of selectedUnits) send({ type: 'tw_move_unit', unit_id: uid, tile });
        selectedUnits = new Set();
      }
    } else if (myS.length) {
      // Nothing selected (or Ctrl held): click to select/toggle
      const uid = myS[0].unit_id;
      if (evt.ctrlKey) {
        if (selectedUnits.has(uid)) selectedUnits.delete(uid);
        else selectedUnits.add(uid);
      } else {
        selectedUnits = new Set([uid]);
      }
    }

  } else if (mode === 'dig') {
    if (myS.length) {
      selectedUnits = new Set([myS[0].unit_id]);
    } else {
      const uid = firstSelected();
      if (uid !== null) send({ type: 'tw_assign_dig', unit_id: uid, plan: [tile] });
    }

  } else if (mode === 'plan') {
    if (myS.length) {
      const uid = myS[0].unit_id;
      selectedUnits = new Set([uid]);
      if (plan.length) { send({ type: 'tw_assign_dig', unit_id: uid, plan: [...plan] }); plan = []; }
    } else {
      const last = plan[plan.length - 1];
      if (!last || Math.abs(last[0]-tile[0]) + Math.abs(last[1]-tile[1]) === 1) {
        if (!last || last[0] !== tile[0] || last[1] !== tile[1]) plan.push(tile);
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

  } else if (mode === 'operate') {
    const myMortar = myMortarAt(tile);
    if (myMg) {
      if (myMg.structure_id === selectedMg && myMg.force_target) {
        // Click the already-selected MG again → clear force fire
        send({ type: 'tw_force_fire', mg_id: selectedMg, tile: null });
        setStatus('Force fire cleared.');
      } else {
        selectedMg = myMg.structure_id; selectedMortar = null;
        if (myMg.built) {
          const ops = (tw().soldiers || [])
            .filter(s => s.owner === mySeat())
            .sort((a, b) => Math.hypot(a.tile[0]-myMg.tile[0],a.tile[1]-myMg.tile[1]) - Math.hypot(b.tile[0]-myMg.tile[0],b.tile[1]-myMg.tile[1]))
            .slice(0, 1).map(s => s.unit_id);
          send({ type: 'tw_toggle_operate_mg', mg_id: selectedMg, unit_ids: ops });
        }
        // If unbuilt: just select it so a follow-up soldier click can resume construction
      }
    } else if (myMortar) {
      selectedMortar = myMortar.structure_id; selectedMg = null;
      if (myMortar.built) {
        const ops = (tw().soldiers || [])
          .filter(s => s.owner === mySeat())
          .sort((a, b) => Math.hypot(a.tile[0]-myMortar.tile[0],a.tile[1]-myMortar.tile[1]) - Math.hypot(b.tile[0]-myMortar.tile[0],b.tile[1]-myMortar.tile[1]))
          .slice(0, 2).map(s => s.unit_id);
        send({ type: 'tw_toggle_operate_mortar', mortar_id: selectedMortar, unit_ids: ops });
      }
    } else if (selectedMg !== null && myS.length) {
      const mg = getSelectedMg();
      if (mg) {
        if (!mg.built) {
          // Resume interrupted build with this soldier
          send({ type: 'tw_resume_build_mg', mg_id: selectedMg, unit_id: myS[0].unit_id });
          selectedMg = null;
        } else {
          const ops = new Set((mg.operators || []).map(x => Number(x)));
          const uid = myS[0].unit_id;
          if (ops.has(uid)) {
            ops.delete(uid);
          } else {
            ops.clear();
            ops.add(uid);
          }
          send({ type: 'tw_toggle_operate_mg', mg_id: selectedMg, unit_ids: [...ops] });
        }
      }
    } else if (selectedMg !== null) {
      const mg = getSelectedMg();
      if (mg && mg.built) {
        send({ type: 'tw_force_fire', mg_id: selectedMg, tile });
        setStatus('Force fire set — click MG again to clear.');
      }
    }

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
      const sbTrenchSet = new Set((tw().map?.trenches || []).map(t => `${t[0]},${t[1]}`));
      const sbKey = `${tile[0]},${tile[1]}`;
      if (sbRem <= 0) {
        setStatus('No build-phase sandbags remaining.', true);
      } else if (sbTrenchSet.has(sbKey)) {
        setStatus('Cannot place sandbag in a trench.', true);
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
          const sbTrenchSet = new Set((tw().map?.trenches || []).map(t => `${t[0]},${t[1]}`));
          const sbKey = `${tile[0]},${tile[1]}`;
          if (Math.max(dx, dy) === 1 && !sbTrenchSet.has(sbKey)) {
            send({ type: 'tw_assign_build_sandbag', unit_id: uid, tile });
          } else {
            setStatus('Sandbag must be placed on a non-trench tile adjacent to the soldier.', true);
          }
        }
      }
    }

  } else if (mode === 'grenade') {
    send({ type: 'tw_set_grenade_tile', tile });
    setStatus('Grenade target updated.');

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
      const bkey = `${tile[0]},${tile[1]}`;
      if (bunkerRem <= 0) {
        setStatus('No build-phase bunkers remaining.', true);
      } else if (!trenchSet.has(bkey)) {
        setStatus('Bunkers can only be placed on trench tiles.', true);
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
  const myMg = myMgAt(tile);
  if (myMg) {
    send({ type: 'tw_force_fire', mg_id: myMg.structure_id, tile: null });
    setStatus('Force fire cleared.');
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

board.addEventListener('mousemove', (evt) => {
  const r = board.getBoundingClientRect();
  mouseCanvas.x = (evt.clientX - r.left) * (board.width / r.width);
  mouseCanvas.y = (evt.clientY - r.top) * (board.height / r.height);
  if (mode === 'build' && pendingBuildTile && pendingBuildFacing === null) render();
  if (mode === 'mortar' && pendingMortarTile && !pendingMortarTarget) render();
  if (retargetMortarId !== null) render();
  if (mode === 'flare') render();
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

  ctx.fillStyle = '#1a1e28';
  ctx.fillRect(0, 0, board.width, board.height);

  // Ground tiles
  for (let y = 0; y < data.map.height; y++) {
    for (let x = 0; x < data.map.width; x++) {
      ctx.fillStyle = '#445a48';
      ctx.fillRect(OX + x * CELL, tileTop(y), CELL - 1, CELL - 1);
    }
  }

  // Mountain tiles (grey)
  for (const t of data.map.mountains || []) {
    const tty = tileTop(t[1]);
    ctx.fillStyle = '#8c8c8c';
    ctx.fillRect(OX + t[0] * CELL, tty, CELL - 1, CELL - 1);
    ctx.strokeStyle = 'rgba(180,180,180,0.3)';
    ctx.lineWidth = 0.5;
    ctx.strokeRect(OX + t[0] * CELL + 0.5, tty + 0.5, CELL - 2, CELL - 2);
    ctx.lineWidth = 1;
  }

  // Hill tiles (midpoint between ground #445a48 and mountain #8c8c8c)
  for (const t of data.map.hills || []) {
    const tty = tileTop(t[1]);
    ctx.fillStyle = '#68736a';
    ctx.fillRect(OX + t[0] * CELL, tty, CELL - 1, CELL - 1);
    ctx.strokeStyle = 'rgba(90,105,92,0.3)';
    ctx.lineWidth = 0.5;
    ctx.strokeRect(OX + t[0] * CELL + 0.5, tty + 0.5, CELL - 2, CELL - 2);
    ctx.lineWidth = 1;
  }

  // Trench tiles
  for (const t of data.map.trenches) {
    const tty = tileTop(t[1]);
    ctx.fillStyle = '#2e2a24';
    ctx.fillRect(OX + t[0] * CELL, tty, CELL - 1, CELL - 1);
    ctx.strokeStyle = 'rgba(100,80,50,0.35)';
    ctx.lineWidth = 0.5;
    ctx.beginPath();
    ctx.moveTo(OX + t[0] * CELL, tty);
    ctx.lineTo(OX + t[0] * CELL + CELL - 1, tty + CELL - 1);
    ctx.moveTo(OX + t[0] * CELL + CELL - 1, tty);
    ctx.lineTo(OX + t[0] * CELL, tty + CELL - 1);
    ctx.stroke();
    ctx.lineWidth = 1;
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

  // Sandbag mode: highlight valid adjacent non-trench tiles for selected soldier
  if (mode === 'sandbag') {
    const selSb = getSelectedSoldier();
    if (selSb) {
      const trenchSet = new Set((tw().map?.trenches || []).map(t => `${t[0]},${t[1]}`));
      const structSet = new Set([
        ...(tw().machine_guns || []).filter(m => m.hp > 0).map(m => `${m.tile[0]},${m.tile[1]}`),
        ...(tw().mortars || []).filter(m => m.hp > 0).map(m => `${m.tile[0]},${m.tile[1]}`),
        ...(tw().sandbags || []).filter(s => s.hp > 0).map(s => `${s.tile[0]},${s.tile[1]}`),
      ]);
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          if (dx === 0 && dy === 0) continue;
          const ax = selSb.tile[0] + dx, ay = selSb.tile[1] + dy;
          if (ax < 0 || ay < 0 || ax >= tw().map.width || ay >= tw().map.height) continue;
          if (trenchSet.has(`${ax},${ay}`) || structSet.has(`${ax},${ay}`)) continue;
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
    const grenRange = tw()?.rules?.grenade_range ?? GRENADIER_RANGE;
    const effectiveRange = selSoldier.is_grenadier ? grenRange : (selSoldier.range ?? RIFLE_RANGE);
    drawRangeCircle(cpx(selSoldier.x), cpy(selSoldier.y), effectiveRange * CELL, 'rgba(255,180,50,0.8)');
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
    ctx.arc(pmcx, pmcy, MG_RANGE * CELL, previewAngle - arcHalfRad, previewAngle + arcHalfRad);
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
        // Range arc for selected MG (pinned to arc_center)
        ctx.strokeStyle = 'rgba(255,220,80,0.75)';
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.arc(mcx, mcy, MG_RANGE * CELL, arcVa - arcHalfRad, arcVa + arcHalfRad);
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

    // Force-fire target line
    if (mg.force_target) {
      const [fx, fy] = mg.force_target;
      ctx.strokeStyle = '#ff6767';
      ctx.lineWidth = 2;
      ctx.strokeRect(OX + fx * CELL + 2, tileTop(fy) + 2, CELL - 4, CELL - 4);
      ctx.strokeStyle = 'rgba(255,100,100,0.4)';
      ctx.setLineDash([3, 3]);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(mcx, mcy);
      ctx.lineTo(cpx(fx), cpy(fy));
      ctx.stroke();
      ctx.setLineDash([]);
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
    const scx = cpx(s.x);
    const scy = cpy(s.y);
    const onBunker = bunkerTileSet.has(`${Math.round(s.x)},${Math.round(s.y)}`);
    if (onBunker) ctx.globalAlpha = 0.5;

    // Firing flash halo
    if (s.rifle_cooldown > 2.5) {
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
    } else {
      if (s.is_grenadier) ctx.fillStyle = s.owner === 0 ? '#ff9f1a' : '#1fc7b6';
      else ctx.fillStyle = s.owner === 0 ? '#e83030' : '#3d6cdf';
      ctx.beginPath();
      ctx.arc(scx, scy, 6, 0, Math.PI * 2);
      ctx.fill();
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
      const previewScatterR = 3 + Math.max(0, Math.floor(Math.max(0, dTiles - 10) / 5));
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
      const buildScatterR = 3 + Math.max(0, Math.floor(Math.max(0, buildDist - 10) / 5));
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
        const previewScatterR = 3 + Math.max(0, Math.floor(Math.max(0, dPixels / CELL - 10) / 5));
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
        const tgtScatterR = 3 + Math.max(0, Math.floor(Math.max(0, tgtDist - 10) / 5));
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
      const cdFrac = 1 - mortar.cooldown / 20;
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
      ctx.fillStyle = ms.owner === 0 ? '#e05020' : '#5050e0';
      ctx.beginPath();
      ctx.arc(sx, sy - arcHeight * CELL * 0.8, radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
    }
  }

  // Grenade shells — dead-reckoned
  {
    const elapsed = (performance.now() - lastStateTime) / 1000;
    for (const gs of data.grenade_shells || []) {
      const ddx = gs.target[0] - gs.x, ddy = gs.target[1] - gs.y;
      const nd = Math.hypot(ddx, ddy);
      const advance = nd > 0 ? Math.min(nd, 5.0 * elapsed) : 0;
      const ex = gs.x + (nd > 0 ? (ddx / nd) * advance : 0);
      const ey = gs.y + (nd > 0 ? (ddy / nd) * advance : 0);
      const gx = cpx(ex), gy = cpy(ey);
      ctx.fillStyle = '#9ad26d';
      ctx.beginPath();
      ctx.arc(gx, gy, 3, 0, Math.PI * 2);
      ctx.fill();
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

  // Planned grenade targets
  for (const gt of data.grenade_targets || []) {
    const [gx, gy] = gt;
    const gty = tileTop(gy);
    ctx.strokeStyle = 'rgba(154,210,109,0.95)';
    ctx.lineWidth = 2;
    ctx.setLineDash([3, 2]);
    ctx.strokeRect(OX + gx * CELL + 2, gty + 2, CELL - 4, CELL - 4);
    ctx.setLineDash([]);
    ctx.lineWidth = 1;
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

  // Projectiles — dead-reckoned using dx/dy velocity from server
  {
    const elapsed = (performance.now() - lastStateTime) / 1000;
    const projSpeed = data.rules?.projectile_speed ?? 8.0;
    for (const p of data.projectiles || []) {
      const norm = Math.hypot(p.dx ?? 0, p.dy ?? 0);
      const ex = norm > 0 ? p.x + (p.dx / norm) * projSpeed * elapsed : p.x;
      const ey = norm > 0 ? p.y + (p.dy / norm) * projSpeed * elapsed : p.y;
      const pcx = cpx(ex);
      const pcy = cpy(ey);
      ctx.fillStyle = p.source === 'mg' ? '#ffd34d' : 'rgba(255,255,255,0.9)';
      ctx.beginPath();
      ctx.arc(pcx, pcy, p.source === 'mg' ? 2.5 : 1.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // Muzzle flashes
  for (const mf of data.muzzle_flashes || []) {
    const t = mf.age / mf.duration;
    const alpha = (1 - t) * 0.95;
    const norm = Math.hypot(mf.dx ?? 0, mf.dy ?? 0);
    const fx = cpx(mf.x);
    const fy = cpy(mf.y);
    const dirX = norm > 0 ? mf.dx / norm : 1;
    const dirY = norm > 0 ? mf.dy / norm : 0;
    ctx.save();
    ctx.globalAlpha = alpha;
    // Bright core circle
    const coreR = 4.5 * (1 - t * 0.5);
    const grad = ctx.createRadialGradient(fx, fy, 0, fx, fy, coreR * 2);
    grad.addColorStop(0, '#ffffc0');
    grad.addColorStop(0.4, '#ffcc44');
    grad.addColorStop(1, 'rgba(255,140,0,0)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(fx, fy, coreR * 2, 0, Math.PI * 2);
    ctx.fill();
    // Short directional streak
    const streakLen = 9 * (1 - t);
    ctx.strokeStyle = 'rgba(255,245,180,0.85)';
    ctx.lineWidth = 2;
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

  // Smoke particles from mortar/grenade impacts
  if (smokeParticles.length) {
    ctx.save();
    for (const p of smokeParticles) {
      const t = p.age / p.maxAge;
      const a = p.alpha * (1 - t * t);
      if (a < 0.015) continue;
      const r = p.r * CELL * (1 + t * 1.8);
      ctx.globalAlpha = a * 0.7;
      ctx.fillStyle = '#b8a898';
      ctx.beginPath();
      ctx.arc(cpx(p.x), cpy(p.y), r, 0, Math.PI * 2);
      ctx.fill();
    }
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
}

// === SELECTION PANEL ===

function setMortarRound(roundType) {
  if (selectedMortar === null) return;
  send({ type: 'tw_set_mortar_round', mortar_id: selectedMortar, round_type: roundType });
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
    const ffTag = mg.force_target ? '<span class="sel-blocked">Force-fire active</span>' : '';
    html = `
      <div class="sel-grid">
        <span class="sel-label">Side</span><span class="sel-val">${side}</span>
        <span class="sel-label">HP</span><span class="sel-val">${hp}%</span>
        <span class="sel-label">Built</span><span class="sel-val">${mg.built ? 'Yes' : 'No'}</span>
        <span class="sel-label">Crew</span><span class="sel-val">${ops}/1</span>
      </div>${ffTag}`;
  } else if (mortar) {
    const side = mortar.owner === 0 ? 'Red' : 'Blue';
    const hp = Math.round((mortar.hp / (mortar.hp_max || 10)) * 100);
    const ops = (mortar.operators || []).length;
    const stateStr = !mortar.built ? `Building ${Math.round((mortar.build_progress / (mortar.build_required || 60)) * 100)}%`
      : mortar.ready ? '<span style="color:#f4a020">READY — click to fire</span>'
      : `Reloading ${mortar.cooldown.toFixed(1)}s`;
    const tgt = mortar.target ? `(${mortar.target[0]}, ${mortar.target[1]})` : '—';
    const operableTag = mortar.operable === false ? '<span class="sel-blocked">Inoperable: restore 3×3 ground</span>' : '';
    const isAirburst = mortar.round_type === 'airburst';
    const ammoRow = mortar.built && mortar.owner === mySeat() ? `
      <div class="sel-ammo-btns">
        <button class="sel-ammo-btn${!isAirburst ? ' active' : ''}" onclick="setMortarRound('he')">HE</button>
        <button class="sel-ammo-btn${isAirburst ? ' active' : ''}" onclick="setMortarRound('airburst')">Airburst</button>
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

// === RENDER ===

function render() {
  if (!state) return;
  draw();
  updateSelectionPanel();

  if (state.status === 'open') {
    setStatus('Waiting for opponent…');
  } else if (state.winner !== null && state.winner !== undefined) {
    const msg = state.winner_name
      ? `${state.winner_name} wins — ${state.win_reason || ''}`
      : (state.win_reason || 'Game over.');
    setStatus(msg);
  } else if (mode === 'move') {
    if (!selectedUnits.size) setStatus('Move — click soldiers to select, then click a destination tile.');
    else setStatus(`Move — ${selectedUnits.size} selected. Click any tile to move.`);
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
  } else if (mode === 'grenade') {
    setStatus('Grenade — click tiles to toggle grenade targets (range 7 from grenadiers).');
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
  ['mode-dig','dig'], ['mode-plan','plan'], ['mode-build','build'], ['mode-operate','operate'], ['mode-mortar','mortar'], ['mode-grenade','grenade'], ['mode-sandbag','sandbag'], ['mode-wire','wire'], ['mode-bunker','bunker'], ['mode-flare','flare'],
].forEach(([id, m]) => {
  const btn = el(id);
  if (btn) btn.addEventListener('click', (evt) => { evt.stopPropagation(); setMode(m); render(); });
});

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

function updateSmoke() {
  const now = performance.now();
  const dt = Math.min(0.1, (now - lastSmokeTick) / 1000);
  lastSmokeTick = now;
  for (const p of smokeParticles) {
    p.vx += 0.9 * dt;   // eastward wind
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.vx *= 1 - 3 * dt;
    p.vy *= 1 - 2 * dt;
    p.age += dt;
  }
  smokeParticles = smokeParticles.filter(p => p.age < p.maxAge);
}

(function rafLoop() {
  updateSmoke();
  if (state) render();
  requestAnimationFrame(rafLoop);
})();
updateModeButtons();
updateModeLabel();
