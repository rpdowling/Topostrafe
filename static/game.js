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
let pointerDown = false;
let pointerDragged = false;
let suppressClick = false;
let suppressClickTimer = null;
let rangeCells = [];
let rangeAnchor = null;
let rangeColor = null;

const canvas = document.getElementById('board');
const ctx = canvas.getContext('2d');

function el(id) { return document.getElementById(id); }
function sameCell(a, b) { return a && b && a[0] === b[0] && a[1] === b[1]; }
function orthAdj(a, b) { return Math.abs(a[0]-b[0]) + Math.abs(a[1]-b[1]) === 1; }
function keyOf(cell) { return `${cell[0]},${cell[1]}`; }
function parseKey(key) { const [x, y] = key.split(',').map(Number); return [x, y]; }

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

function roadAt(cell) {
  if (!latestState) return null;
  return latestState.roads.find(r => r.path.slice(1, -1).some(p => p[0] === cell[0] && p[1] === cell[1])) || null;
}

function send(payload) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify(payload));
}

function clearRange() {
  rangeCells = [];
  rangeAnchor = null;
  rangeColor = null;
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
  if (activeRoute.length < 2) return false;
  const dest = activeRoute[activeRoute.length - 1];
  if (pendingDestination && !sameCell(dest, pendingDestination)) {
    latestMessage = 'All routes this turn must end at the same node.';
    renderStatus();
    return false;
  }
  pendingRoutes.push(activeRoute.map(p => [p[0], p[1]]));
  pendingDestination = pendingDestination || [dest[0], dest[1]];
  activeRoute = [];
  updateDraftLine();
  draw();
  return true;
}

