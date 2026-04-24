const gameId = window.TOPOS_GAME_ID;
const playerKey = new URLSearchParams(window.location.search).get('player') || '';
const board = document.getElementById('board');
const ctx = board.getContext('2d');

let ws = null;
let state = null;
let mode = 'select';
let selectedUnit = null;
let selectedMg = null;
let plan = [];

function el(id) { return document.getElementById(id); }
function wsUrl() { const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'; return `${proto}//${location.host}/ws/game/${encodeURIComponent(gameId)}?player=${encodeURIComponent(playerKey)}`; }
function send(payload) { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload)); }
function setStatus(msg, bad = false) { el('status-line').textContent = msg || ''; el('status-line').style.color = bad ? '#ff9a9a' : ''; }

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

function cellFromEvent(evt) {
  if (!tw()) return null;
  const rect = board.getBoundingClientRect();
  const x = evt.clientX - rect.left;
  const y = evt.clientY - rect.top;
  const cell = 24;
  const ox = 20;
  const oy = 20;
  const tx = Math.floor((x - ox) / cell);
  const ty = Math.floor((y - oy) / cell);
  if (tx < 0 || ty < 0 || tx >= tw().map.width || ty >= tw().map.height) return null;
  return [tx, ty];
}

function soldiersAt(tile) {
  return (tw()?.soldiers || []).filter(s => s.tile[0] === tile[0] && s.tile[1] === tile[1]);
}

function mgAt(tile) {
  return (tw()?.machine_guns || []).find(m => m.tile[0] === tile[0] && m.tile[1] === tile[1]) || null;
}

board.addEventListener('click', (evt) => {
  if (!tw()) return;
  const tile = cellFromEvent(evt);
  if (!tile) return;
  const mineSoldier = soldiersAt(tile).find(s => s.owner === mySeat());
  const mineMg = (mgAt(tile) && mgAt(tile).owner === mySeat()) ? mgAt(tile) : null;

  if (mode === 'select') {
    selectedUnit = mineSoldier?.unit_id || null;
    selectedMg = mineMg?.structure_id || null;
  } else if (mode === 'attack' || mode === 'sentry') {
    if (selectedUnit) send({ type: 'tw_order_mode', unit_ids: [selectedUnit], mode: mode });
  } else if (mode === 'dig') {
    if (mineSoldier) selectedUnit = mineSoldier.unit_id;
    else if (selectedUnit) send({ type: 'tw_assign_dig', unit_id: selectedUnit, plan: [tile] });
  } else if (mode === 'plan') {
    if (mineSoldier) {
      selectedUnit = mineSoldier.unit_id;
      if (plan.length) send({ type: 'tw_assign_dig', unit_id: selectedUnit, plan });
      plan = [];
    } else {
      if (!plan.length || Math.abs(plan[plan.length - 1][0] - tile[0]) + Math.abs(plan[plan.length - 1][1] - tile[1]) === 1) plan.push(tile);
    }
  } else if (mode === 'build') {
    const helpers = (tw().soldiers || []).filter(s => s.owner === mySeat()).slice(0, 2).map(s => s.unit_id);
    send({ type: 'tw_assign_build_mg', unit_ids: helpers, tile });
  } else if (mode === 'operate') {
    if (mineMg) {
      selectedMg = mineMg.structure_id;
      const ops = (tw().soldiers || []).filter(s => s.owner === mySeat()).slice(0, 2).map(s => s.unit_id);
      send({ type: 'tw_toggle_operate_mg', mg_id: selectedMg, unit_ids: ops });
    } else if (selectedMg) {
      send({ type: 'tw_force_fire', mg_id: selectedMg, tile });
    }
  }
});

