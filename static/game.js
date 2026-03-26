const gameId = window.TOPOS_GAME_ID;
const params = new URLSearchParams(window.location.search);
const playerKey = params.get('player') || '';
const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
const ELEVATION_COLORS = {1:'#d73027',2:'#fc8d59',3:'#fee08b',4:'#91cf60',5:'#4575b4'};
const PLAYER_COLORS = {0:'#ff00ff',1:'#ffffff'};
const PLAYER_OUTLINES = {0:'#2b0030',1:'#000000'};

let ws = null;
let latestState = null;
let latestMessage = '';
let mode = 'routes';
let activeRoute = [];
let pendingRoutes = [];
let pendingDestination = null;
let entrenchSource = null;
let reconnectTimer = null;
let pingTimer = null;
let boardGeom = {cell: 20, ox: 10, oy: 10};

const canvas = document.getElementById('board');
const ctx = canvas.getContext('2d');

function el(id) { return document.getElementById(id); }
function sameCell(a, b) { return a && b && a[0] === b[0] && a[1] === b[1]; }
function orthAdj(a, b) { return Math.abs(a[0]-b[0]) + Math.abs(a[1]-b[1]) === 1; }
function diagAdj(a, b) { return a && b && a[0] !== b[0] || a[1] !== b[1] ? Math.max(Math.abs(a[0]-b[0]), Math.abs(a[1]-b[1])) === 1 : false; }

function formatClock(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0 ? `${h}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}` : `${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`;
}

function setMode(next) {
  mode = next;
  for (const id of ['mode-routes', 'mode-entrench', 'mode-fortify']) {
    el(id).classList.toggle('active', id === `mode-${next}`);
  }
  if (mode !== 'entrench') entrenchSource = null;
  updateDraftLine();
  draw();
}

function isMyTurn() {
  return latestState && latestState.status === 'active' && latestState.my_seat !== null && latestState.my_seat === latestState.current_owner && latestState.winner === null;
}

function nodeAt(cell) {
  if (!latestState) return null;
  return latestState.nodes.find(n => n.x === cell[0] && n.y === cell[1]) || null;
}

function roadTouchesCell(cell) {
  if (!latestState) return false;
  return latestState.roads.some(r => r.path.some(p => p[0] === cell[0] && p[1] === cell[1]));
}

function send(payload) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify(payload));
}

function clearDraft() {
  activeRoute = [];
  pendingRoutes = [];
  pendingDestination = null;
  entrenchSource = null;
  updateDraftLine();
  draw();
}

function finishRoute() {
  if (activeRoute.length < 2) return;
  const dest = activeRoute[activeRoute.length - 1];
  if (pendingDestination && !sameCell(dest, pendingDestination)) {
    latestMessage = 'All routes this turn must end at the same node.';
    renderStatus();
    return;
  }
  pendingRoutes.push(activeRoute.map(p => [p[0], p[1]]));
  pendingDestination = pendingDestination || [dest[0], dest[1]];
  activeRoute = [];
  updateDraftLine();
  draw();
}

function commitRoutes() {
  if (activeRoute.length >= 2) finishRoute();
  if (!pendingRoutes.length) return;
  send({ type: 'routes', routes: pendingRoutes });
  clearDraft();
}

function updateDraftLine() {
  const bits = [];
  bits.push(`Mode: ${mode}`);
  if (activeRoute.length) bits.push(`Active route len ${activeRoute.length - 1}`);
  if (pendingRoutes.length) bits.push(`Pending routes ${pendingRoutes.length}`);
  if (pendingDestination) bits.push(`Dest ${pendingDestination[0]},${pendingDestination[1]}`);
  if (entrenchSource) bits.push(`Entrench src ${entrenchSource[0]},${entrenchSource[1]}`);
  el('draft-line').textContent = bits.join(' · ') || 'No draft.';
}

function renderLog() {
  const box = el('log');
  if (!latestState) { box.innerHTML = ''; return; }
  box.innerHTML = '';
  latestState.log.forEach(line => {
    const div = document.createElement('div');
    div.className = 'log-entry';
    div.textContent = line;
    box.appendChild(div);
  });
}

