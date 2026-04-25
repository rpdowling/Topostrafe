const gameId = window.TOPOS_GAME_ID;
const playerKey = new URLSearchParams(window.location.search).get('player') || '';
const board = document.getElementById('board');
const ctx = board.getContext('2d');

let ws = null;
let state = null;
let mode = 'select';
// selectedUnits: set of unit_ids belonging to the local player
let selectedUnits = new Set();
let selectedMg = null;
let plan = [];

const CELL = 24;
const OX = 20;
const OY = 20;

function el(id) { return document.getElementById(id); }
function wsUrl() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/ws/game/${encodeURIComponent(gameId)}?player=${encodeURIComponent(playerKey)}`;
}
function send(payload) { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload)); }
function setStatus(msg, bad = false) {
  el('status-line').textContent = msg || '';
  el('status-line').style.color = bad ? '#ff9a9a' : '';
}

function connect() {
  ws = new WebSocket(wsUrl());
  ws.onopen = () => setStatus('Connected.');
  ws.onmessage = (evt) => {
    const payload = JSON.parse(evt.data);
    if (payload.type === 'state') {
      if (payload.message && state) state.log = [...(state.log || []), payload.message].slice(-16);
      state = payload.state;
      render();
    } else if (payload.type === 'error') {
      setStatus(payload.message || 'Error', true);
    }
  };
  ws.onclose = () => { setStatus('Disconnected. Reconnecting…', true); setTimeout(connect, 1200); };
}

function mySeat() { return state?.my_seat; }
function tw() { return state?.topowar || null; }

// Convert canvas pixel to grid tile
function tileFromEvent(evt) {
  if (!tw()) return null;
  const rect = board.getBoundingClientRect();
  const px = (evt.clientX - rect.left) * (board.width / rect.width);
  const py = (evt.clientY - rect.top) * (board.height / rect.height);
  const tx = Math.floor((px - OX) / CELL);
  const ty = Math.floor((py - OY) / CELL);
  if (tx < 0 || ty < 0 || tx >= tw().map.width || ty >= tw().map.height) return null;
  return [tx, ty];
}

function soldiersAt(tile) {
  return (tw()?.soldiers || []).filter(s => s.tile[0] === tile[0] && s.tile[1] === tile[1]);
}
function mySoldiersAt(tile) {
  return soldiersAt(tile).filter(s => s.owner === mySeat());
}
function mgAt(tile) {
  return (tw()?.machine_guns || []).find(m => m.tile[0] === tile[0] && m.tile[1] === tile[1]) || null;
}
function myMgAt(tile) {
  const mg = mgAt(tile);
  return (mg && mg.owner === mySeat()) ? mg : null;
}
function firstSelected() {
  // Return first selected unit_id still alive
  for (const uid of selectedUnits) {
    const s = (tw()?.soldiers || []).find(s => s.unit_id === uid);
    if (s) return uid;
  }
  return null;
}

// Set which mode button is visually active
function updateModeButtons() {
  const modeMap = {
    'select': 'mode-select', 'dig': 'mode-dig', 'plan': 'mode-plan',
    'build': 'mode-build', 'operate': 'mode-operate',
    'attack': 'mode-attack', 'sentry': 'mode-sentry',
  };
  for (const [m, id] of Object.entries(modeMap)) {
    const btn = el(id);
    if (btn) btn.classList.toggle('active', mode === m);
  }
}

function setMode(m) {
  if (mode === m) { mode = 'select'; plan = []; } // toggle off
  else { mode = m; if (m !== 'plan') plan = []; }
  updateModeButtons();
  updateModeLabel();
}

function updateModeLabel() {
  const labels = {
    select: 'Select unit or MG',
    dig: 'Select soldier, then click tile to dig',
    plan: 'Draw dig plan, then click soldier to assign',
    build: 'Click tile to place MG (must be adj. to trench)',
    operate: 'Click MG to assign operators, then click tile to force-fire',
    attack: 'Click soldier(s) to order Attack',
    sentry: 'Click soldier(s) to order Sentry',
  };
  el('mode-line').textContent = labels[mode] || 'Select';
}

board.addEventListener('click', (evt) => {
  if (!tw() || mySeat() === null) return;
  if (state.status !== 'active') return;
  const tile = tileFromEvent(evt);
  if (!tile) return;

  const myS = mySoldiersAt(tile);
  const myMg = myMgAt(tile);

  if (mode === 'select') {
    if (myS.length) {
      // Toggle individual selection; Ctrl/Shift adds to selection
      const uid = myS[0].unit_id;
      if (evt.ctrlKey || evt.shiftKey) {
        if (selectedUnits.has(uid)) selectedUnits.delete(uid);
        else selectedUnits.add(uid);
      } else {
        selectedUnits = new Set([uid]);
      }
      selectedMg = null;
    } else if (myMg) {
      selectedMg = myMg.structure_id;
      selectedUnits = new Set();
    } else {
      selectedUnits = new Set();
      selectedMg = null;
    }

  } else if (mode === 'attack' || mode === 'sentry') {
    if (myS.length) {
      const uid = myS[0].unit_id;
      if (evt.ctrlKey || evt.shiftKey) selectedUnits.add(uid);
      else selectedUnits = new Set([uid]);
    }
    if (selectedUnits.size) {
      send({ type: 'tw_order_mode', unit_ids: [...selectedUnits], mode });
    }

  } else if (mode === 'dig') {
    if (myS.length) {
      // Click soldier = select it
      selectedUnits = new Set([myS[0].unit_id]);
    } else {
      const uid = firstSelected();
      if (uid !== null) {
        send({ type: 'tw_assign_dig', unit_id: uid, plan: [tile] });
      }
    }

  } else if (mode === 'plan') {
    if (myS.length) {
      // Click soldier = assign current plan
      const uid = myS[0].unit_id;
      selectedUnits = new Set([uid]);
      if (plan.length) {
        send({ type: 'tw_assign_dig', unit_id: uid, plan: [...plan] });
        plan = [];
      }
    } else {
      // Extend the plan (only adjacent tiles)
      const last = plan[plan.length - 1];
      if (!last || (Math.abs(last[0] - tile[0]) + Math.abs(last[1] - tile[1]) === 1)) {
        // Avoid duplicate consecutive tiles
        if (!last || last[0] !== tile[0] || last[1] !== tile[1]) plan.push(tile);
      }
    }

  } else if (mode === 'build') {
    // Pick 2 nearest idle soldiers as helpers
    const helpers = (tw().soldiers || [])
      .filter(s => s.owner === mySeat())
      .sort((a, b) => Math.hypot(a.tile[0]-tile[0], a.tile[1]-tile[1]) - Math.hypot(b.tile[0]-tile[0], b.tile[1]-tile[1]))
      .slice(0, 2)
      .map(s => s.unit_id);
    send({ type: 'tw_assign_build_mg', unit_ids: helpers, tile });

  } else if (mode === 'operate') {
    if (myMg) {
      selectedMg = myMg.structure_id;
      // Assign 2 nearest soldiers as operators
      const ops = (tw().soldiers || [])
        .filter(s => s.owner === mySeat())
        .sort((a, b) => Math.hypot(a.tile[0]-myMg.tile[0], a.tile[1]-myMg.tile[1]) - Math.hypot(b.tile[0]-myMg.tile[0], b.tile[1]-myMg.tile[1]))
        .slice(0, 2)
        .map(s => s.unit_id);
      send({ type: 'tw_toggle_operate_mg', mg_id: selectedMg, unit_ids: ops });
    } else if (selectedMg !== null) {
      // Force-fire at tile
      send({ type: 'tw_force_fire', mg_id: selectedMg, tile });
    }
  }

  render();
});

// Right-click on MG clears force target
board.addEventListener('contextmenu', (evt) => {
  evt.preventDefault();
  if (!tw() || mySeat() === null || state.status !== 'active') return;
  const tile = tileFromEvent(evt);
  if (!tile) return;
  const myMg = myMgAt(tile);
  if (myMg) send({ type: 'tw_force_fire', mg_id: myMg.structure_id, tile: null });
});

// Escape: cancel plan / deselect
document.addEventListener('keydown', (evt) => {
  if (evt.key === 'Escape') {
    plan = [];
    selectedUnits = new Set();
    selectedMg = null;
    setMode('select');
    render();
  }
});

// ── RENDERING ──────────────────────────────────────────────────────────────

function px(gx) { return OX + gx * CELL + CELL / 2; }
function py(gy) { return OY + gy * CELL + CELL / 2; }

function draw() {
  const data = tw();
  if (!data) return;

  board.width  = OX * 2 + data.map.width  * CELL;
  board.height = OY * 2 + data.map.height * CELL;

  // Background
  ctx.fillStyle = '#1a1e28';
  ctx.fillRect(0, 0, board.width, board.height);

  // Ground tiles
  for (let y = 0; y < data.map.height; y++) {
    for (let x = 0; x < data.map.width; x++) {
      ctx.fillStyle = '#445a48';
      ctx.fillRect(OX + x * CELL, OY + y * CELL, CELL - 1, CELL - 1);
    }
  }

  // Trench tiles
  for (const t of data.map.trenches) {
    ctx.fillStyle = '#2e2a24';
    ctx.fillRect(OX + t[0] * CELL, OY + t[1] * CELL, CELL - 1, CELL - 1);
    // Trench cross-hatch
    ctx.strokeStyle = 'rgba(100,80,50,0.35)';
    ctx.lineWidth = 0.5;
    ctx.beginPath();
    ctx.moveTo(OX + t[0] * CELL, OY + t[1] * CELL);
    ctx.lineTo(OX + t[0] * CELL + CELL - 1, OY + t[1] * CELL + CELL - 1);
    ctx.moveTo(OX + t[0] * CELL + CELL - 1, OY + t[1] * CELL);
    ctx.lineTo(OX + t[0] * CELL, OY + t[1] * CELL + CELL - 1);
    ctx.stroke();
    ctx.lineWidth = 1;
  }

  // Dig plan overlay
  if (plan.length) {
    ctx.strokeStyle = '#f4c84e';
    ctx.lineWidth = 2;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    plan.forEach((t, i) => {
      if (i === 0) ctx.moveTo(px(t[0]), py(t[1]));
      else ctx.lineTo(px(t[0]), py(t[1]));
    });
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.lineWidth = 1;
    // Mark each plan tile
    ctx.fillStyle = 'rgba(244,200,78,0.18)';
    for (const t of plan) ctx.fillRect(OX + t[0] * CELL, OY + t[1] * CELL, CELL - 1, CELL - 1);
    // Mark first tile
    ctx.strokeStyle = '#f4c84e';
    ctx.strokeRect(OX + plan[0][0] * CELL + 1, OY + plan[0][1] * CELL + 1, CELL - 3, CELL - 3);
  }

  // Machine guns
  for (const mg of data.machine_guns || []) {
    const [mx, my] = mg.tile;
    const tlx = OX + mx * CELL;
    const tly = OY + my * CELL;

    // Base
    ctx.fillStyle = mg.owner === 0 ? '#8b1515' : '#1a3fa0';
    ctx.fillRect(tlx + 3, tly + 3, CELL - 6, CELL - 6);

    // Gun barrel indicator
    ctx.fillStyle = '#aaa';
    ctx.fillRect(tlx + CELL / 2 - 2, tly + 1, 4, 6);

    // Selection ring
    if (mg.structure_id === selectedMg) {
      ctx.strokeStyle = '#7aff9e';
      ctx.lineWidth = 2;
      ctx.strokeRect(tlx + 1, tly + 1, CELL - 2, CELL - 2);
      ctx.lineWidth = 1;
    }

    // Force-fire target indicator
    if (mg.force_target) {
      const [fx, fy] = mg.force_target;
      ctx.strokeStyle = '#ff6767';
      ctx.lineWidth = 2;
      ctx.strokeRect(OX + fx * CELL + 2, OY + fy * CELL + 2, CELL - 4, CELL - 4);
      // Line from MG to target
      ctx.strokeStyle = 'rgba(255,100,100,0.4)';
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(px(mx), py(my));
      ctx.lineTo(px(fx), py(fy));
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.lineWidth = 1;
    }

    // HP bar
    const hpFrac = mg.hp / (mg.hp_max || 20);
    ctx.fillStyle = '#111';
    ctx.fillRect(tlx + 2, tly - 5, CELL - 4, 3);
    ctx.fillStyle = hpFrac > 0.5 ? '#65e06f' : (hpFrac > 0.25 ? '#f4c84e' : '#e04040');
    ctx.fillRect(tlx + 2, tly - 5, (CELL - 4) * hpFrac, 3);

    // Build-progress bar (below tile)
    if (!mg.built) {
      const bpFrac = mg.build_progress / (mg.build_required || 30);
      ctx.fillStyle = '#222';
      ctx.fillRect(tlx + 2, tly + CELL + 1, CELL - 4, 3);
      ctx.fillStyle = '#f4c84e';
      ctx.fillRect(tlx + 2, tly + CELL + 1, (CELL - 4) * bpFrac, 3);
    }

    // "BUILT" / "Under construction" label
    if (!mg.built) {
      ctx.fillStyle = 'rgba(244,200,78,0.85)';
      ctx.font = '8px system-ui';
      ctx.fillText('BUILD', tlx + 2, tly + CELL - 2);
    }
  }

  // Soldiers
  for (const s of data.soldiers || []) {
    // Center of the soldier's continuous position
    const scx = OX + s.x * CELL + CELL / 2;
    const scy = OY + s.y * CELL + CELL / 2;

    // Body
    ctx.fillStyle = s.owner === 0 ? '#e83030' : '#3d6cdf';
    ctx.beginPath();
    ctx.arc(scx, scy, 6, 0, Math.PI * 2);
    ctx.fill();

    // Mode ring
    if (s.mode === 'attack') {
      ctx.strokeStyle = '#ffb020';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(scx, scy, 8, 0, Math.PI * 2);
      ctx.stroke();
      ctx.lineWidth = 1;
    } else if (s.mode === 'sentry') {
      ctx.strokeStyle = '#60dfff';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(scx, scy, 8, 0, Math.PI * 2);
      ctx.stroke();
      ctx.lineWidth = 1;
    }

    // Selection box (drawn on the tile the soldier currently occupies)
    if (selectedUnits.has(s.unit_id)) {
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(OX + s.tile[0] * CELL + 1, OY + s.tile[1] * CELL + 1, CELL - 2, CELL - 2);
      ctx.lineWidth = 1;
    }

    // Blocked "..." indicator
    if (s.blocked) {
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 9px system-ui';
      ctx.fillText('...', OX + s.tile[0] * CELL + 3, OY + s.tile[1] * CELL - 1);
    }

    // Dig progress bar on target tile
    if (s.task && s.task.type === 'dig' && s.task.target) {
      const [tx, ty] = s.task.target;
      const prog = Math.max(0, Math.min(1, (s.task.progress || 0) / (data.rules.dig_seconds_per_tile || 5)));
      ctx.fillStyle = '#000';
      ctx.fillRect(OX + tx * CELL + 2, OY + ty * CELL + CELL - 5, CELL - 4, 3);
      ctx.fillStyle = '#f4c84e';
      ctx.fillRect(OX + tx * CELL + 2, OY + ty * CELL + CELL - 5, (CELL - 4) * prog, 3);
    }

    // Rifle-firing flash
    if (s.rifle_cooldown > 2.5) {
      ctx.fillStyle = 'rgba(255,255,180,0.55)';
      ctx.beginPath();
      ctx.arc(scx, scy, 9, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // Projectiles
  for (const p of data.projectiles || []) {
    const pcx = OX + p.x * CELL + CELL / 2;
    const pcy = OY + p.y * CELL + CELL / 2;
    ctx.fillStyle = p.source === 'mg' ? '#ffd34d' : 'rgba(255,255,255,0.9)';
    ctx.beginPath();
    ctx.arc(pcx, pcy, p.source === 'mg' ? 2.5 : 1.5, 0, Math.PI * 2);
    ctx.fill();
  }

  // Game-over overlay
  if (state && (state.winner !== null && state.winner !== undefined)) {
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
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

function render() {
  if (!state) return;
  draw();

  // Status line
  if (state.status === 'open') {
    setStatus('Waiting for opponent…');
  } else if (state.winner !== null && state.winner !== undefined) {
    const msg = state.winner_name ? `${state.winner_name} wins — ${state.win_reason || ''}` : (state.win_reason || 'Game over.');
    setStatus(msg);
  } else {
    setStatus('Game active.');
  }

  // Share / join link
  const shareEl = el('share-line');
  if (shareEl) {
    if (state.join_code) shareEl.textContent = `Join code: ${state.join_code}`;
    else shareEl.textContent = `ID: ${state.game_id}`;
  }

  // Seat label
  const seatEl = el('seat-line');
  if (seatEl) seatEl.textContent = mySeat() === null ? 'Spectator' : (mySeat() === 0 ? 'Red' : 'Blue');

  // Clock
  const remaining = Math.max(0, Math.floor((tw()?.time_remaining) || 0));
  const clockEl = el('clock-line');
  if (clockEl) clockEl.textContent = `${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, '0')}`;

  // Kill counts
  const k = tw()?.kill_counts || {};
  const k0 = el('kills0'), k1 = el('kills1');
  if (k0) k0.textContent = String(k['0'] || 0);
  if (k1) k1.textContent = String(k['1'] || 0);

  // Log
  const logEl = el('log');
  if (logEl) logEl.innerHTML = (state.log || []).slice(-16).map(m => `<div class="log-entry">${m}</div>`).join('');

  updateModeButtons();
  updateModeLabel();
}

// ── BUTTON WIRING ──────────────────────────────────────────────────────────

[
  ['mode-select', 'select'],
  ['mode-dig', 'dig'],
  ['mode-plan', 'plan'],
  ['mode-build', 'build'],
  ['mode-operate', 'operate'],
  ['mode-attack', 'attack'],
  ['mode-sentry', 'sentry'],
].forEach(([id, m]) => {
  const btn = el(id);
  if (btn) btn.addEventListener('click', (evt) => { evt.stopPropagation(); setMode(m); render(); });
});

el('cancel-task').addEventListener('click', () => {
  const uid = firstSelected();
  if (uid !== null) send({ type: 'tw_cancel_task', unit_id: uid });
});

el('resign').addEventListener('click', () => {
  if (confirm('Resign this game?')) send({ type: 'resign' });
});

// ── INIT ───────────────────────────────────────────────────────────────────

connect();
setInterval(() => send({ type: 'ping' }), 200);
setInterval(render, 100);
updateModeButtons();
updateModeLabel();
