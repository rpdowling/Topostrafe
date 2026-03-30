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
let hoverCell = null;
let hoverClient = null;
let hoverPreview = null;
let latestStateRevision = '';
let animations = [];
let animationFramePending = false;
let threatenedCastles = {0: false, 1: false};
let autoPathPreview = null;

const canvas = document.getElementById('board');
const ctx = canvas.getContext('2d');
const routePill = document.getElementById('route-pill');

function el(id) { return document.getElementById(id); }
function sameCell(a, b) { return a && b && a[0] === b[0] && a[1] === b[1]; }
function orthAdj(a, b) { return Math.abs(a[0]-b[0]) + Math.abs(a[1]-b[1]) === 1; }
function keyOf(cell) { return `${cell[0]},${cell[1]}`; }
function parseKey(key) { const [x, y] = key.split(',').map(Number); return [x, y]; }

function traversalCostForElevation(elev) { return ({5:2, 4:1, 3:2, 2:2, 1:3}[Number(elev)] ?? 2); }
function cliffSurchargeUnit() {
  if (!latestState) return 0;
  return Math.max(1, Math.ceil(Number(latestState.settings.path_count || 0) / 4));
}
function cliffExtraCostBetween(fromCell, toCell) {
  const fromElev = mapElev(fromCell);
  const toElev = mapElev(toCell);
  const drop = toElev - fromElev;
  if (drop <= 1) return 0;
  return (drop - 1) * cliffSurchargeUnit();
}
function traversalCostForCell(cell) { return traversalCostForElevation(mapElev(cell)); }
function traversalEdgeCost(fromCell, toCell) { return traversalCostForCell(toCell) + cliffExtraCostBetween(fromCell, toCell); }
function routeTraversalCost(route) {
  let total = 0;
  for (let i = 1; i < route.length; i++) total += traversalEdgeCost(route[i - 1], route[i]);
  return total;
}

function routeCliffSurcharge(route) {
  let total = 0;
  for (let i = 1; i < route.length; i++) total += cliffExtraCostBetween(route[i - 1], route[i]);
  return total;
}

function maxRouteSteps() {
  if (!latestState) return 0;
  return Math.max(0, Number(latestState.settings.max_link_distance || 0));
}

function maxSingleLinkCost() {
  if (!latestState) return 0;
  return Math.max(0, Number(latestState.settings.max_link_distance || 0));
}

function lowPointRestrictEnabled() {
  return !!(latestState && latestState.settings && latestState.settings.low_point_restrict);
}

function northShadingEnabled() {
  return !!(latestState && latestState.settings && latestState.settings.north_shading);
}