function renderStatus() {
  if (!latestState) return;
  el('turn-line').textContent = `${latestState.current_owner_name}'s turn`;
  el('remaining-path').textContent = String(latestState.remaining_path);
  el('seat-line').textContent = latestState.my_seat === null ? 'Spectator' : latestState.my_name;
  el('clock0').textContent = formatClock(latestState.time_remaining['0']);
  el('clock1').textContent = formatClock(latestState.time_remaining['1']);
  el('winner-line').textContent = latestState.winner !== null ? `${latestState.winner_name} wins. ${latestState.win_reason}` : '';
  if (latestState.status === 'open') {
    el('status-line').textContent = latestState.is_private ? `Waiting for opponent. Code: ${latestState.join_code || ''}` : 'Waiting for opponent to join.';
  } else {
    el('status-line').textContent = latestMessage || '';
  }
  if (latestState.is_private && latestState.join_code) {
    el('share-line').textContent = `Private code: ${latestState.join_code}`;
  } else {
    el('share-line').textContent = latestState.status === 'open' ? `Share this URL: ${window.location.href}` : '';
  }
  renderLog();
}

function resizeCanvas() {
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.floor(rect.width * dpr);
  canvas.height = Math.floor(rect.height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  draw();
}

function computeGeom() {
  if (!latestState) return { cell: 20, ox: 10, oy: 10 };
  const w = latestState.map.width;
  const h = latestState.map.height;
  const pad = 20;
  const cell = Math.max(8, Math.floor(Math.min((canvas.clientWidth - pad * 2) / w, (canvas.clientHeight - pad * 2) / h)));
  const ox = Math.floor((canvas.clientWidth - cell * w) / 2);
  const oy = Math.floor((canvas.clientHeight - cell * h) / 2);
  return { cell, ox, oy };
}

function cellCenter(cell) {
  const { cell: s, ox, oy } = boardGeom;
  return [ox + cell[0] * s + s / 2, oy + cell[1] * s + s / 2];
}

function hitCell(evt) {
  if (!latestState) return null;
  const rect = canvas.getBoundingClientRect();
  const x = evt.clientX - rect.left;
  const y = evt.clientY - rect.top;
  const { cell: s, ox, oy } = boardGeom;
  const gx = Math.floor((x - ox) / s);
  const gy = Math.floor((y - oy) / s);
  if (gx < 0 || gy < 0 || gx >= latestState.map.width || gy >= latestState.map.height) return null;
  return [gx, gy];
}

function drawRoute(path, color, width = 4, dashed = false) {
  if (path.length < 2) return;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.setLineDash(dashed ? [8, 5] : []);
  ctx.beginPath();
  const [sx, sy] = cellCenter(path[0]);
  ctx.moveTo(sx, sy);
  for (let i = 1; i < path.length; i++) {
    const [x, y] = cellCenter(path[i]);
    ctx.lineTo(x, y);
  }
  ctx.stroke();
  ctx.restore();
}

function draw() {
  const rect = canvas.getBoundingClientRect();
  ctx.clearRect(0, 0, rect.width, rect.height);
  if (!latestState) return;
  boardGeom = computeGeom();
  const { cell: s, ox, oy } = boardGeom;
  const map = latestState.map;

  for (let y = 0; y < map.height; y++) {
    for (let x = 0; x < map.width; x++) {
      ctx.fillStyle = ELEVATION_COLORS[map.grid[y][x]] || '#888';
      ctx.fillRect(ox + x * s, oy + y * s, s, s);
      ctx.strokeStyle = 'rgba(0,0,0,0.16)';
      ctx.strokeRect(ox + x * s, oy + y * s, s, s);
    }
  }

  latestState.roads.forEach(road => drawRoute(road.path, PLAYER_COLORS[road.owner], Math.max(3, s * 0.18), false));
  pendingRoutes.forEach(route => drawRoute(route, '#76d0ff', Math.max(3, s * 0.18), true));
  if (activeRoute.length >= 2) drawRoute(activeRoute, '#00ffff', Math.max(3, s * 0.18), true);

  latestState.retake_locks.forEach(lock => {
    const [cx, cy] = cellCenter([lock.x, lock.y]);
    ctx.save();
    ctx.strokeStyle = '#000';
    ctx.lineWidth = Math.max(1, s * 0.08);
    ctx.beginPath();
    ctx.moveTo(cx - s * 0.16, cy - s * 0.16);
    ctx.lineTo(cx + s * 0.16, cy + s * 0.16);
    ctx.moveTo(cx + s * 0.16, cy - s * 0.16);
    ctx.lineTo(cx - s * 0.16, cy + s * 0.16);
    ctx.stroke();
    ctx.restore();
  });

  latestState.nodes.forEach(node => {
    const [cx, cy] = cellCenter([node.x, node.y]);
    ctx.save();
    ctx.beginPath();
    ctx.fillStyle = PLAYER_COLORS[node.owner];
    ctx.strokeStyle = PLAYER_OUTLINES[node.owner];
    ctx.lineWidth = Math.max(2, s * 0.11);
    ctx.arc(cx, cy, Math.max(5, s * (node.starter ? 0.34 : 0.27)), 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    if (node.starter) {
      ctx.beginPath();
      ctx.lineWidth = Math.max(1, s * 0.06);
      ctx.arc(cx, cy, Math.max(6, s * 0.42), 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
  });

  if (entrenchSource) {
    const [cx, cy] = cellCenter(entrenchSource);
    ctx.save();
    ctx.strokeStyle = '#000';
    ctx.lineWidth = Math.max(2, s * 0.08);
    ctx.strokeRect(cx - s * 0.35, cy - s * 0.35, s * 0.7, s * 0.7);
    ctx.restore();
  }
}

function onBoardClick(evt) {
  if (!latestState) return;
  const cell = hitCell(evt);
  if (!cell) return;
  const mySeat = latestState.my_seat;
  if (mySeat === null) return;
  if (!latestState.starter_placed[mySeat] && isMyTurn()) {
    send({ type: 'starter', x: cell[0], y: cell[1] });
    return;
  }
  if (!isMyTurn()) return;

  if (mode === 'fortify') {
    send({ type: 'fortify', x: cell[0], y: cell[1] });
    return;
  }
  if (mode === 'entrench') {
    const node = nodeAt(cell);
    if (!entrenchSource) {
      if (node && node.owner === mySeat) {
        entrenchSource = cell;
        updateDraftLine();
        draw();
      }
      return;
    }
    if (Math.max(Math.abs(cell[0] - entrenchSource[0]), Math.abs(cell[1] - entrenchSource[1])) === 1) {
      send({ type: 'entrench', src: entrenchSource, target: cell });
      entrenchSource = null;
      updateDraftLine();
      draw();
    }
    return;
  }

  const node = nodeAt(cell);
  if (!activeRoute.length) {
    if (node && node.owner === mySeat) {
      activeRoute = [cell];
      updateDraftLine();
      draw();
    }
    return;
  }

  const last = activeRoute[activeRoute.length - 1];
  if (activeRoute.length > 1 && sameCell(cell, activeRoute[activeRoute.length - 2])) {
    activeRoute.pop();
    updateDraftLine();
    draw();
    return;
  }
  if (!orthAdj(last, cell)) return;
  if (activeRoute.some(p => sameCell(p, cell))) return;
  activeRoute.push(cell);
  updateDraftLine();
  draw();
}

function applyState(state, message) {
  latestState = state;
  latestMessage = message || latestMessage;
  renderStatus();
  updateDraftLine();
  draw();
}

function connect() {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  ws = new WebSocket(`${protocol}://${window.location.host}/ws/game/${gameId}?player=${encodeURIComponent(playerKey)}`);
  ws.onopen = () => {
    el('status-line').textContent = 'Connected.';
    if (pingTimer) clearInterval(pingTimer);
    pingTimer = setInterval(() => {
      if (ws && ws.readyState === WebSocket.OPEN) send({ type: 'ping' });
    }, 1000);
  };
  ws.onmessage = (evt) => {
    const data = JSON.parse(evt.data);
    if (data.type === 'state') applyState(data.state, data.message);
    if (data.type === 'error') {
      latestMessage = data.message;
      renderStatus();
    }
  };
  ws.onclose = () => {
    el('status-line').textContent = 'Disconnected. Reconnecting…';
    if (pingTimer) clearInterval(pingTimer);
    reconnectTimer = setTimeout(connect, 1500);
  };
}

window.addEventListener('resize', resizeCanvas);
canvas.addEventListener('click', onBoardClick);
el('mode-routes').onclick = () => setMode('routes');
el('mode-entrench').onclick = () => setMode('entrench');
el('mode-fortify').onclick = () => setMode('fortify');
el('finish-route').onclick = finishRoute;
el('commit-routes').onclick = commitRoutes;
el('clear-draft').onclick = clearDraft;
el('end-turn').onclick = () => send({ type: 'end_turn' });
el('resign').onclick = () => send({ type: 'resign' });
setMode('routes');
resizeCanvas();
connect();