function draw() {
  if (!tw()) return;
  const data = tw();
  const cell = 24, ox = 20, oy = 20;
  board.width = ox * 2 + data.map.width * cell;
  board.height = oy * 2 + data.map.height * cell;
  ctx.fillStyle = '#1a1e28';
  ctx.fillRect(0, 0, board.width, board.height);
  for (let y = 0; y < data.map.height; y++) for (let x = 0; x < data.map.width; x++) {
    ctx.fillStyle = '#445a48';
    ctx.fillRect(ox + x * cell, oy + y * cell, cell - 1, cell - 1);
  }
  for (const t of data.map.trenches) {
    ctx.fillStyle = '#2e2a24';
    ctx.fillRect(ox + t[0] * cell, oy + t[1] * cell, cell - 1, cell - 1);
  }
  for (const mg of data.machine_guns || []) {
    const [x, y] = mg.tile;
    ctx.fillStyle = mg.owner === 0 ? '#a31717' : '#2a5cd4';
    ctx.fillRect(ox + x * cell + 4, oy + y * cell + 4, cell - 8, cell - 8);
    ctx.fillStyle = '#111';
    ctx.fillRect(ox + x * cell + 2, oy + y * cell - 4, cell - 4, 3);
    ctx.fillStyle = '#65e06f';
    ctx.fillRect(ox + x * cell + 2, oy + y * cell - 4, (cell - 4) * (mg.hp / mg.hp_max), 3);
    if (!mg.built) {
      ctx.fillStyle = '#333';
      ctx.fillRect(ox + x * cell + 2, oy + y * cell + cell + 1, cell - 4, 3);
      ctx.fillStyle = '#f4c84e';
      ctx.fillRect(ox + x * cell + 2, oy + y * cell + cell + 1, (cell - 4) * (mg.build_progress / mg.build_required), 3);
    }
    if (mg.force_target) {
      ctx.strokeStyle = '#ff6767';
      ctx.strokeRect(ox + mg.force_target[0] * cell + 2, oy + mg.force_target[1] * cell + 2, cell - 4, cell - 4);
    }
  }
  for (const s of data.soldiers || []) {
    ctx.fillStyle = s.owner === 0 ? '#ff2f2f' : '#4b80ff';
    ctx.beginPath();
    ctx.arc(ox + (s.x + 0.5) * cell - cell / 2, oy + (s.y + 0.5) * cell - cell / 2, 6, 0, Math.PI * 2);
    ctx.fill();
    if (s.unit_id === selectedUnit) {
      ctx.strokeStyle = '#fff';
      ctx.strokeRect(ox + s.tile[0] * cell + 2, oy + s.tile[1] * cell + 2, cell - 4, cell - 4);
    }
    if (s.blocked) { ctx.fillStyle = '#fff'; ctx.fillText('...', ox + s.tile[0] * cell + 6, oy + s.tile[1] * cell - 2); }
    if (s.task && (s.task.type === 'dig' || s.task.type === 'build_mg')) {
      const p = Math.max(0, Math.min(1, (s.task.progress || 0) / (data.rules.dig_seconds_per_tile || 5)));
      ctx.fillStyle = '#000'; ctx.fillRect(ox + s.tile[0] * cell + 2, oy + s.tile[1] * cell + cell - 4, cell - 4, 3);
      ctx.fillStyle = '#f4c84e'; ctx.fillRect(ox + s.tile[0] * cell + 2, oy + s.tile[1] * cell + cell - 4, (cell - 4) * p, 3);
    }
  }
  for (const p of data.projectiles || []) {
    ctx.fillStyle = p.source === 'mg' ? '#ffd34d' : '#fff';
    ctx.fillRect(ox + p.x * cell, oy + p.y * cell, 2, 2);
  }
  if (plan.length) {
    ctx.strokeStyle = '#f4c84e';
    ctx.beginPath();
    plan.forEach((t, i) => { const px = ox + t[0] * cell + cell / 2; const py = oy + t[1] * cell + cell / 2; if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py); });
    ctx.stroke();
  }
}

function render() {
  if (!state) return;
  draw();
  el('mode-line').textContent = ({ select: 'Select', dig: 'Dig', plan: 'Plan Dig', build: 'Build MG', operate: 'Operate MG', attack: 'Attack', sentry: 'Sentry' }[mode] || 'Select');
  el('seat-line').textContent = mySeat() === null ? 'Spectator' : (mySeat() === 0 ? 'Red' : 'Blue');
  const remaining = Math.max(0, Math.floor(tw().time_remaining || 0));
  el('clock-line').textContent = `${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, '0')}`;
  el('kills0').textContent = String(tw().kill_counts?.['0'] || 0);
  el('kills1').textContent = String(tw().kill_counts?.['1'] || 0);
  el('log').innerHTML = (state.log || []).slice(-16).map(m => `<div>${m}</div>`).join('');
  if (state.winner_name || state.win_reason) setStatus(state.winner_name ? `${state.winner_name} wins. ${state.win_reason || ''}` : (state.win_reason || 'Game over.'));
}

[['mode-select','select'],['mode-dig','dig'],['mode-plan','plan'],['mode-build','build'],['mode-operate','operate'],['mode-attack','attack'],['mode-sentry','sentry']].forEach(([id,m]) => {
  el(id).addEventListener('click', () => { mode = m; render(); });
});
el('cancel-task').addEventListener('click', () => { if (selectedUnit) send({ type: 'tw_cancel_task', unit_id: selectedUnit }); });
el('resign').addEventListener('click', () => send({ type: 'resign' }));

connect();
setInterval(() => send({ type: 'ping' }), 200);
setInterval(render, 100);