function routeStepAllowed(prevElev, nextElev, srcElev = prevElev) {
  if (lowPointRestrictEnabled()) {
    const overallCap = Math.max(1, srcElev - 1);
    return nextElev >= Math.max(overallCap, prevElev - 1);
  }
  return nextElev >= Math.max(1, srcElev - 1);
}

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
    audioMaster.gain.value = 0.52;
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
    burstNoise(t, 0.12, 520 * wobble, 180 * wobble, 0.22, 0.8);
    sweepTone(t, 0.11, 190 * wobble, 96 * wobble, 0.075, 'triangle');
    return;
  }
  if (kind === 'attack-road') {
    burstNoise(t, 0.085, 1150 * wobble, 340 * wobble, 0.18, 0.72);
    sweepTone(t, 0.075, 320 * wobble, 185 * wobble, 0.05, 'triangle');
    return;
  }
  if (kind === 'fortify') {
    burstNoise(t, 0.17, 260 * wobble, 980 * wobble, 0.18, 0.58);
    sweepTone(t, 0.15, 165 * wobble, 345 * wobble, 0.06, 'sine');
    burstNoise(t + 0.028, 0.08, 420 * wobble, 1280 * wobble, 0.065, 0.5);
    return;
  }
  if (kind === 'entrench') {
    burstNoise(t, 0.18, 820 * wobble, 230 * wobble, 0.18, 0.66);
    sweepTone(t, 0.15, 300 * wobble, 140 * wobble, 0.058, 'sine');
    burstNoise(t + 0.024, 0.075, 560 * wobble, 210 * wobble, 0.06, 0.6);
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

function detectSoundEvent(prev, next, message, prevMessage) {
  if (!prev || !next) return null;
  const prevLastLog = (prev.log || [])[prev.log ? prev.log.length - 1 : -1] || '';
  const nextLastLog = (next.log || [])[next.log ? next.log.length - 1 : -1] || '';
  const note = String(message || nextLastLog || '').trim();
  const priorNote = String(prevMessage || prevLastLog || '').trim();
  if (prev.winner === null && next.winner !== null && /castle was destroyed/i.test(next.win_reason || '')) return 'king';

  let mapDelta = 0;
  const prevGrid = prev.map && prev.map.grid ? prev.map.grid : [];
  const nextGrid = next.map && next.map.grid ? next.map.grid : [];
  const h = Math.min(prevGrid.length, nextGrid.length);
  for (let y = 0; y < h; y++) {
    const prow = prevGrid[y] || [];
    const nrow = nextGrid[y] || [];
    const w = Math.min(prow.length, nrow.length);
    for (let x = 0; x < w; x++) {
      if (prow[x] !== nrow[x]) mapDelta += 1;
    }
  }
  const actionNoteChanged = note && note !== priorNote;
  const logAdvanced = nextLastLog && nextLastLog !== prevLastLog;
  if ((mapDelta > 0 || actionNoteChanged || logAdvanced) && note) {
    if (note.startsWith('Fortify complete')) return 'fortify';
    if (note.startsWith('Sap complete')) return 'entrench';
  }

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
  if (mode === 'entrench') {
    activeRoute = [];
    pendingRoutes = [];
    pendingDestination = null;
    invalidPreviewPath = [];
    previewValid = true;
    invalidateAutoPath();
    clearRange();
  }
  updateDraftLine();
  clearRoutePill();
  draw();
}

function isMyTurn() {
  return latestState && latestState.status === 'active' && latestState.my_seat !== null && latestState.my_seat === latestState.current_owner && latestState.winner === null;
}

function playerSeat() {
  return latestState && latestState.my_seat !== null ? latestState.my_seat : latestState ? latestState.current_owner : null;
}

function canDraftOrQueue() {
  return latestState && latestState.status === 'active' && latestState.my_seat !== null && latestState.winner === null;
}

function currentTurnBudgetForSeat() {
  if (!latestState) return 0;
  return isMyTurn() ? Number(latestState.remaining_path || 0) : Number(latestState.settings.path_count || 0);
}

function normalizePremoveAction(action) {
  if (!action || typeof action !== 'object') return null;
  if (action.type === 'starter') return { type: 'starter', x: Number(action.x), y: Number(action.y) };
  if (action.type === 'fortify') return { type: 'fortify', x: Number(action.x), y: Number(action.y) };
  if (action.type === 'entrench') return { type: 'entrench', src: [Number(action.src[0]), Number(action.src[1])], target: [Number(action.target[0]), Number(action.target[1])] };
  if (action.type === 'routes') return { type: 'routes', routes: (action.routes || []).map(route => route.map(c => [Number(c[0]), Number(c[1])])) };
  if (action.type === 'end_turn') return { type: 'end_turn' };
  return { type: String(action.type || '') };
}

function premoveActionsEqual(a, b) {
  const na = normalizePremoveAction(a);
  const nb = normalizePremoveAction(b);
  return JSON.stringify(na) === JSON.stringify(nb);
}

function myPremoveAction() {
  return latestState ? normalizePremoveAction(latestState.my_premove_action) : null;
}

function premoveHitCell(cell) {
  const action = myPremoveAction();
  if (!action || !cell) return false;
  if (action.type === 'starter') return Number(action.x) === cell[0] && Number(action.y) === cell[1];
  if (action.type === 'fortify') return Number(action.x) === cell[0] && Number(action.y) === cell[1];
  if (action.type === 'entrench') {
    const src = action.src || [];
    const target = action.target || [];
    if (target.length === 2 && Number(target[0]) === cell[0] && Number(target[1]) === cell[1]) return true;
    if (src.length === 2 && Math.max(Math.abs(cell[0] - Number(src[0])), Math.abs(cell[1] - Number(src[1]))) === 1) return true;
    return false;
  }
  if (action.type === 'routes') {
    return (action.routes || []).some(route => route.some(c => Number(c[0]) === cell[0] && Number(c[1]) === cell[1]));
  }
  return false;
}

function sendGameAction(payload) {
  if (isMyTurn()) {
    send(payload);
    return;
  }
  if (!canDraftOrQueue()) return;
  const queued = myPremoveAction();
  if (queued && premoveActionsEqual(queued, payload)) {
    send({ type: 'clear_premove' });
    latestMessage = 'Premove cleared.';
    renderStatus();
    return;
  }
  send({ type: 'premove', action: payload });
  latestMessage = 'Premove queued.';
  renderStatus();
}

function stateRevision(state) {
  if (!state) return '';
  const mapSum = (state.map && state.map.grid ? state.map.grid.reduce((acc, row) => acc + row.reduce((a, b) => a + Number(b || 0), 0), 0) : 0);
  const lastLog = state.log && state.log.length ? state.log[state.log.length - 1] : '';
  return [state.current_owner, state.winner, state.remaining_path, state.nodes.length, state.roads.length, mapSum, lastLog].join('|');
}

function invalidateAutoPath() {
  autoPathPreview = null;
}

function clearRoutePill() {
  hoverPreview = null;
  if (routePill) routePill.classList.add('hidden');
}

function showRoutePill(clientX, clientY, info) {
  if (!routePill || !info) return;
  routePill.className = `route-pill ${info.variant || 'ok'}`;
  routePill.innerHTML = `<div class="route-pill-top">${info.title}</div><div class="route-pill-sub">${info.sub}</div>`;
  routePill.style.left = `${Math.min(window.innerWidth - 230, clientX + 16)}px`;
  routePill.style.top = `${Math.min(window.innerHeight - 52, clientY + 16)}px`;
  routePill.classList.remove('hidden');
}

function queueAnimation(anim) {
  animations.push(anim);
  if (!animationFramePending) {
    animationFramePending = true;
    requestAnimationFrame(stepAnimations);
  }
}

function stepAnimations(ts) {
  animationFramePending = false;
  animations = animations.filter(anim => {
    if (anim.t0 == null) anim.t0 = ts;
    return ts - anim.t0 < anim.duration;
  });
  draw();
  if (animations.length) {
    animationFramePending = true;
    requestAnimationFrame(stepAnimations);
  }
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
  let total = pendingRoutes.reduce((sum, route) => sum + routeTraversalCost(route), 0);
  if (extraRoute) total += routeTraversalCost(extraRoute);
  return total;
}

function localRemainingBudget(extraRoute = null) {
  if (!latestState) return 0;
  return currentTurnBudgetForSeat() - localPendingLength(extraRoute);
}

function sourceAlreadyUsed(cell, extraRoutes = []) {
  const key = keyOf(cell);
  return [...pendingRoutes, ...extraRoutes].some(route => keyOf(route[0]) === key);
}

function evaluateRoutesLocal(routes, options = {}) {
  if (!latestState) return { ok: false, message: 'No state.' };
  if (latestState.winner !== null) return { ok: false, message: 'Game over.' };
  if (!routes.length) return { ok: false, message: 'No routes selected.' };
  const mySeat = playerSeat();
  if (mySeat === null) return { ok: false, message: 'Player seat unavailable.' };
  if (!latestState.starter_placed[mySeat]) return { ok: false, message: 'Place your starter first.' };

  const allowPartialLastRoute = !!options.allowPartialLastRoute;
  const dest = pendingDestination ? [pendingDestination[0], pendingDestination[1]] : routes[0][routes[0].length - 1];
  let totalCost = 0;
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
    if (!routeBuildAllowedLocal(src, route)) return { ok: false, message: 'Routes can only climb one elevation at a time; climb back up through intermediate elevations.' };

    const routeCost = routeTraversalCost(route);
    if (routeCost > maxSingleLinkCost()) return { ok: false, message: `Max single link traversal cost is ${maxSingleLinkCost()}.` };
    totalCost += routeCost;
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
  if (totalCost > currentTurnBudgetForSeat()) return { ok: false, message: 'Not enough traversal cost remaining this turn.' };

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
  let prevElev = srcElev;
  for (const pos of route.slice(1)) {
    const elev = mapElev(pos);
    if (!routeStepAllowed(prevElev, elev, srcElev)) return false;
    prevElev = elev;
  }
  return true;
}


function cellOccupiedForRoute(cell, targetKey = null) {
  const k = keyOf(cell);
  if (targetKey && k === targetKey) return false;
  return !!nodeAt(cell) || !!roadAt(cell);
}

function findShortestRoute(src, dst, options = {}) {
  if (!latestState || !src || !dst) return null;
  const seat = playerSeat();
  if (seat === null) return null;
  if (!options.ignorePending && pendingDestination && !sameCell(dst, pendingDestination)) return null;
  if (!options.ignorePending && sourceAlreadyUsed(src)) return null;
  const srcElev = mapElev(src);
  const targetKey = keyOf(dst);
  const limitCost = Math.max(0, Math.min(maxSingleLinkCost(), options.limitCost ?? localRemainingBudget()));
  const limitSteps = Math.max(0, maxRouteSteps());
  const best = new Map([[keyOf(src), { cost: 0, steps: 0 }]]);
  const prev = new Map();
  const queue = [[src, 0, 0]];
  let foundStateKey = null;
  while (queue.length) {
    queue.sort((a, b) => (a[1] - b[1]) || (a[2] - b[2]));
    const [cur, spent, steps] = queue.shift();
    const stateKey = keyOf(cur);
    const curRec = best.get(stateKey);
    if (!curRec || curRec.cost !== spent || curRec.steps !== steps) continue;
    if (sameCell(cur, dst) && steps > 0) {
      foundStateKey = stateKey;
      break;
    }
    if (steps >= limitSteps) continue;
    const curElev = mapElev(cur);
    for (const nxt of neighbors4(cur)) {
      const elev = mapElev(nxt);
      if (!routeStepAllowed(curElev, elev, srcElev)) continue;
      const nk = keyOf(nxt);
      if (!sameCell(nxt, dst) && cellOccupiedForRoute(nxt, targetKey)) continue;
      const nextSteps = steps + 1;
      const nextCost = spent + traversalEdgeCost(cur, nxt);
      if (nextSteps > limitSteps || nextCost > limitCost) continue;
      const prevRec = best.get(nk);
      if (prevRec && (nextCost > prevRec.cost || (nextCost === prevRec.cost && nextSteps >= prevRec.steps))) continue;
      best.set(nk, { cost: nextCost, steps: nextSteps });
      prev.set(nk, stateKey);
      queue.push([[nxt[0], nxt[1]], nextCost, nextSteps]);
    }
  }
  if (!foundStateKey || targetKey === keyOf(src)) return null;
  const out = [];
  let cur = foundStateKey;
  while (cur) {
    out.push(parseKey(cur));
    if (cur === keyOf(src)) break;
    cur = prev.get(cur);
  }
  out.reverse();
  return out.length >= 2 ? out : null;
}

function classifyRouteResult(path, opts = {}) {
  if (!path || path.length < 2) return { title: 'No route', sub: 'Select a source node.', variant: 'invalid' };
  const cost = routeTraversalCost(path);
  const cliff = routeCliffSurcharge(path);
  const remaining = localRemainingBudget() - cost;
  const costSummary = cliff > 0 ? `Cost ${cost} · +Cliff Jump ${cliff} · Remaining ${remaining}` : `Cost ${cost} · Remaining ${remaining}`;
  if (opts.invalid) return { title: 'Invalid route', sub: costSummary, variant: 'invalid' };
  const seat = playerSeat();
  const dest = path[path.length - 1];
  const destNode = nodeAt(dest);
  const destRoad = roadAt(dest);
  let result = 'Place node';
  let variant = 'ok';
  if (destNode) {
    if (destNode.owner === seat) result = 'Connect node';
    else { result = 'Attack node'; variant = 'attack'; }
  } else if (destRoad) {
    if (destRoad.owner === seat) result = 'Connect path';
    else { result = 'Attack path'; variant = 'attack'; }
  }
  return { title: result, sub: costSummary, variant };
}

function updateHoverPreview(cell, clientX, clientY) {
  hoverCell = cell ? [cell[0], cell[1]] : null;
  hoverClient = cell ? { x: clientX, y: clientY } : null;
  if (!hoverCell || !canDraftOrQueue() || mode !== 'routes' || !activeRoute.length) {
    clearRoutePill();
    return;
  }
  let path = null;
  let info = null;
  if (invalidPreviewPath.length >= 2) {
    path = invalidPreviewPath;
    info = classifyRouteResult(path, { invalid: true });
  } else if (activeRoute.length >= 2) {
    path = activeRoute;
    info = classifyRouteResult(path);
  } else if (activeRoute.length === 1 && !sameCell(hoverCell, activeRoute[0])) {
    path = findShortestRoute(activeRoute[0], hoverCell);
    if (path) info = classifyRouteResult(path);
  }
  hoverPreview = path;
  if (path && info) showRoutePill(clientX, clientY, info);
  else clearRoutePill();
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

function clearRouteOnlyState() {
  activeRoute = [];
  pendingRoutes = [];
  pendingDestination = null;
  previewValid = true;
  invalidPreviewPath = [];
  invalidateAutoPath();
  clearRoutePill();
}

function clearDraft() {
  clearRouteOnlyState();
  entrenchSource = null;
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
  invalidateAutoPath();
  updateDraftLine();
  if (rangeAnchor && nodeAt(rangeAnchor)) setRangeFromNode(rangeAnchor);
  draw();
  return true;
}

function commitRoutes() {
  if (activeRoute.length >= 2) finishRoute();
  if (!pendingRoutes.length) return;
  sendGameAction({ type: 'routes', routes: pendingRoutes });
  clearDraft();
  clearRange();
}

function updateDraftLine() {
  const bits = [];
  bits.push(`Mode: ${mode}`);
  if (activeRoute.length) bits.push(`Active route cost ${routeTraversalCost(activeRoute)}`);
  if (pendingRoutes.length) bits.push(`Pending routes ${pendingRoutes.length} · cost ${localPendingLength()}`);
  if (pendingDestination) bits.push(`Dest ${pendingDestination[0]},${pendingDestination[1]}`);
  if (entrenchSource) bits.push(`Sap src ${entrenchSource[0]},${entrenchSource[1]}`);
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
  const stat0 = el('stat-player0');
  const stat1 = el('stat-player1');
  if (stat0) stat0.classList.toggle('active-turn', latestState.current_owner === 0 && latestState.winner === null);
  if (stat1) stat1.classList.toggle('active-turn', latestState.current_owner === 1 && latestState.winner === null);
  if (latestState.my_premove && !isMyTurn() && latestState.winner === null) {
    el('status-line').textContent = `${el('status-line').textContent} Premove queued.`.trim();
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
  invalidateAutoPath();
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
  invalidateAutoPath();
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
    if (routeTraversalCost(candidate) > maxSingleLinkCost()) {
      invalidPreviewPath = candidate;
      previewValid = false;
      latestMessage = `Max single link traversal cost is ${maxSingleLinkCost()}.`;
      renderStatus();
      updateDraftLine();
      draw();
      return false;
    }
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
  const srcElev = mapElev(src);
  const reach = new Map();
  const best = new Map([[keyOf(src), { cost: 0, steps: 0 }]]);
  const queue = [[src, 0, 0]];

  while (queue.length) {
    queue.sort((a, b) => (a[1] - b[1]) || (a[2] - b[2]));
    const [cur, spent, steps] = queue.shift();
    const stateKey = keyOf(cur);
    const curBest = best.get(stateKey);
    if (!curBest || spent !== curBest.cost || steps !== curBest.steps) continue;
    if (steps >= maxRouteSteps()) continue;

    const curElev = mapElev(cur);
    for (const nxt of neighbors4(cur)) {
      const elev = mapElev(nxt);
      if (!routeStepAllowed(curElev, elev, srcElev)) continue;
      const nk = keyOf(nxt);
      const nextSteps = steps + 1;
      const nextCost = spent + traversalEdgeCost(cur, nxt);
      if (nextCost > radius) continue;

      const prev = best.get(nk);
      if (prev && (nextCost > prev.cost || (nextCost === prev.cost && nextSteps >= prev.steps))) continue;
      best.set(nk, { cost: nextCost, steps: nextSteps });

      const updateReach = () => {
        const prior = reach.get(nk);
        if (!prior || nextCost < prior.dist || (nextCost === prior.dist && nextSteps < prior.steps)) {
          reach.set(nk, { cell: [nxt[0], nxt[1]], dist: nextCost, steps: nextSteps });
        }
      };

      const otherNode = nodeAt(nxt);
      if (otherNode && !sameCell(nxt, src)) {
        if (otherNode.owner === node.owner) {
          updateReach();
        } else {
          const protectedNode = isConnectedToCastle(nxt);
          if (showUnattackableTargets || !protectedNode || canAttackFrom(src, nxt)) updateReach();
        }
        continue;
      }

      const road = roadAt(nxt);
      if (road) {
        if (road.owner === node.owner) {
          updateReach();
        } else {
          const protectedRoad = roadIsConnectedToCastle(road);
          if (showUnattackableTargets || !protectedRoad || canAttackFrom(src, nxt)) updateReach();
        }
        continue;
      }

      updateReach();
      queue.push([[nxt[0], nxt[1]], nextCost, nextSteps]);
    }
  }

  return Array.from(reach.values()).sort((a, b) => a.dist - b.dist || a.cell[1] - b.cell[1] || a.cell[0] - b.cell[0]);
}

function practicalRangeCells(src, radius, showUnattackableTargets) {
  return practicalRangeData(src, radius, showUnattackableTargets).map(item => item.cell);
}

function ownRangeRadius() {
  if (!latestState) return 0;
  return Math.max(0, Math.min(localRemainingBudget(), maxSingleLinkCost()));
}

function otherRangeRadius() {
  if (!latestState) return 0;
  return latestState.settings.path_count;
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
  const isOwnCurrentNode = node.owner === playerSeat();
  const radius = isOwnCurrentNode ? ownRangeRadius() : otherRangeRadius();
  rangeAnchor = [cell[0], cell[1]];
  rangeColor = isOwnCurrentNode ? 'rgba(0,100,27,0.20)' : 'rgba(99,0,0,0.20)';
  let data = practicalRangeData(cell, radius, !!latestState.settings.show_unattackable_range_targets);
  if (isOwnCurrentNode && canDraftOrQueue()) {
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


function detectVisualEvents(prev, next, message) {
  if (!prev || !next) return [];
  const events = [];
  const prevNodes = new Map((prev.nodes || []).map(n => [keyOf([n.x, n.y]), n]));
  const nextNodes = new Map((next.nodes || []).map(n => [keyOf([n.x, n.y]), n]));
  const prevRoads = new Map((prev.roads || []).map(r => [String(r.road_id), r]));
  const nextRoads = new Map((next.roads || []).map(r => [String(r.road_id), r]));
  for (const [id, road] of nextRoads.entries()) if (!prevRoads.has(id)) events.push({ kind: 'snap-road', path: road.path, owner: road.owner, duration: 180 });
  for (const [k, node] of nextNodes.entries()) if (!prevNodes.has(k)) events.push({ kind: 'snap-node', cell: [node.x, node.y], owner: node.owner, duration: 180 });
  for (const [k, node] of prevNodes.entries()) if (!nextNodes.has(k)) events.push({ kind: 'fade-node', cell: [node.x, node.y], owner: node.owner, duration: 180 });
  for (const [id, road] of prevRoads.entries()) if (!nextRoads.has(id)) events.push({ kind: 'fade-road', path: road.path, owner: road.owner, duration: 180 });
  const changedCells = [];
  const prevGrid = prev.map && prev.map.grid ? prev.map.grid : [];
  const nextGrid = next.map && next.map.grid ? next.map.grid : [];
  for (let y = 0; y < Math.min(prevGrid.length, nextGrid.length); y++) {
    for (let x = 0; x < Math.min(prevGrid[y].length, nextGrid[y].length); x++) {
      if (prevGrid[y][x] !== nextGrid[y][x]) changedCells.push({ cell: [x, y], from: prevGrid[y][x], to: nextGrid[y][x] });
    }
  }
  if (/Fortify complete/i.test(message || '')) for (const item of changedCells) events.push({ kind: 'fortify', cell: item.cell, duration: 220 });
  if (/Sap complete/i.test(message || '')) for (const item of changedCells) events.push({ kind: 'sap', cell: item.cell, duration: 220 });
  return events;
}

function drawAnimations() {
  if (!animations.length) return;
  const now = performance.now();
  for (const anim of animations) {
    const t = Math.max(0, Math.min(1, (now - anim.t0) / anim.duration));
    const fade = 1 - t;
    if (anim.kind === 'snap-road') {
      drawRoute(anim.path, `rgba(255,255,255,${0.55 * fade})`, Math.max(4, boardGeom.cell * (0.34 - 0.12 * t)), false);
    } else if (anim.kind === 'snap-node') {
      const [cx, cy] = cellCenter(anim.cell);
      ctx.save();
      ctx.strokeStyle = `rgba(255,255,255,${0.55 * fade})`;
      ctx.lineWidth = Math.max(2, boardGeom.cell * 0.12);
      ctx.beginPath();
      ctx.arc(cx, cy, Math.max(6, boardGeom.cell * (0.30 + 0.18 * t)), 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    } else if (anim.kind === 'fade-road') {
      drawRoute(anim.path, `rgba(0,0,0,${0.38 * fade})`, Math.max(3, boardGeom.cell * 0.18), false);
    } else if (anim.kind === 'fade-node') {
      const [cx, cy] = cellCenter(anim.cell);
      ctx.save();
      ctx.fillStyle = `rgba(0,0,0,${0.38 * fade})`;
      ctx.beginPath();
      ctx.arc(cx, cy, Math.max(5, boardGeom.cell * 0.34), 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    } else if (anim.kind === 'fortify' || anim.kind === 'sap') {
      const [x, y] = anim.cell;
      ctx.save();
      ctx.fillStyle = anim.kind === 'fortify' ? `rgba(255,255,255,${0.22 * fade})` : `rgba(0,0,0,${0.18 * fade})`;
      ctx.fillRect(boardGeom.ox + x * boardGeom.cell + 1, boardGeom.oy + y * boardGeom.cell + 1, boardGeom.cell - 2, boardGeom.cell - 2);
      ctx.restore();
    }
  }
}

function shortestAttackThreat(owner) {
  const castle = castlePos(owner);
  if (!castle || !latestState) return false;
  const enemy = 1 - owner;
  const enemyConnected = connectedToCastle(enemy);
  const budget = latestState.current_owner === enemy ? Number(latestState.remaining_path || 0) : Number(latestState.settings.path_count || 0);
  for (const key of enemyConnected) {
    const src = parseKey(key);
    if (!canAttackFrom(src, castle)) continue;
    const path = findShortestRoute(src, castle, { limitCost: Math.min(budget, maxSingleLinkCost()), ignorePending: true });
    if (path && routeTraversalCost(path) <= Math.min(budget, maxSingleLinkCost())) return true;
  }
  return false;
}

function recomputeThreatenedCastles() {
  if (!latestState) { threatenedCastles = {0:false,1:false}; return; }
  threatenedCastles = { 0: shortestAttackThreat(0), 1: shortestAttackThreat(1) };
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

function drawCellBracket(cell, color, width = 2, inset = 4, lenFrac = 0.24) {
  if (!cell) return;
  const s = boardGeom.cell;
  const x = boardGeom.ox + Number(cell[0]) * s + inset;
  const y = boardGeom.oy + Number(cell[1]) * s + inset;
  const w = s - inset * 2;
  const h = s - inset * 2;
  const lx = Math.max(4, w * lenFrac);
  const ly = Math.max(4, h * lenFrac);
  ctx.save();
  ctx.setLineDash([]);
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.beginPath();
  ctx.moveTo(x, y + ly); ctx.lineTo(x, y); ctx.lineTo(x + lx, y);
  ctx.moveTo(x + w - lx, y); ctx.lineTo(x + w, y); ctx.lineTo(x + w, y + ly);
  ctx.moveTo(x + w, y + h - ly); ctx.lineTo(x + w, y + h); ctx.lineTo(x + w - lx, y + h);
  ctx.moveTo(x + lx, y + h); ctx.lineTo(x, y + h); ctx.lineTo(x, y + h - ly);
  ctx.stroke();
  ctx.restore();
}

function drawPremoveOverlay() {
  const action = myPremoveAction();
  if (!action || !latestState || latestState.winner !== null) return;
  const s = boardGeom.cell;
  const seat = latestState.my_seat;
  const base = seat === 0 ? 'rgba(255,0,255,0.50)' : 'rgba(255,255,255,0.70)';
  const fill = seat === 0 ? 'rgba(255,0,255,0.10)' : 'rgba(255,255,255,0.10)';
  ctx.save();
  ctx.lineWidth = Math.max(2, s * 0.08);
  ctx.strokeStyle = base;
  ctx.fillStyle = fill;
  if (action.type === 'starter') {
    ctx.setLineDash([5, 4]);
    const [cx, cy] = cellCenter([action.x, action.y]);
    ctx.beginPath();
    ctx.arc(cx, cy, Math.max(6, s * 0.34), 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  } else if (action.type === 'routes') {
    for (const route of (action.routes || [])) {
      drawRoute(route, base, Math.max(3, s * 0.15), true);
    }
    const routes = action.routes || [];
    const lastRoute = routes.length ? routes[routes.length - 1] : null;
    if (lastRoute && lastRoute.length) {
      ctx.setLineDash([5, 4]);
      const [cx, cy] = cellCenter(lastRoute[lastRoute.length - 1]);
      ctx.beginPath();
      ctx.arc(cx, cy, Math.max(5, s * 0.30), 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
  } else if (action.type === 'fortify') {
    ctx.setLineDash([5, 4]);
    const road = roadAt([action.x, action.y]);
    if (road) drawRoute(road.path, base, Math.max(3, s * 0.14), true);
    ctx.fillRect(boardGeom.ox + action.x * s + 2, boardGeom.oy + action.y * s + 2, s - 4, s - 4);
    ctx.strokeRect(boardGeom.ox + action.x * s + 2, boardGeom.oy + action.y * s + 2, s - 4, s - 4);
  }
  ctx.restore();
}

function drawEntrenchPremoveOverlayAfterNodes() {
  const action = myPremoveAction();
  if (!action || action.type !== 'entrench' || !latestState || latestState.winner !== null) return;
  const s = boardGeom.cell;
  const src = action.src || [];
  const target = action.target || [];
  if (src.length === 2) {
    const [cx, cy] = cellCenter([Number(src[0]), Number(src[1])]);
    ctx.save();
    ctx.strokeStyle = 'rgba(210,40,40,0.85)';
    ctx.lineWidth = Math.max(2, s * 0.10);
    ctx.beginPath();
    ctx.arc(cx, cy, Math.max(6, s * 0.38), 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }
  if (target.length === 2) {
    drawCellBracket([Number(target[0]), Number(target[1])], 'rgba(255,255,255,0.92)', Math.max(2, s * 0.10), 3, 0.30);
  }
}

function drawNodesOverlay() {
  if (!latestState) return;
  const s = boardGeom.cell;
  ctx.save();
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  latestState.nodes.forEach(node => {
    const [cx, cy] = cellCenter([node.x, node.y]);
    const r = Math.max(5, s * 0.34);
    ctx.save();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.beginPath();
    ctx.fillStyle = PLAYER_COLORS[node.owner];
    ctx.strokeStyle = PLAYER_OUTLINES[node.owner];
    ctx.lineWidth = Math.max(2, s * 0.11);
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    if (node.starter) {
      ctx.beginPath();
      ctx.fillStyle = '#000000';
      ctx.arc(cx, cy, Math.max(2, s * 0.10), 0, Math.PI * 2);
      ctx.fill();
      if (threatenedCastles[node.owner]) {
        const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 180);
        ctx.strokeStyle = `rgba(255,80,80,${0.35 + 0.35 * pulse})`;
        ctx.lineWidth = Math.max(2, s * 0.10);
        ctx.beginPath();
        ctx.arc(cx, cy, Math.max(7, s * (0.40 + 0.05 * pulse)), 0, Math.PI * 2);
        ctx.stroke();
      }
    }
    ctx.restore();
  });
  ctx.restore();
}

function draw() {
  const rect = canvas.getBoundingClientRect();
  ctx.clearRect(0, 0, rect.width, rect.height);
  if (!latestState) return;
  boardGeom = computeGeom();
  const { cell: s, ox, oy } = boardGeom;
  const map = latestState.map;

  const useNorthShading = northShadingEnabled();
  for (let y = 0; y < map.height; y++) {
    for (let x = 0; x < map.width; x++) {
      const elev = map.grid[y][x];
      ctx.fillStyle = ELEVATION_COLORS[elev] || '#888';
      ctx.fillRect(ox + x * s, oy + y * s, s, s);
      if (useNorthShading && y > 0) {
        const northElev = map.grid[y - 1][x];
        const diff = elev - northElev;
        if (diff > 0) {
          const shadeFrac = Math.min(0.25, 0.02 + 0.06 * diff);
          const shadeAlpha = Math.min(0.28, 0.05 + 0.05 * diff);
          ctx.fillStyle = `rgba(0,0,0,${shadeAlpha.toFixed(3)})`;
          ctx.fillRect(ox + x * s, oy + y * s, s, Math.max(1, s * shadeFrac));
        }
      }
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
  const queuedOverlayAction = myPremoveAction();
  const suppressRouteDraftOverlays = mode === 'entrench' || (queuedOverlayAction && queuedOverlayAction.type === 'entrench');
  drawPremoveOverlay();
  if (!suppressRouteDraftOverlays) {
    pendingRoutes.forEach(route => drawRoute(route, '#101010', Math.max(3, s * 0.18), true));
    if (activeRoute.length >= 2) drawRoute(activeRoute, previewValid ? '#111111' : '#ffffff', Math.max(3, s * 0.18), true);
    if (invalidPreviewPath.length >= 2) drawRoute(invalidPreviewPath, '#ffffff', Math.max(4, s * 0.22), true);
  }

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

  drawAnimations();

  if (!suppressRouteDraftOverlays && pendingDestination) {
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
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const tx = entrenchSource[0] + dx;
        const ty = entrenchSource[1] + dy;
        if (tx < 0 || ty < 0 || tx >= map.width || ty >= map.height) continue;
        drawCellBracket([tx, ty], 'rgba(210,40,40,0.95)', Math.max(2, s * 0.08), 3, 0.28);
      }
    }
  }

  drawNodesOverlay();
  drawEntrenchPremoveOverlayAfterNodes();
  const queuedAfter = myPremoveAction();
  if (queuedAfter && queuedAfter.type === 'entrench') {
    drawNodesOverlay();
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

  if (!isMyTurn() && myPremoveAction()) {
    send({ type: 'clear_premove' });
    latestMessage = 'Premove cleared.';
    renderStatus();
    clearDraft();
    return;
  }

  if (mode === 'routes') {
    const clickedNode = nodeAt(cell);
    if (clickedNode) setRangeFromNode(cell);
    else if (!activeRoute.length) clearRange();
  }

  if (!latestState.starter_placed[mySeat] && canDraftOrQueue()) {
    sendGameAction({ type: 'starter', x: cell[0], y: cell[1] });
    return;
  }
  if (!canDraftOrQueue()) return;

  if (mode === 'fortify') {
    sendGameAction({ type: 'fortify', x: cell[0], y: cell[1] });
    return;
  }
  if (mode === 'entrench') {
    const node = nodeAt(cell);
    if (!entrenchSource) {
      if (node && node.owner === mySeat) {
        clearRouteOnlyState();
        entrenchSource = cell;
        clearRange();
        updateDraftLine();
        draw();
      }
      return;
    }
    if (Math.max(Math.abs(cell[0] - entrenchSource[0]), Math.abs(cell[1] - entrenchSource[1])) === 1) {
      sendGameAction({ type: 'entrench', src: entrenchSource, target: cell });
      clearRouteOnlyState();
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
      invalidateAutoPath();
      activeRoute = [cell];
      setRangeFromNode(cell);
      updateDraftLine();
      draw();
    }
    return;
  }

  if (activeRoute.length === 1 && !sameCell(cell, activeRoute[0]) && !pointerDragged) {
    const autoPath = findShortestRoute(activeRoute[0], cell);
    if (autoPath) {
      autoPathPreview = autoPath;
      activeRoute = autoPath.map(p => [p[0], p[1]]);
      refreshActiveRoutePreview();
      finishRoute();
      updateHoverPreview(cell, evt.clientX, evt.clientY);
      return;
    }
  }

  const changed = extendActiveRouteTo(cell);
  if (changed && activeRoute.length >= 2) {
    const destNode = nodeAt(activeRoute[activeRoute.length - 1]);
    if (destNode && sameCell(activeRoute[activeRoute.length - 1], cell)) finishRoute();
  }
}

function applyState(state, message) {
  const prevState = latestState;
  const prevMessage = latestMessage;
  const nextRevision = stateRevision(state);
  const changed = nextRevision !== latestStateRevision;
  const soundEvent = changed ? detectSoundEvent(prevState, state, message, prevMessage) : null;
  const visualEvents = changed ? detectVisualEvents(prevState, state, message || '') : [];
  latestState = state;
  latestStateRevision = nextRevision;
  latestMessage = message || latestMessage;
  previewValid = true;
  invalidPreviewPath = [];
  invalidateAutoPath();
  const queuedNow = myPremoveAction();
  if (queuedNow && queuedNow.type === 'entrench') {
    clearRouteOnlyState();
    entrenchSource = null;
    clearRange();
  }
  if (rangeAnchor) {
    if (nodeAt(rangeAnchor)) setRangeFromNode(rangeAnchor);
    else clearRange();
  }
  recomputeThreatenedCastles();
  renderStatus();
  updateDraftLine();
  draw();
  for (const anim of visualEvents) queueAnimation(anim);
  if (soundEvent) playGameSound(soundEvent);
}

function onBoardMouseDown(evt) {
  pointerDown = true;
  pointerDragged = false;
  if (!latestState || !canDraftOrQueue() || mode !== 'routes') return;
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
  if (!pointerDown || !latestState || !canDraftOrQueue() || mode !== 'routes' || !activeRoute.length) return;
  const cell = hitCell(evt);
  if (!cell) return;
  const last = activeRoute[activeRoute.length - 1];
  if (invalidPreviewPath.length && sameCell(cell, last)) {
    invalidPreviewPath = [];
    previewValid = true;
    updateDraftLine();
    draw();
    return;
  }
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
canvas.addEventListener('mousemove', (evt) => {
  const cell = hitCell(evt);
  updateHoverPreview(cell, evt.clientX, evt.clientY);
});
canvas.addEventListener('mouseup', onBoardMouseUp);
canvas.addEventListener('mouseleave', () => { onBoardMouseUp(); clearRoutePill(); });
canvas.addEventListener('click', onBoardClick);
el('mode-routes').onclick = () => setMode('routes');
el('mode-entrench').onclick = () => setMode('entrench');
el('mode-fortify').onclick = () => setMode('fortify');
el('finish-route').onclick = finishRoute;
el('commit-routes').onclick = commitRoutes;
el('clear-draft').onclick = () => { clearDraft(); clearRange(); };
el('end-turn').onclick = () => sendGameAction({ type: 'end_turn' });
el('resign').onclick = () => sendGameAction({ type: 'resign' });
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
