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
let previewValid = true;
let invalidPreviewPath = [];
let soundEnabled = localStorage.getItem('topos_sound_enabled') !== '0';
let audioCtx = null;
let audioMaster = null;
let noiseBuffer = null;

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

function updateSoundToggle() {
  const btn = el('sound-toggle');
  if (!btn) return;
  btn.textContent = `Sound: ${soundEnabled ? 'On' : 'Off'}`;
  btn.classList.toggle('off', !soundEnabled);
}

function ensureAudio() {
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  if (!audioCtx) {
    audioCtx = new AC();
    audioMaster = audioCtx.createGain();
    audioMaster.gain.value = 0.42;
    audioMaster.connect(audioCtx.destination);
    const length = Math.max(1, Math.floor(audioCtx.sampleRate * 1.25));
    noiseBuffer = audioCtx.createBuffer(1, length, audioCtx.sampleRate);
    const data = noiseBuffer.getChannelData(0);
    let last = 0;
    for (let i = 0; i < length; i++) {
      const white = Math.random() * 2 - 1;
      last = (last + 0.03 * white) / 1.03;
      data[i] = last * 2.2;
    }
  }
  if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
  return audioCtx;
}

function unlockAudio() {
  if (!soundEnabled) return;
  const ctx = ensureAudio();
  if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {});
}

async function armAudio() {
  const ctx = ensureAudio();
  if (!ctx) return false;
  try {
    if (ctx.state === 'suspended') await ctx.resume();
    return ctx.state === 'running';
  } catch (_err) {
    return false;
  }
}

function burstNoise(t, duration, bandStart, bandEnd, gainPeak, q = 0.9) {
  const ctx = ensureAudio();
  if (!ctx || !audioMaster) return;
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer;
  const filter = ctx.createBiquadFilter();
  filter.type = 'bandpass';
  filter.Q.value = q;
  filter.frequency.setValueAtTime(Math.max(40, bandStart), t);
  filter.frequency.exponentialRampToValueAtTime(Math.max(45, bandEnd), t + duration);
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(Math.max(0.0001, gainPeak), t + Math.min(0.02, duration * 0.35));
  gain.gain.exponentialRampToValueAtTime(0.0001, t + duration);
  src.connect(filter);
  filter.connect(gain);
  gain.connect(audioMaster);
  src.start(t);
  src.stop(t + duration + 0.02);
}

function sweepTone(t, duration, startFreq, endFreq, gainPeak, type = 'triangle') {
  const ctx = ensureAudio();
  if (!ctx || !audioMaster) return;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(Math.max(30, startFreq), t);
  osc.frequency.exponentialRampToValueAtTime(Math.max(31, endFreq), t + duration);
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(Math.max(0.0001, gainPeak), t + Math.min(0.018, duration * 0.3));
  gain.gain.exponentialRampToValueAtTime(0.0001, t + duration);
  osc.connect(gain);
  gain.connect(audioMaster);
  osc.start(t);
  osc.stop(t + duration + 0.02);
}

function playGameSound(kind) {
  if (!soundEnabled) return;
  const ctx = ensureAudio();
  if (!ctx || !audioMaster) return;
  const t = ctx.currentTime + 0.01;
  const wobble = 0.97 + Math.random() * 0.06;
  if (kind === 'place') {
    burstNoise(t, 0.11, 480 * wobble, 200 * wobble, 0.18, 0.8);
    sweepTone(t, 0.10, 170 * wobble, 105 * wobble, 0.06, 'triangle');
    return;
  }
  if (kind === 'attack-node') {
    burstNoise(t, 0.14, 380 * wobble, 145 * wobble, 0.22, 0.85);
    sweepTone(t, 0.15, 145 * wobble, 72 * wobble, 0.085, 'triangle');
    return;
  }
  if (kind === 'attack-road') {
    burstNoise(t, 0.09, 900 * wobble, 260 * wobble, 0.17, 0.75);
    sweepTone(t, 0.08, 250 * wobble, 155 * wobble, 0.045, 'triangle');
    return;
  }
  if (kind === 'fortify') {
    burstNoise(t, 0.18, 220 * wobble, 760 * wobble, 0.16, 0.65);
    sweepTone(t, 0.16, 150 * wobble, 285 * wobble, 0.05, 'sine');
    return;
  }
  if (kind === 'entrench') {
    burstNoise(t, 0.19, 700 * wobble, 190 * wobble, 0.15, 0.72);
    sweepTone(t, 0.16, 260 * wobble, 125 * wobble, 0.048, 'sine');
    return;
  }
  if (kind === 'king') {
    burstNoise(t, 0.22, 1200 * wobble, 2400 * wobble, 0.10, 0.55);
    sweepTone(t, 0.18, 420 * wobble, 980 * wobble, 0.05, 'triangle');
    sweepTone(t + 0.015, 0.14, 630 * wobble, 1420 * wobble, 0.032, 'sine');
  }
}

