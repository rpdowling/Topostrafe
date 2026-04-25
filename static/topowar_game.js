// === GLOBALS ===
const gameId = window.TOPOS_GAME_ID;
const playerKey = new URLSearchParams(window.location.search).get('player') || '';
const board = document.getElementById('board');
const ctx = board.getContext('2d');

let ws = null;
let state = null;
let mode = 'select';
let selectedUnits = new Set();
let selectedMg = null;
let plan = [];
let pendingBuildTile = null;

const CELL = 24;
const OX = 20;
const OY = 20;
const RIFLE_RANGE = 5;
const MG_RANGE = 20;

function el(id) { return document.getElementById(id); }
function wsUrl() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/ws/game/${encodeURIComponent(gameId)}?player=${encodeURIComponent(playerKey)}`;
}
function send(payload) { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload)); }
function setStatus(msg, bad = false) {
  const e = el('status-line');
  if (!e) return;
  e.textContent = msg || '';
  e.style.color = bad ? '#ff9a9a' : '';
}

function connect() {
  ws = new WebSocket(wsUrl());
  ws.onopen = () => setStatus('Connected.');
  ws.onmessage = (evt) => {
    const payload = JSON.parse(evt.data);
    if (payload.type === 'state') {
      if (payload.message && state) state.log = [...(state.log || []), payload.message].slice(-20);
      state = payload.state;
      render();
    } else if (payload.type === 'error') {
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
  const tx = Math.floor((px - OX) / CELL);
  const ty = Math.floor((py - OY) / CELL);
  if (tx < 0 || ty < 0 || tx >= tw().map.width || ty >= tw().map.height) return null;
  return [tx, ty];
}

function soldiersAt(tile) {
  return (tw()?.soldiers || []).filter(s => s.tile[0] === tile[0] && s.tile[1] === tile[1]);
}
function mySoldiersAt(tile) { return soldiersAt(tile).filter(s => s.owner === mySeat()); }
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

// === MODE MANAGEMENT ===

function updateModeButtons() {
  const modes = ['select','attack','sentry','defend','dig','plan','build','operate'];
  for (const m of modes) {
    const btn = el('mode-' + m);
    if (btn) btn.classList.toggle('active', mode === m);
  }
}

function setMode(m) {
  if (mode === m) {
    mode = 'select';
    plan = [];
    pendingBuildTile = null;
  } else {
    mode = m;
    if (m !== 'plan') plan = [];
    if (m !== 'build') pendingBuildTile = null;
    if (m === 'build') selectedUnits = new Set();
  }
  updateModeButtons();
  updateModeLabel();
  if (mode === 'build') refreshBuildStatus();
}

function updateModeLabel() {
  const labels = {
    select: 'Select', attack: 'Attack', sentry: 'Sentry', defend: 'Defend',
    dig: 'Dig', plan: 'Plan Dig', build: 'Build MG', operate: 'Crew MG',
  };
  const e = el('mode-line');
  if (e) e.textContent = labels[mode] || 'Select';
}

function refreshBuildStatus() {
  if (mode !== 'build') return;
  if (!pendingBuildTile) {
    setStatus('Build MG: click an MG tile next to trench, then pick 2 soldiers.');
    return;
  }
  setStatus(`Build MG @ (${pendingBuildTile[0]},${pendingBuildTile[1]}): select ${Math.max(0, 2 - selectedUnits.size)} more soldier(s).`);
}

// === KEYBOARD SHORTCUTS ===

document.addEventListener('keydown', (evt) => {
  if (evt.target.tagName === 'INPUT' || evt.target.tagName === 'TEXTAREA') return;
  const key = evt.key.toUpperCase();

  if (evt.key === 'Escape') {
    plan = [];
    pendingBuildTile = null;
    selectedUnits = new Set();
    selectedMg = null;
    setMode('select');
    render();
    return;
  }

  const shortcutMap = { '1':'select','2':'attack','3':'sentry','4':'defend','D':'dig','P':'plan','B':'build','O':'operate' };
  if (shortcutMap[key]) {
    evt.preventDefault();
    if (['2','3','4'].includes(key) && mode === shortcutMap[key] && selectedUnits.size) {
      send({ type: 'tw_order_mode', unit_ids: [...selectedUnits], mode });
    }
    setMode(shortcutMap[key]);
    render();
    return;
  }

  if (key === 'C') {
    evt.preventDefault();
    for (const uid of selectedUnits) send({ type: 'tw_cancel_task', unit_id: uid });
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

  if (mode === 'select') {
    if (myS.length) {
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

  } else if (mode === 'attack' || mode === 'sentry' || mode === 'defend') {
    if (myS.length) {
      const uid = myS[0].unit_id;
      if (evt.ctrlKey || evt.shiftKey) selectedUnits.add(uid);
      else selectedUnits = new Set([uid]);
    }
    if (selectedUnits.size) send({ type: 'tw_order_mode', unit_ids: [...selectedUnits], mode });

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
    if (myS.length) {
      const uid = myS[0].unit_id;
      if (selectedUnits.has(uid)) selectedUnits.delete(uid);
      else {
        if (selectedUnits.size >= 2) selectedUnits = new Set();
        selectedUnits.add(uid);
      }
      refreshBuildStatus();
      if (pendingBuildTile && selectedUnits.size === 2) {
        send({ type: 'tw_assign_build_mg', unit_ids: [...selectedUnits], tile: pendingBuildTile });
        pendingBuildTile = null;
        selectedUnits = new Set();
      }
    } else {
      pendingBuildTile = tile;
      refreshBuildStatus();
      if (selectedUnits.size === 2) {
        send({ type: 'tw_assign_build_mg', unit_ids: [...selectedUnits], tile: pendingBuildTile });
        pendingBuildTile = null;
        selectedUnits = new Set();
      }
    }

  } else if (mode === 'operate') {
    if (myMg) {
      selectedMg = myMg.structure_id;
      const ops = (tw().soldiers || [])
        .filter(s => s.owner === mySeat())
        .sort((a, b) => Math.hypot(a.tile[0]-myMg.tile[0],a.tile[1]-myMg.tile[1]) - Math.hypot(b.tile[0]-myMg.tile[0],b.tile[1]-myMg.tile[1]))
        .slice(0, 2).map(s => s.unit_id);
      send({ type: 'tw_toggle_operate_mg', mg_id: selectedMg, unit_ids: ops });
    } else if (selectedMg !== null) {
      send({ type: 'tw_force_fire', mg_id: selectedMg, tile });
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
  if (myMg) send({ type: 'tw_force_fire', mg_id: myMg.structure_id, tile: null });
});

// === DRAW ===

function cpx(gx) { return OX + gx * CELL + CELL / 2; }
function cpy(gy) { return OY + gy * CELL + CELL / 2; }

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

function draw() {
  const data = tw();
  if (!data) return;

  board.width  = OX * 2 + data.map.width  * CELL;
  board.height = OY * 2 + data.map.height * CELL;

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
      if (i === 0) ctx.moveTo(cpx(t[0]), cpy(t[1]));
      else ctx.lineTo(cpx(t[0]), cpy(t[1]));
    });
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.lineWidth = 1;
    ctx.fillStyle = 'rgba(244,200,78,0.18)';
    for (const t of plan) ctx.fillRect(OX + t[0] * CELL, OY + t[1] * CELL, CELL - 1, CELL - 1);
    ctx.strokeStyle = '#f4c84e';
    ctx.strokeRect(OX + plan[0][0] * CELL + 1, OY + plan[0][1] * CELL + 1, CELL - 3, CELL - 3);
  }

  if (mode === 'build' && pendingBuildTile) {
    const [bx, by] = pendingBuildTile;
    ctx.strokeStyle = '#f4c84e';
    ctx.setLineDash([5, 3]);
    ctx.lineWidth = 2;
    ctx.strokeRect(OX + bx * CELL + 1, OY + by * CELL + 1, CELL - 2, CELL - 2);
    ctx.setLineDash([]);
    ctx.lineWidth = 1;
  }

  // Range circles
  const selSoldier = getSelectedSoldier();
  if (selSoldier) drawRangeCircle(cpx(selSoldier.x), cpy(selSoldier.y), RIFLE_RANGE * CELL, 'rgba(255,180,50,0.8)');
  const selMg = getSelectedMg();
  if (selMg) drawRangeCircle(cpx(selMg.tile[0]), cpy(selMg.tile[1]), MG_RANGE * CELL, 'rgba(255,220,80,0.7)');

  // Machine guns
  for (const mg of data.machine_guns || []) {
    const [mx, my] = mg.tile;
    const tlx = OX + mx * CELL, tly = OY + my * CELL;

    ctx.fillStyle = mg.owner === 0 ? '#8b1515' : '#1a3fa0';
    ctx.fillRect(tlx + 3, tly + 3, CELL - 6, CELL - 6);
    ctx.fillStyle = '#aaa';
    ctx.fillRect(tlx + CELL / 2 - 2, tly + 1, 4, 6);

    if (mg.structure_id === selectedMg) {
      ctx.strokeStyle = '#7aff9e';
      ctx.lineWidth = 2;
      ctx.strokeRect(tlx + 1, tly + 1, CELL - 2, CELL - 2);
      ctx.lineWidth = 1;
    }

    if (mg.force_target) {
      const [fx, fy] = mg.force_target;
      ctx.strokeStyle = '#ff6767';
      ctx.lineWidth = 2;
      ctx.strokeRect(OX + fx * CELL + 2, OY + fy * CELL + 2, CELL - 4, CELL - 4);
      ctx.strokeStyle = 'rgba(255,100,100,0.4)';
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(cpx(mx), cpy(my));
      ctx.lineTo(cpx(fx), cpy(fy));
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.lineWidth = 1;
    }

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
      ctx.fillText('BUILD', tlx + 2, tly + CELL - 2);
    }

    if (mg.built && mg.operator_ids && mg.operator_ids.length) {
      ctx.fillStyle = '#7aff9e';
      ctx.font = 'bold 9px system-ui';
      ctx.fillText(`\xd7${mg.operator_ids.length}`, tlx + CELL - 12, tly + CELL - 2);
    }
  }

  // Soldiers
  for (const s of data.soldiers || []) {
    const scx = OX + s.x * CELL + CELL / 2;
    const scy = OY + s.y * CELL + CELL / 2;

    // Firing flash halo
    if (s.rifle_cooldown > 2.5) {
      ctx.fillStyle = 'rgba(255,255,180,0.4)';
      ctx.beginPath();
      ctx.arc(scx, scy, 10, 0, Math.PI * 2);
      ctx.fill();
    }

    // Body
    ctx.fillStyle = s.owner === 0 ? '#e83030' : '#3d6cdf';
    ctx.beginPath();
    ctx.arc(scx, scy, 6, 0, Math.PI * 2);
    ctx.fill();

    // Mode ring
    const modeRingColor = { attack: '#ffb020', sentry: '#60dfff', defend: '#50d080' };
    if (modeRingColor[s.mode]) {
      ctx.strokeStyle = modeRingColor[s.mode];
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(scx, scy, 8, 0, Math.PI * 2);
      ctx.stroke();
      ctx.lineWidth = 1;
    }

    // Selection box
    if (selectedUnits.has(s.unit_id)) {
      ctx.strokeStyle = '#ffd45a';
      ctx.lineWidth = 2;
      ctx.strokeRect(OX + s.tile[0] * CELL + 1, OY + s.tile[1] * CELL + 1, CELL - 2, CELL - 2);
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
      ctx.fillRect(OX + tx * CELL + 2, OY + ty * CELL + CELL - 5, CELL - 4, 3);
      ctx.fillStyle = '#f4c84e';
      ctx.fillRect(OX + tx * CELL + 2, OY + ty * CELL + CELL - 5, (CELL - 4) * prog, 3);
    }

    // Task label
    if (s.task) {
      const taskLabels = { dig: 'DIG', build_mg: 'BLD', operate_mg: 'CREW' };
      const lbl = taskLabels[s.task.type];
      if (lbl) {
        ctx.fillStyle = 'rgba(255,220,80,0.95)';
        ctx.font = '7px system-ui';
        ctx.textAlign = 'center';
        ctx.fillText(lbl, scx, scy - 9);
        ctx.textAlign = 'left';
      }
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

function updateSelectionPanel() {
  const panel = el('selection-panel');
  if (!panel) return;

  const soldier = getSelectedSoldier();
  const mg = getSelectedMg();

  if (!soldier && !mg) {
    if (selectedUnits.size > 1) {
      const alive = [...selectedUnits].filter(uid => (tw()?.soldiers || []).some(s => s.unit_id === uid));
      panel.innerHTML = `<div class="sel-row"><strong>${alive.length}</strong>&nbsp;soldiers selected</div>`;
      return;
    }
    panel.innerHTML = '<div class="muted">Nothing selected.</div>';
    return;
  }

  if (soldier) {
    const modeLabel = { select: '—', attack: 'Attack', sentry: 'Sentry', defend: 'Defend' };
    const taskLabel = { dig: 'Digging', build_mg: 'Building MG', operate_mg: 'Crewing MG' };
    const side = soldier.owner === 0 ? 'Red' : 'Blue';
    const hp = Math.round((soldier.hp / (soldier.hp_max || 5)) * 100);
    const tsk = soldier.task ? (taskLabel[soldier.task.type] || soldier.task.type) : '—';
    const blockedTag = soldier.blocked ? '<span class="sel-blocked">BLOCKED</span>' : '';
    panel.innerHTML = `
      <div class="sel-grid">
        <span class="sel-label">Side</span><span class="sel-val">${side}</span>
        <span class="sel-label">HP</span><span class="sel-val">${hp}%</span>
        <span class="sel-label">Mode</span><span class="sel-val">${modeLabel[soldier.mode] || soldier.mode}</span>
        <span class="sel-label">Task</span><span class="sel-val">${tsk}</span>
      </div>${blockedTag}`;
    return;
  }

  if (mg) {
    const side = mg.owner === 0 ? 'Red' : 'Blue';
    const hp = Math.round((mg.hp / (mg.hp_max || 20)) * 100);
    const ops = mg.operator_ids ? mg.operator_ids.length : 0;
    const ffTag = mg.force_target ? '<span class="sel-blocked">Force-fire active</span>' : '';
    panel.innerHTML = `
      <div class="sel-grid">
        <span class="sel-label">Side</span><span class="sel-val">${side}</span>
        <span class="sel-label">HP</span><span class="sel-val">${hp}%</span>
        <span class="sel-label">Built</span><span class="sel-val">${mg.built ? 'Yes' : 'No'}</span>
        <span class="sel-label">Crew</span><span class="sel-val">${ops}/2</span>
      </div>${ffTag}`;
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
  } else {
    setStatus('Active.');
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

  const logEl = el('log');
  if (logEl) logEl.innerHTML = (state.log || []).slice(-20).map(m => `<div class="log-entry">${m}</div>`).join('');

  updateModeButtons();
  updateModeLabel();
}

// === BUTTON WIRING ===

[
  ['mode-select','select'], ['mode-attack','attack'], ['mode-sentry','sentry'], ['mode-defend','defend'],
  ['mode-dig','dig'], ['mode-plan','plan'], ['mode-build','build'], ['mode-operate','operate'],
].forEach(([id, m]) => {
  const btn = el(id);
  if (btn) btn.addEventListener('click', (evt) => { evt.stopPropagation(); setMode(m); render(); });
});

el('cancel-task').addEventListener('click', () => {
  for (const uid of selectedUnits) send({ type: 'tw_cancel_task', unit_id: uid });
});

el('resign').addEventListener('click', () => {
  if (confirm('Resign this game?')) send({ type: 'resign' });
});

// === INIT ===

connect();
setInterval(() => send({ type: 'ping' }), 200);
setInterval(render, 100);
updateModeButtons();
updateModeLabel();