function commitRoutes() {
  if (activeRoute.length >= 2) finishRoute();
  if (!pendingRoutes.length) return;
  send({ type: 'routes', routes: pendingRoutes });
  clearDraft();
  clearRange();
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

function renderChat() {
  const box = el('chat-box');
  if (!box) return;
  if (!latestState) { box.innerHTML = ''; return; }
  const atBottom = Math.abs(box.scrollHeight - box.scrollTop - box.clientHeight) < 12;
  box.innerHTML = '';
  (latestState.chat || []).forEach((msg) => {
    const row = document.createElement('div');
    row.className = `chat-entry owner-${msg.owner}`;
    const head = document.createElement('div');
    head.className = 'chat-name';
    head.textContent = msg.name;
    const body = document.createElement('div');
    body.className = 'chat-text';
    body.textContent = msg.text;
    row.appendChild(head);
    row.appendChild(body);
    box.appendChild(row);
  });
  if (atBottom) box.scrollTop = box.scrollHeight;
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
  renderChat();
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

function interpolateCells(a, b) {
  const cells = [[a[0], a[1]]];
  let [x, y] = a;
  while (x !== b[0]) {
    x += b[0] > x ? 1 : -1;
    cells.push([x, y]);
  }
  while (y !== b[1]) {
    y += b[1] > y ? 1 : -1;
    cells.push([x, y]);
  }
  return cells;
}

function requireConfirmation() {
  return !!(latestState && latestState.settings && latestState.settings.require_move_confirmation);
}

function tryAutoConfirmDestination(cell) {
  if (!pendingRoutes.length || activeRoute.length || requireConfirmation()) return false;
  if (pendingDestination && sameCell(cell, pendingDestination)) {
    commitRoutes();
    return true;
  }
  return false;
}

function refreshActiveRoutePreview() {
  updateDraftLine();
  draw();
}

function extendActiveRouteTo(cell) {
  if (!activeRoute.length || !cell) return false;
  const last = activeRoute[activeRoute.length - 1];
  if (sameCell(cell, last)) return false;
  if (activeRoute.length > 1 && sameCell(cell, activeRoute[activeRoute.length - 2])) {
    activeRoute.pop();
    refreshActiveRoutePreview();
    return true;
  }
  const stepPath = interpolateCells(last, cell);
  let changed = false;
  for (let i = 1; i < stepPath.length; i++) {
    const step = stepPath[i];
    const cur = activeRoute[activeRoute.length - 1];
    if (!orthAdj(cur, step)) break;
    if (activeRoute.some(p => sameCell(p, step))) break;
    activeRoute.push(step);
    changed = true;
    if (activeRoute.length > 1) {
      const stepNode = nodeAt(step);
      if (stepNode) break;
    }
  }
  if (changed) refreshActiveRoutePreview();
  return changed;
}

function mapElev(cell) {
  return latestState.map.grid[cell[1]][cell[0]];
}

function neighbors4(cell) {
  const out = [];
  const [x, y] = cell;
  if (x > 0) out.push([x - 1, y]);
  if (x + 1 < latestState.map.width) out.push([x + 1, y]);
  if (y > 0) out.push([x, y - 1]);
  if (y + 1 < latestState.map.height) out.push([x, y + 1]);
  return out;
}

function castlePos(owner) {
  const node = latestState.nodes.find(n => n.owner === owner && n.starter);
  return node ? [node.x, node.y] : null;
}

function ownerNodeSet(owner) {
  const s = new Set();
  for (const n of latestState.nodes) if (n.owner === owner) s.add(keyOf([n.x, n.y]));
  return s;
}

function ownerGraph(owner) {
  const nodes = ownerNodeSet(owner);
  const adj = new Map();
  for (const k of nodes) adj.set(k, new Set());
  for (const k of nodes) {
    const cell = parseKey(k);
    for (const nxt of neighbors4(cell)) {
      const nk = keyOf(nxt);
      if (nodes.has(nk)) adj.get(k).add(nk);
    }
  }
  for (const road of latestState.roads) {
    if (road.owner !== owner) continue;
    const a = keyOf(road.path[0]);
    const b = keyOf(road.path[road.path.length - 1]);
    if (adj.has(a) && adj.has(b)) {
      adj.get(a).add(b);
      adj.get(b).add(a);
    }
  }
  return adj;
}

function connectedToCastle(owner) {
  const castle = castlePos(owner);
  if (!castle) return new Set();
  const graph = ownerGraph(owner);
  const start = keyOf(castle);
  if (!graph.has(start)) return new Set();
  const seen = new Set([start]);
  const stack = [start];
  while (stack.length) {
    const cur = stack.pop();
    for (const nxt of graph.get(cur) || []) {
      if (!seen.has(nxt)) {
        seen.add(nxt);
        stack.push(nxt);
      }
    }
  }
  return seen;
}

function isConnectedToCastle(cell) {
  const node = nodeAt(cell);
  if (!node) return false;
  return connectedToCastle(node.owner).has(keyOf(cell));
}

function roadIsConnectedToCastle(road) {
  const connected = connectedToCastle(road.owner);
  return connected.has(keyOf(road.path[0])) || connected.has(keyOf(road.path[road.path.length - 1]));
}

function attackPrivilegeElevation(owner) {
  const connected = connectedToCastle(owner);
  if (!connected.size) return 5;
  let best = 5;
  for (const k of connected) {
    const elev = mapElev(parseKey(k));
    if (elev < best) best = elev;
  }
  return best;
}

function attackElevationForSource(src) {
  const node = nodeAt(src);
  if (!node) return mapElev(src);
  if (!latestState.settings.inherited_attack_rule) return mapElev(src);
  if (!connectedToCastle(node.owner).has(keyOf(src))) return mapElev(src);
  return attackPrivilegeElevation(node.owner);
}

function canAttackFrom(src, dst) {
  return attackElevationForSource(src) < mapElev(dst);
}

function practicalRangeCells(src, radius, showUnattackableTargets) {
  const node = nodeAt(src);
  if (!node || radius <= 0) return [];
  const minAllowed = Math.max(1, mapElev(src) - 1);
  const seen = new Set([keyOf(src)]);
  const reach = new Set();
  const queue = [[src, 0]];
  while (queue.length) {
    const [cur, dist] = queue.shift();
    if (dist >= radius) continue;
    for (const nxt of neighbors4(cur)) {
      const nk = keyOf(nxt);
      if (seen.has(nk)) continue;
      if (mapElev(nxt) < minAllowed) continue;
      seen.add(nk);
      const otherNode = nodeAt(nxt);
      if (otherNode && !sameCell(nxt, src)) {
        if (otherNode.owner === node.owner) {
          reach.add(nk);
        } else {
          const protectedNode = isConnectedToCastle(nxt);
          if (showUnattackableTargets || !protectedNode || canAttackFrom(src, nxt)) reach.add(nk);
        }
        continue;
      }
      const road = roadAt(nxt);
      if (road) {
        if (road.owner === node.owner) {
          reach.add(nk);
        } else {
          const protectedRoad = roadIsConnectedToCastle(road);
          if (showUnattackableTargets || !protectedRoad || canAttackFrom(src, nxt)) reach.add(nk);
        }
        continue;
      }
      reach.add(nk);
      queue.push([nxt, dist + 1]);
    }
  }
  return Array.from(reach, parseKey);
}

function ownRangeRadius() {
  if (!latestState) return 0;
  return Math.min(latestState.remaining_path, latestState.settings.max_link_distance);
}

function otherRangeRadius() {
  if (!latestState) return 0;
  return Math.min(latestState.settings.path_count, latestState.settings.max_link_distance);
}

function setRangeFromNode(cell) {
  if (!latestState) {
    clearRange();
    return;
  }
  const node = nodeAt(cell);
  if (!node) {
    clearRange();
    return;
  }
  const radius = node.owner === latestState.current_owner ? ownRangeRadius() : otherRangeRadius();
  rangeAnchor = [cell[0], cell[1]];
  rangeColor = node.owner === latestState.current_owner ? 'rgba(0,100,27,0.20)' : 'rgba(99,0,0,0.20)';
  rangeCells = practicalRangeCells(cell, radius, !!latestState.settings.show_unattackable_range_targets);
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

  if (rangeCells.length) {
    ctx.save();
    for (const cell of rangeCells) {
      ctx.fillStyle = rangeColor || 'rgba(255,255,255,0.16)';
      ctx.fillRect(ox + cell[0] * s + 1, oy + cell[1] * s + 1, s - 2, s - 2);
    }
    if (rangeAnchor) {
      ctx.fillStyle = 'rgba(255,255,255,0.22)';
      ctx.fillRect(ox + rangeAnchor[0] * s + 1, oy + rangeAnchor[1] * s + 1, s - 2, s - 2);
    }
    ctx.restore();
  }

  latestState.roads.forEach(road => drawRoute(road.path, PLAYER_COLORS[road.owner], Math.max(3, s * 0.18), false));
  pendingRoutes.forEach(route => drawRoute(route, '#101010', Math.max(3, s * 0.18), true));
  if (activeRoute.length >= 2) drawRoute(activeRoute, '#111111', Math.max(3, s * 0.18), true);

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
    ctx.arc(cx, cy, Math.max(5, s * 0.34), 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    if (node.starter) {
      ctx.beginPath();
      ctx.fillStyle = '#000000';
      ctx.arc(cx, cy, Math.max(2, s * 0.10), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  });

  if (pendingDestination) {
    const [cx, cy] = cellCenter(pendingDestination);
    ctx.save();
    ctx.strokeStyle = '#101010';
    ctx.lineWidth = Math.max(2, s * 0.08);
    ctx.setLineDash([6, 4]);
    ctx.beginPath();
    ctx.arc(cx, cy, Math.max(5, s * 0.34), 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

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
  if (suppressClick) {
    suppressClick = false;
    return;
  }
  if (!latestState) return;
  const cell = hitCell(evt);
  if (!cell) return;
  const mySeat = latestState.my_seat;
  if (mySeat === null) return;

  if (mode === 'routes') {
    const clickedNode = nodeAt(cell);
    if (clickedNode) setRangeFromNode(cell);
    else clearRange();
  }

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
        setRangeFromNode(cell);
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

  if (tryAutoConfirmDestination(cell)) return;

  const node = nodeAt(cell);
  if (!activeRoute.length) {
    if (node && node.owner === mySeat) {
      activeRoute = [cell];
      setRangeFromNode(cell);
      updateDraftLine();
      draw();
    }
    return;
  }

  const changed = extendActiveRouteTo(cell);
  if (changed && activeRoute.length >= 2) {
    const destNode = nodeAt(activeRoute[activeRoute.length - 1]);
    if (destNode && sameCell(activeRoute[activeRoute.length - 1], cell)) finishRoute();
  }
}

function applyState(state, message) {
  latestState = state;
  latestMessage = message || latestMessage;
  if (rangeAnchor) {
    if (nodeAt(rangeAnchor)) setRangeFromNode(rangeAnchor);
    else clearRange();
  }
  renderStatus();
  updateDraftLine();
  draw();
}

function onBoardMouseDown(evt) {
  pointerDown = true;
  pointerDragged = false;
  if (!latestState || !isMyTurn() || mode !== 'routes') return;
  const cell = hitCell(evt);
  if (!cell) return;
  const mySeat = latestState.my_seat;
  if (mySeat === null || !latestState.starter_placed[mySeat]) return;
  if (!activeRoute.length) {
    const node = nodeAt(cell);
    if (node && node.owner === mySeat) {
      activeRoute = [cell];
      setRangeFromNode(cell);
      updateDraftLine();
      draw();
    }
  }
}

function onBoardMouseMove(evt) {
  if (!pointerDown || !latestState || !isMyTurn() || mode !== 'routes' || !activeRoute.length) return;
  const cell = hitCell(evt);
  if (!cell) return;
  if (extendActiveRouteTo(cell)) pointerDragged = true;
}

function onBoardMouseUp() {
  if (pointerDown && pointerDragged) {
    suppressClick = true;
    if (suppressClickTimer) clearTimeout(suppressClickTimer);
    suppressClickTimer = setTimeout(() => {
      suppressClick = false;
      suppressClickTimer = null;
    }, 0);
    finishRoute();
  }
  pointerDown = false;
  pointerDragged = false;
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
canvas.addEventListener('mousedown', onBoardMouseDown);
canvas.addEventListener('mousemove', onBoardMouseMove);
canvas.addEventListener('mouseup', onBoardMouseUp);
canvas.addEventListener('mouseleave', onBoardMouseUp);
canvas.addEventListener('click', onBoardClick);
el('mode-routes').onclick = () => setMode('routes');
el('mode-entrench').onclick = () => setMode('entrench');
el('mode-fortify').onclick = () => setMode('fortify');
el('finish-route').onclick = finishRoute;
el('commit-routes').onclick = commitRoutes;
el('clear-draft').onclick = () => { clearDraft(); clearRange(); };
el('end-turn').onclick = () => send({ type: 'end_turn' });
el('resign').onclick = () => send({ type: 'resign' });
setMode('routes');
resizeCanvas();
connect();

function sendChat(evt) {
  evt.preventDefault();
  const input = el('chat-input');
  if (!input) return;
  const text = input.value.trim();
  if (!text) return;
  send({ type: 'chat', text });
  input.value = '';
}

const chatForm = el('chat-form');
if (chatForm) chatForm.addEventListener('submit', sendChat);