function roadCellOwnerMap(state) {
  const map = new Map();
  if (!state) return map;
  for (const road of state.roads || []) {
    for (const cell of road.path.slice(1, -1)) map.set(`${cell[0]},${cell[1]}`, road.owner);
  }
  return map;
}

function detectSoundEvent(prev, next) {
  if (!prev || !next) return null;
  const prevLastLog = (prev.log || [])[prev.log ? prev.log.length - 1 : -1] || '';
  const nextLastLog = (next.log || [])[next.log ? next.log.length - 1 : -1] || '';
  if (nextLastLog && nextLastLog !== prevLastLog) {
    if (nextLastLog.startsWith('Fortify complete')) return 'fortify';
    if (nextLastLog.startsWith('Entrench complete')) return 'entrench';
  }
  if (prev.winner === null && next.winner !== null && /castle was destroyed/i.test(next.win_reason || '')) return 'king';

  const actor = prev.current_owner;
  const prevNodes = new Map((prev.nodes || []).map(n => [`${n.x},${n.y}`, n]));
  const nextNodes = new Map((next.nodes || []).map(n => [`${n.x},${n.y}`, n]));
  let enemyNodeRemoved = 0;
  let ownNodeAdded = 0;
  for (const [k, n] of prevNodes.entries()) if (n.owner === 1 - actor && !nextNodes.has(k)) enemyNodeRemoved += 1;
  for (const [k, n] of nextNodes.entries()) if (n.owner === actor && !prevNodes.has(k)) ownNodeAdded += 1;

  const prevRoads = roadCellOwnerMap(prev);
  const nextRoads = roadCellOwnerMap(next);
  let enemyRoadRemoved = 0;
  let ownRoadAdded = 0;
  for (const [k, owner] of prevRoads.entries()) if (owner === 1 - actor && !nextRoads.has(k)) enemyRoadRemoved += 1;
  for (const [k, owner] of nextRoads.entries()) if (owner === actor && !prevRoads.has(k)) ownRoadAdded += 1;

  if (enemyNodeRemoved > 0) return 'attack-node';
  if (enemyRoadRemoved > 0) return 'attack-road';
  if ((prev.starter_placed || [])[actor] !== (next.starter_placed || [])[actor]) return 'place';
  if (ownNodeAdded > 0 || ownRoadAdded > 0) return 'place';
  return null;
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

function localPendingLength(extraRoute = null) {
  let total = pendingRoutes.reduce((sum, route) => sum + Math.max(0, route.length - 1), 0);
  if (extraRoute) total += Math.max(0, extraRoute.length - 1);
  return total;
}

function localRemainingBudget(extraRoute = null) {
  if (!latestState) return 0;
  return latestState.remaining_path - localPendingLength(extraRoute);
}

function sourceAlreadyUsed(cell, extraRoutes = []) {
  const key = keyOf(cell);
  return [...pendingRoutes, ...extraRoutes].some(route => keyOf(route[0]) === key);
}

function evaluateRoutesLocal(routes, options = {}) {
  if (!latestState) return { ok: false, message: 'No state.' };
  if (latestState.winner !== null) return { ok: false, message: 'Game over.' };
  if (!routes.length) return { ok: false, message: 'No routes selected.' };
  const mySeat = latestState.current_owner;
  if (!latestState.starter_placed[mySeat]) return { ok: false, message: 'Place your starter first.' };

  const allowPartialLastRoute = !!options.allowPartialLastRoute;
  const dest = pendingDestination ? [pendingDestination[0], pendingDestination[1]] : routes[0][routes[0].length - 1];
  let totalLength = 0;
  const sources = [];
  const tempOccupied = new Set();
  const connectedSources = connectedToCastle(mySeat);
  let partialLastRoute = null;

  for (let routeIndex = 0; routeIndex < routes.length; routeIndex++) {
    const route = routes[routeIndex];
    if (!route || route.length < 2) return { ok: false, message: 'Route too short.' };
    const src = route[0];
    const srcNode = nodeAt(src);
    if (!srcNode || srcNode.owner !== mySeat) return { ok: false, message: 'Every route must start on your own node.' };
    if (!connectedSources.has(keyOf(src))) return { ok: false, message: 'Cannot build from nodes disconnected from your castle.' };
    const routeDest = route[route.length - 1];
    const isPartial = allowPartialLastRoute && routeIndex === routes.length - 1 && pendingDestination && !sameCell(routeDest, dest);
    if (!isPartial && !sameCell(routeDest, dest)) return { ok: false, message: 'All routes this turn must end at the same node.' };
    if (new Set(route.map(keyOf)).size !== route.length) return { ok: false, message: 'A route cannot revisit cells.' };
    if (route.some(([x, y]) => x < 0 || y < 0 || x >= latestState.map.width || y >= latestState.map.height)) return { ok: false, message: 'Out of bounds.' };
    for (let i = 0; i < route.length - 1; i++) {
      if (Math.abs(route[i][0] - route[i + 1][0]) + Math.abs(route[i][1] - route[i + 1][1]) !== 1) {
        return { ok: false, message: 'Route must move orthogonally one cell at a time.' };
      }
    }
    if (!routeBuildAllowedLocal(src, route)) return { ok: false, message: 'Route and new node may only go to equal, lower, or one level higher terrain from the source.' };

    const length = route.length - 1;
    if (length > latestState.settings.max_link_distance) return { ok: false, message: `Max route length is ${latestState.settings.max_link_distance}.` };
    totalLength += length;
    sources.push(keyOf(src));

    for (const pos of route.slice(1, -1)) {
      if (nodeAt(pos)) return { ok: false, message: 'Intermediate cells cannot cross nodes.' };
      if (roadAt(pos)) return { ok: false, message: 'Intermediate cells cannot cross roads.' };
      const pk = keyOf(pos);
      if (tempOccupied.has(pk)) return { ok: false, message: 'Pending routes cannot overlap except at the destination.' };
      tempOccupied.add(pk);
    }

    if (isPartial) partialLastRoute = route;
  }

  if (new Set(sources).size !== sources.length) return { ok: false, message: 'Use each source node at most once this turn.' };
  if (totalLength > latestState.remaining_path) return { ok: false, message: 'Not enough path remaining this turn.' };

  if (!partialLastRoute) {
    const destNode = nodeAt(dest);
    const destRoad = roadAt(dest);
    if (destNode && destNode.owner !== mySeat) {
      if (latestState.settings.retake_rule && latestState.retake_locks.some(lock => lock.blocked_owner === mySeat && lock.x === dest[0] && lock.y === dest[1])) {
        return { ok: false, message: 'Retake blocked on that node this turn.' };
      }
      if (!routes.some(route => canAttackFrom(route[0], dest))) {
        const protectedNode = isConnectedToCastle(dest);
        if (protectedNode) {
          return { ok: false, message: 'You must attack from a node at a higher elevation unless that group is disconnected from its castle.' };
        }
      }
    } else if (destRoad && destRoad.owner !== mySeat) {
      if (!routes.some(route => canAttackFrom(route[0], dest))) {
        const protectedRoad = roadIsConnectedToCastle(destRoad);
        if (protectedRoad) {
          return { ok: false, message: 'You must attack that road section from a higher elevation unless that group is disconnected from its castle.' };
        }
      }
    } else if (!destNode && !destRoad) {
      // build is fine
    }
  }

  return { ok: true, message: 'Ready. Confirm to commit.' };
}

function routeBuildAllowedLocal(src, route) {
  const srcElev = mapElev(src);
  const minAllowed = Math.max(1, srcElev - 1);
  return route.slice(1).every(pos => mapElev(pos) >= minAllowed);
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
  previewValid = true;
  invalidPreviewPath = [];
  updateDraftLine();
  draw();
}

function finishRoute() {
  if (activeRoute.length < 2) return false;
  const candidate = [...pendingRoutes, activeRoute.map(p => [p[0], p[1]])];
  const check = evaluateRoutesLocal(candidate);
  if (!check.ok) {
    latestMessage = check.message;
    previewValid = false;
    renderStatus();
    draw();
    return false;
  }
  const dest = activeRoute[activeRoute.length - 1];
  pendingRoutes.push(activeRoute.map(p => [p[0], p[1]]));
  pendingDestination = pendingDestination || [dest[0], dest[1]];
  activeRoute = [];
  invalidPreviewPath = [];
  previewValid = true;
  updateDraftLine();
  if (rangeAnchor && nodeAt(rangeAnchor)) setRangeFromNode(rangeAnchor);
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
  invalidPreviewPath = [];
  if (activeRoute.length >= 2) {
    previewValid = evaluateRoutesLocal([...pendingRoutes, activeRoute], { allowPartialLastRoute: true }).ok;
  } else {
    previewValid = true;
  }
  updateDraftLine();
  draw();
}

function extendActiveRouteTo(cell) {
  if (!activeRoute.length || !cell) return false;
  invalidPreviewPath = [];
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
    if (activeRoute.some(p => sameCell(p, step))) {
      invalidPreviewPath = [...activeRoute, [step[0], step[1]]];
      previewValid = false;
      updateDraftLine();
      draw();
      return false;
    }
    const candidate = [...activeRoute, [step[0], step[1]]];
    const legality = evaluateRoutesLocal([...pendingRoutes, candidate], { allowPartialLastRoute: true });
    if (!legality.ok) {
      invalidPreviewPath = candidate;
      previewValid = false;
      latestMessage = legality.message;
      renderStatus();
      updateDraftLine();
      draw();
      return false;
    }
    activeRoute.push([step[0], step[1]]);
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

function practicalRangeData(src, radius, showUnattackableTargets) {
  const node = nodeAt(src);
  if (!node || radius <= 0) return [];
  const minAllowed = Math.max(1, mapElev(src) - 1);
  const seen = new Set([keyOf(src)]);
  const reach = new Map();
  const queue = [[src, 0]];
  while (queue.length) {
    const [cur, dist] = queue.shift();
    if (dist >= radius) continue;
    for (const nxt of neighbors4(cur)) {
      const nk = keyOf(nxt);
      if (seen.has(nk)) continue;
      if (mapElev(nxt) < minAllowed) continue;
      seen.add(nk);
      const nextDist = dist + 1;
      const otherNode = nodeAt(nxt);
      if (otherNode && !sameCell(nxt, src)) {
        if (otherNode.owner === node.owner) {
          reach.set(nk, { cell: [nxt[0], nxt[1]], dist: nextDist });
        } else {
          const protectedNode = isConnectedToCastle(nxt);
          if (showUnattackableTargets || !protectedNode || canAttackFrom(src, nxt)) reach.set(nk, { cell: [nxt[0], nxt[1]], dist: nextDist });
        }
        continue;
      }
      const road = roadAt(nxt);
      if (road) {
        if (road.owner === node.owner) {
          reach.set(nk, { cell: [nxt[0], nxt[1]], dist: nextDist });
        } else {
          const protectedRoad = roadIsConnectedToCastle(road);
          if (showUnattackableTargets || !protectedRoad || canAttackFrom(src, nxt)) reach.set(nk, { cell: [nxt[0], nxt[1]], dist: nextDist });
        }
        continue;
      }
      reach.set(nk, { cell: [nxt[0], nxt[1]], dist: nextDist });
      queue.push([nxt, nextDist]);
    }
  }
  return Array.from(reach.values());
}

function practicalRangeCells(src, radius, showUnattackableTargets) {
  return practicalRangeData(src, radius, showUnattackableTargets).map(item => item.cell);
}

function ownRangeRadius() {
  if (!latestState) return 0;
  return Math.min(Math.max(0, localRemainingBudget()), latestState.settings.max_link_distance);
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
  const isOwnCurrentNode = node.owner === latestState.current_owner;
  const radius = isOwnCurrentNode ? ownRangeRadius() : otherRangeRadius();
  rangeAnchor = [cell[0], cell[1]];
  rangeColor = isOwnCurrentNode ? 'rgba(0,100,27,0.20)' : 'rgba(99,0,0,0.20)';
  let data = practicalRangeData(cell, radius, !!latestState.settings.show_unattackable_range_targets);
  if (isOwnCurrentNode && isMyTurn()) {
    if (sourceAlreadyUsed(cell)) {
      data = [];
    } else if (pendingDestination) {
      data = data.filter(item => sameCell(item.cell, pendingDestination));
    }
    const budget = Math.max(0, localRemainingBudget());
    data = data.filter(item => item.dist <= budget);
  }
  rangeCells = data.map(item => item.cell);
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
  if (activeRoute.length >= 2) drawRoute(activeRoute, previewValid ? '#111111' : '#ffffff', Math.max(3, s * 0.18), true);
  if (invalidPreviewPath.length >= 2) drawRoute(invalidPreviewPath, '#ffffff', Math.max(4, s * 0.22), true);

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
  const soundEvent = detectSoundEvent(latestState, state);
  latestState = state;
  latestMessage = message || latestMessage;
  previewValid = true;
  invalidPreviewPath = [];
  if (rangeAnchor) {
    if (nodeAt(rangeAnchor)) setRangeFromNode(rangeAnchor);
    else clearRange();
  }
  renderStatus();
  updateDraftLine();
  draw();
  if (soundEvent) playGameSound(soundEvent);
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
el('sound-toggle').onclick = async () => {
  soundEnabled = !soundEnabled;
  localStorage.setItem('topos_sound_enabled', soundEnabled ? '1' : '0');
  updateSoundToggle();
  if (soundEnabled) {
    const ok = await armAudio();
    if (ok) playGameSound('place');
  }
};
updateSoundToggle();
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
window.addEventListener('pointerdown', unlockAudio, { passive: true });
window.addEventListener('keydown', unlockAudio, { passive: true });
