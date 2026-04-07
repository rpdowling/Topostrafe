const gameId = window.TOPOS_GAME_ID;
const playerKey = new URLSearchParams(window.location.search).get('player') || '';
const board = document.getElementById('board');
const boardScroll = document.getElementById('board-scroll');
const ctx = board.getContext('2d');

let ws = null;
let latestState = null;
let previousState = null;
let reconnectTimer = null;
let pendingNode = null;
let draftSegments = [];
let currentSegment = null;
let hoverCell = null;
let fadeEffects = [];
let lastBoardCenterSignature = '';
let latestStateReceivedAt = 0;

const PLAYER_COLORS = { 0: '#ff00ff', 1: '#f2f0e8' };
const PLAYER_OUTLINES = { 0: '#1a001c', 1: '#000000' };

function el(id) { return document.getElementById(id); }
function keyOf(cell) { return `${cell[0]},${cell[1]}`; }
function parseKey(k) { return k.split(',').map(Number); }
function sameCell(a, b) { return !!a && !!b && a[0] === b[0] && a[1] === b[1]; }

function wsUrl() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/ws/game/${encodeURIComponent(gameId)}?player=${encodeURIComponent(playerKey)}`;
}

function connect() {
  if (ws) try { ws.close(); } catch (_) {}
  ws = new WebSocket(wsUrl());
  ws.onopen = () => setStatus('Connected.');
  ws.onmessage = (evt) => {
    const payload = JSON.parse(evt.data);
    if (payload.type === 'state') {
      if (payload.message) addLogLine(payload.message);
      receiveState(payload.state);
    } else if (payload.type === 'error') {
      setStatus(payload.message || 'Error.', true);
    }
  };
  ws.onclose = () => {
    setStatus('Disconnected. Reconnecting…', true);
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, 1200);
  };
}

function receiveState(state) {
  previousState = latestState;
  latestState = state;
  latestStateReceivedAt = performance.now();
  captureFadeEffects(previousState, latestState);
  renderState();
}

function send(payload) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify(payload));
}

function setStatus(msg, bad = false) {
  const node = el('status-line');
  if (!node) return;
  node.textContent = msg || '';
  node.style.color = bad ? '#ff9a9a' : '';
}

function addLogLine(msg) {
  if (!msg || !latestState) return;
  const next = [...(latestState.log || []), msg];
  latestState.log = next.slice(-16);
}

function mySeat() {
  return latestState?.my_seat ?? null;
}

function isMyTurn() {
  return latestState && mySeat() !== null && latestState.current_owner === mySeat() && latestState.status === 'active' && latestState.winner === null;
}

function canDraftOrQueue() {
  return latestState && mySeat() !== null && latestState.status === 'active' && latestState.winner === null;
}

function requireMoveConfirmation() {
  return !!latestState?.settings?.require_move_confirmation;
}

function isActiveBoardCell(cell) {
  if (!latestState || !cell) return false;
  return cell[0] >= 0 && cell[1] >= 0 && cell[0] < (latestState.board?.width || 0) && cell[1] < (latestState.board?.height || 0);
}

function isPreviewRingCell(cell) {
  if (!latestState || !cell) return false;
  if (isActiveBoardCell(cell)) return false;
  const px = latestState.board?.preview_margin_x || 0;
  const py = latestState.board?.preview_margin_y || 0;
  if (px <= 0 && py <= 0) return false;
  const minX = -px;
  const minY = -py;
  const maxX = (latestState.board?.width || 0) + px - 1;
  const maxY = (latestState.board?.height || 0) + py - 1;
  return cell[0] >= minX && cell[1] >= minY && cell[0] <= maxX && cell[1] <= maxY;
}

function formatClock(seconds) {
  const safe = Math.max(0, Math.floor(seconds));
  const mins = Math.floor(safe / 60);
  const secs = safe % 60;
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

function displayedClock(owner) {
  if (!latestState) return 0;
  let remaining = Number(latestState.time_remaining?.[String(owner)] || 0);
  if (latestState.status === 'active' && latestState.winner === null && latestState.settings?.time_limit_enabled && latestState.current_owner === owner && latestStateReceivedAt) {
    remaining -= Math.max(0, (performance.now() - latestStateReceivedAt) / 1000);
  }
  return Math.max(0, remaining);
}

function nodeMap() {
  const out = new Map();
  for (const node of latestState?.nodes || []) out.set(`${node.x},${node.y}`, node);
  return out;
}

function pathList() {
  return latestState?.paths || [];
}

function nodeAt(cell) {
  if (!latestState || !cell) return null;
  return (latestState.nodes || []).find(n => n.x === cell[0] && n.y === cell[1]) || null;
}

function normalizePremoveAction(action) {
  if (!action || typeof action !== 'object') return null;
  if (action.type === 'starter') return { type: 'starter', x: Number(action.x), y: Number(action.y) };
  if (action.type === 'um_node') {
    const out = { type: 'um_node', x: Number(action.x), y: Number(action.y) };
    if (action.preview_ref && typeof action.preview_ref === 'object') {
      out.preview_ref = { width: Number(action.preview_ref.width || 0), height: Number(action.preview_ref.height || 0) };
    }
    return out;
  }
  if (action.type === 'um_paths') return { type: 'um_paths', segments: (action.segments || []).map(seg => seg.map(c => [Number(c[0]), Number(c[1])])) };
  return { type: String(action.type || '') };
}

function premoveActionsEqual(a, b) {
  return JSON.stringify(normalizePremoveAction(a)) === JSON.stringify(normalizePremoveAction(b));
}

function myPremoveAction() {
  return latestState ? normalizePremoveAction(latestState.my_premove_action) : null;
}

function sendUmAction(payload) {
  if (isMyTurn()) {
    send(payload);
    return;
  }
  if (!canDraftOrQueue()) return;
  const queued = myPremoveAction();
  if (queued && premoveActionsEqual(queued, payload)) {
    send({ type: 'clear_premove' });
    setStatus('Premove cleared.');
    return;
  }
  send({ type: 'premove', action: payload });
  setStatus('Premove queued.');
}

function boardDimensions() {
  const activeW = latestState?.board?.width || 10;
  const activeH = latestState?.board?.height || 10;
  const previewX = latestState?.board?.preview_margin_x || 0;
  const previewY = latestState?.board?.preview_margin_y || 0;
  return {
    activeW,
    activeH,
    previewX,
    previewY,
    totalW: activeW + previewX * 2,
    totalH: activeH + previewY * 2,
  };
}

function resizeCanvas() {
  if (!board) return;
  const panel = boardScroll?.closest('.um-board-panel') || board.parentElement;
  const toolbar = panel?.querySelector('.toolbar');
  const isTopo = !!panel?.classList.contains('topo-board-panel');
  const viewportW = Math.max(isTopo ? 980 : 520, Math.floor((boardScroll?.clientWidth || panel?.clientWidth || 1800) - (isTopo ? 0 : 2)));
  const viewportH = Math.max(
    isTopo ? 860 : 500,
    Math.floor(
      isTopo
        ? (window.innerHeight - 12)
        : (window.innerHeight - (toolbar?.offsetHeight || 56) - 42)
    )
  );
  const dims = boardDimensions();
  const pad = isTopo ? 4 : 24;
  const largeBoard = isTopo
    ? (Math.max(dims.activeW, dims.activeH) > 46 || Math.max(dims.totalW, dims.totalH) > 46)
    : (Math.max(dims.activeW, dims.activeH) > 30 || Math.max(dims.totalW, dims.totalH) > 30);
  let cell;
  if (largeBoard) {
    cell = isTopo ? 28 : 28;
    if (boardScroll) boardScroll.classList.add('can-pan');
  } else {
    cell = Math.max(isTopo ? 28 : 18, Math.floor(Math.min((viewportW - pad * 2) / Math.max(1, dims.totalW), (viewportH - pad * 2) / Math.max(1, dims.totalH))));
    if (boardScroll) boardScroll.classList.remove('can-pan');
  }
  const canvasW = pad * 2 + dims.totalW * cell;
  const canvasH = pad * 2 + dims.totalH * cell;
  board.width = canvasW;
  board.height = canvasH;
  board.style.width = `${canvasW}px`;
  board.style.height = `${canvasH}px`;
  if (boardScroll) {
    boardScroll.style.maxHeight = `${viewportH}px`;
  }
  drawBoard();
  centerBoardScroll();
}

function centerBoardScroll(force = false) {
  if (!boardScroll || !latestState) return;
  const dims = boardDimensions();
  const largeBoard = Math.max(dims.activeW, dims.activeH) > 30 || Math.max(dims.totalW, dims.totalH) > 30;
  if (!largeBoard) {
    lastBoardCenterSignature = `${dims.activeW}x${dims.activeH}:${dims.previewX},${dims.previewY}`;
    boardScroll.scrollLeft = 0;
    boardScroll.scrollTop = 0;
    return;
  }
  const sig = `${dims.activeW}x${dims.activeH}:${dims.previewX},${dims.previewY}`;
  if (!force && sig === lastBoardCenterSignature) return;
  lastBoardCenterSignature = sig;
  boardScroll.scrollLeft = Math.max(0, Math.floor((board.width - boardScroll.clientWidth) / 2));
  boardScroll.scrollTop = Math.max(0, Math.floor((board.height - boardScroll.clientHeight) / 2));
}

function pathOccupancy(owner = null) {
  const occ = new Map();
  for (const path of pathList()) {
    if (owner !== null && path.owner !== owner) continue;
    const cells = path.cells || [];
    for (const cell of cells.slice(1, -1)) {
      const key = `${cell[0]},${cell[1]}`;
      if (!occ.has(key)) occ.set(key, []);
      occ.get(key).push(path);
    }
  }
  return occ;
}

function boardMetrics() {
  const dims = boardDimensions();
  const pad = 40;
  const cell = Math.max(1, Math.floor(Math.min((board.width - pad * 2) / Math.max(1, dims.totalW), (board.height - pad * 2) / Math.max(1, dims.totalH))));
  const totalBoardW = cell * dims.totalW;
  const totalBoardH = cell * dims.totalH;
  const ox = Math.floor((board.width - totalBoardW) / 2);
  const oy = Math.floor((board.height - totalBoardH) / 2);
  const activeOx = ox + dims.previewX * cell;
  const activeOy = oy + dims.previewY * cell;
  return {
    width: dims.activeW,
    height: dims.activeH,
    previewX: dims.previewX,
    previewY: dims.previewY,
    totalW: dims.totalW,
    totalH: dims.totalH,
    cell,
    ox,
    oy,
    boardW: totalBoardW,
    boardH: totalBoardH,
    activeOx,
    activeOy,
    activeBoardW: dims.activeW * cell,
    activeBoardH: dims.activeH * cell,
  };
}

function cellCenter(cell, m = boardMetrics()) {
  return {
    x: m.activeOx + (cell[0] + 0.5) * m.cell,
    y: m.activeOy + (cell[1] + 0.5) * m.cell,
  };
}

function nodeFill(owner) {
  return owner === 0 ? '#ff00ff' : '#f2f0e8';
}

function nodeShadow(owner) {
  return owner === 0 ? 'rgba(56, 0, 50, 0.22)' : 'rgba(0, 0, 0, 0.18)';
}

function drawNodeBody(p, r, owner, starter = false, alpha = 1, outlineScale = 1) {
  const fill = nodeFill(owner);
  ctx.save();
  ctx.globalAlpha = alpha;

  const depthDx = Math.max(1, r * 0.10);
  const depthDy = Math.max(1, r * 0.16);
  ctx.fillStyle = nodeShadow(owner);
  ctx.beginPath();
  ctx.arc(p.x + depthDx, p.y + depthDy, r, 0, Math.PI * 2);
  ctx.fill();

  const grad = ctx.createRadialGradient(p.x - r * 0.40, p.y - r * 0.42, r * 0.18, p.x, p.y, r * 1.18);
  if (owner === 0) {
    grad.addColorStop(0, '#ff7bff');
    grad.addColorStop(0.58, '#ff1dff');
    grad.addColorStop(1, '#d000d0');
  } else {
    grad.addColorStop(0, '#fffdf7');
    grad.addColorStop(0.62, '#f2f0e8');
    grad.addColorStop(1, '#d6d1c5');
  }
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
  ctx.fill();

  ctx.lineWidth = Math.max(starter ? 2.4 : 1.35, r * (starter ? 0.26 : 0.12)) * outlineScale;
  ctx.strokeStyle = '#000000';
  ctx.stroke();

  ctx.globalAlpha = alpha * 0.34;
  ctx.fillStyle = owner === 0 ? '#ffffff' : '#fffefb';
  ctx.beginPath();
  ctx.arc(p.x - r * 0.26, p.y - r * 0.28, r * 0.42, 0, Math.PI * 2);
  ctx.fill();

  if (starter) {
    ctx.globalAlpha = alpha;
    ctx.fillStyle = '#000000';
    ctx.beginPath();
    ctx.arc(p.x, p.y, r * 0.28, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function drawNodeGlow(cell, color = 'rgba(255,255,255,0.28)', alpha = 1, scale = 1) {
  if (!cell) return;
  const p = cellCenter(cell);
  const r = boardMetrics().cell * 0.23 * scale;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.shadowBlur = r * 1.35;
  ctx.shadowColor = color;
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(2, boardMetrics().cell * 0.06);
  ctx.beginPath();
  ctx.arc(p.x, p.y, r * 1.28, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

function eventToCell(evt) {
  if (!latestState) return null;
  const rect = board.getBoundingClientRect();
  const x = (evt.clientX - rect.left) * (board.width / rect.width);
  const y = (evt.clientY - rect.top) * (board.height / rect.height);
  const m = boardMetrics();
  const tx = Math.floor((x - m.ox) / m.cell);
  const ty = Math.floor((y - m.oy) / m.cell);
  if (tx < 0 || ty < 0 || tx >= m.totalW || ty >= m.totalH) return null;
  const cx = tx - m.previewX;
  const cy = ty - m.previewY;
  return [cx, cy];
}

function captureFadeEffects(prev, next) {
  const now = performance.now();
  const existing = fadeEffects.filter(f => now - f.t0 < f.duration);
  if (!prev || !next) {
    fadeEffects = existing;
    return;
  }
  const nextNodes = new Map((next.nodes || []).map(node => [`${node.x},${node.y}`, node]));
  for (const node of prev.nodes || []) {
    const key = `${node.x},${node.y}`;
    if (!nextNodes.has(key)) {
      existing.push({
        kind: 'node',
        x: node.x,
        y: node.y,
        owner: node.owner,
        starter: !!node.starter,
        t0: now,
        duration: 220,
      });
    }
  }
  fadeEffects = existing;
}

function cleanupFadeEffects() {
  const now = performance.now();
  fadeEffects = fadeEffects.filter(f => now - f.t0 < f.duration);
}

function renderState() {
  if (!latestState) return;
  cleanupDraftIfInvalid();
  renderMeta();
  resizeCanvas();
}

function renderMeta() {
  el('seat-line').textContent = latestState.my_name || 'Spectator';
  el('turn-line').textContent = latestState.winner === null ? `${latestState.current_owner_name} to move.` : '';
  el('winner-line').textContent = latestState.win_reason || '';
  el('castle0').textContent = latestState.starter_placed?.[0] ? 'Placed' : 'Unplaced';
  el('castle1').textContent = latestState.starter_placed?.[1] ? 'Placed' : 'Unplaced';
  const clock0 = el('um_clock0');
  const clock1 = el('um_clock1');
  if (clock0) clock0.textContent = latestState.settings?.time_limit_enabled ? formatClock(displayedClock(0)) : 'No clock';
  if (clock1) clock1.textContent = latestState.settings?.time_limit_enabled ? formatClock(displayedClock(1)) : 'No clock';
  const draftCount = (currentSegment && currentSegment.length > 1 ? 1 : 0) + draftSegments.length + (pendingNode ? 1 : 0);
  el('segment-count').textContent = String(draftCount);
  const seat = mySeat();
  const mineOwner = seat === null ? 0 : seat;
  const oppOwner = 1 - mineOwner;
  const privMineNode = el('priv-mine');
  const privOppNode = el('priv-opp');
  if (privMineNode) privMineNode.textContent = privilegeName(Number(latestState.privileges?.[String(mineOwner)] || 5));
  if (privOppNode) privOppNode.textContent = privilegeName(Number(latestState.privileges?.[String(oppOwner)] || 5));
  if (latestState.is_private && latestState.join_code) el('share-line').textContent = `Code: ${latestState.join_code}`;
  else el('share-line').textContent = latestState.status === 'open' ? `Share this URL: ${window.location.href}` : '';
  const stat0 = el('stat-player0');
  const stat1 = el('stat-player1');
  if (stat0) stat0.classList.toggle('active-turn', latestState.current_owner === 0 && latestState.winner === null);
  if (stat1) stat1.classList.toggle('active-turn', latestState.current_owner === 1 && latestState.winner === null);
  if (latestState.my_premove && !isMyTurn() && latestState.winner === null) {
    setStatus('Premove queued.');
  }
  renderLog();
  renderChat();
  renderDraftLine();
  updateActionButtons();
  renderEndPopup();
}

function renderEndPopup() {
  const wrap = el('um-end-popup');
  const textNode = el('um-end-popup-text');
  if (!wrap || !textNode || !latestState) return;
  const seat = mySeat();
  if (latestState.winner === null || seat === null) {
    wrap.classList.add('hidden');
    wrap.classList.remove('win', 'loss');
    return;
  }
  const won = latestState.winner === seat;
  wrap.classList.remove('hidden');
  wrap.classList.toggle('win', won);
  wrap.classList.toggle('loss', !won);
  textNode.textContent = won ? 'Win!' : 'Ded';
}


function renderLog() {
  const box = el('log');
  if (!box) return;
  box.innerHTML = '';
  for (const line of latestState.log || []) {
    const div = document.createElement('div');
    div.className = 'log-entry';
    div.textContent = line;
    box.appendChild(div);
  }
  box.scrollTop = box.scrollHeight;
}

function renderChat() {
  const box = el('chat-box');
  if (!box) return;
  const oldHeight = box.scrollHeight;
  const nearBottom = box.scrollTop + box.clientHeight >= oldHeight - 20;
  box.innerHTML = '';
  for (const msg of latestState.chat || []) {
    const div = document.createElement('div');
    div.className = `chat-entry owner-${msg.owner}`;
    div.innerHTML = `<div class="chat-name">${msg.name}</div><div class="chat-text"></div>`;
    div.querySelector('.chat-text').textContent = msg.text;
    box.appendChild(div);
  }
  if (nearBottom) box.scrollTop = box.scrollHeight;
}

function renderDraftLine() {
  const node = el('draft-line');
  if (!node) return;
  if (!latestState) {
    node.textContent = 'No draft.';
    return;
  }
  if (!latestState.starter_placed?.[mySeat() ?? 0]) {
    node.textContent = 'Place your castle on a blue edge square on your side of the board.';
    return;
  }
  if (pendingNode) {
    node.textContent = `Pending node at ${pendingNode[0] + 1},${pendingNode[1] + 1}. Click the same square again to confirm. Click anywhere else to clear.`;
    return;
  }
  if (currentSegment && currentSegment.length > 1) {
    const end = currentSegment[currentSegment.length - 1];
    node.textContent = `Drag orthogonally from ${end[0] + 1},${end[1] + 1}, then click a friendly node to finish this segment.`;
    return;
  }
  if (draftSegments.length > 0 && currentSegment && currentSegment.length === 1) {
    const end = currentSegment[0];
    node.textContent = `Chain ready at ${end[0] + 1},${end[1] + 1}. Click this node and drag another segment, or Confirm Turn to submit.`;
    return;
  }
  if (draftSegments.length > 0) {
    node.textContent = 'Pending path chain. Click Confirm Turn to submit.';
    return;
  }
  if (currentSegment && currentSegment.length === 1) {
    const end = currentSegment[0];
    node.textContent = `Path start at ${end[0] + 1},${end[1] + 1}. Move the mouse to trace the path, then click a friendly end node.`;
    return;
  }
  node.textContent = 'Click an unlocked empty square to place a node, or click a friendly node to start a path.';
}

function updateActionButtons() {
  const canConfirmNode = false;
  const canConfirmPath = canDraftOrQueue() && draftSegments.length > 0 && (!currentSegment || currentSegment.length <= 1);
  const confirmButton = el('commit-path');
  const showConfirm = requireMoveConfirmation() || draftSegments.length > 0;
  if (confirmButton) {
    confirmButton.style.display = showConfirm ? '' : 'none';
    confirmButton.disabled = !(canConfirmNode || canConfirmPath);
    confirmButton.textContent = 'Confirm Turn';
  }
  const clearButton = el('clear-draft');
  if (clearButton) clearButton.disabled = !pendingNode && draftSegments.length === 0 && !currentSegment;
}

function drawBoard() {
  if (!latestState) return;
  cleanupFadeEffects();
  const m = boardMetrics();
  const boardGrid = latestState.board?.grid || [];
  ctx.clearRect(0, 0, board.width, board.height);
  ctx.fillStyle = '#0a0f14';
  ctx.fillRect(0, 0, board.width, board.height);

  for (let y = 0; y < m.totalH; y++) {
    for (let x = 0; x < m.totalW; x++) {
      const activeX = x - m.previewX;
      const activeY = y - m.previewY;
      let fill = '#4575b4';
      let alpha = 0.28;
      if (activeX >= 0 && activeY >= 0 && activeX < m.width && activeY < m.height) {
        fill = elevationColor((boardGrid[activeY] || [])[activeX] || 5);
        alpha = 1;
      }
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.fillStyle = fill;
      ctx.fillRect(m.ox + x * m.cell, m.oy + y * m.cell, m.cell, m.cell);
      ctx.restore();
    }
  }

  ctx.strokeStyle = 'rgba(0,0,0,0.22)';
  ctx.lineWidth = 1;
  for (let x = 0; x <= m.totalW; x++) {
    const px = m.ox + x * m.cell;
    ctx.beginPath();
    ctx.moveTo(px, m.oy);
    ctx.lineTo(px, m.oy + m.boardH);
    ctx.stroke();
  }
  for (let y = 0; y <= m.totalH; y++) {
    const py = m.oy + y * m.cell;
    ctx.beginPath();
    ctx.moveTo(m.ox, py);
    ctx.lineTo(m.ox + m.boardW, py);
    ctx.stroke();
  }

  drawPaths(m, pathList());
  drawDraftPaths(m);
  drawPremovePreview(m);
  drawHoverMarker(m);
  drawPendingNode(m);
  drawSelectionGlows(m);
  drawNodes(m);
  drawFadeEffects(m);
}

function elevationColor(level) {
  return ({1:'#d73027',2:'#fc8d59',3:'#fee08b',4:'#91cf60',5:'#4575b4'})[Number(level)] || '#4575b4';
}

function privilegeName(level) {
  return ({1:'Red',2:'Orange',3:'Yellow',4:'Green',5:'Blue'})[Number(level)] || 'Blue';
}

function drawPaths(m, paths) {
  for (const path of paths) {
    const cells = path.cells || [];
    if (cells.length < 2) continue;
    const color = PLAYER_COLORS[path.owner] || '#ffffff';
    const outlineW = Math.max(6.5, m.cell * 0.28);
    const fillW = Math.max(3.2, m.cell * 0.145);
    ctx.save();
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    ctx.lineWidth = outlineW;
    ctx.strokeStyle = 'rgba(0,0,0,0.22)';
    ctx.beginPath();
    const firstShadow = cellCenter(cells[0], m);
    ctx.moveTo(firstShadow.x, firstShadow.y + Math.max(1, m.cell * 0.045));
    for (const cell of cells.slice(1)) {
      const p = cellCenter(cell, m);
      ctx.lineTo(p.x, p.y + Math.max(1, m.cell * 0.045));
    }
    ctx.stroke();

    ctx.lineWidth = outlineW;
    ctx.strokeStyle = PLAYER_OUTLINES[path.owner] || '#000000';
    ctx.beginPath();
    const first = cellCenter(cells[0], m);
    ctx.moveTo(first.x, first.y);
    for (const cell of cells.slice(1)) {
      const p = cellCenter(cell, m);
      ctx.lineTo(p.x, p.y);
    }
    ctx.stroke();

    ctx.lineWidth = fillW;
    ctx.strokeStyle = color;
    ctx.stroke();

    ctx.lineWidth = Math.max(1.2, m.cell * 0.045);
    ctx.strokeStyle = path.owner === 0 ? 'rgba(255,180,255,0.28)' : 'rgba(255,255,255,0.22)';
    ctx.beginPath();
    ctx.moveTo(first.x, first.y - Math.max(0.6, m.cell * 0.018));
    for (const cell of cells.slice(1)) {
      const p = cellCenter(cell, m);
      ctx.lineTo(p.x, p.y - Math.max(0.6, m.cell * 0.018));
    }
    ctx.stroke();

    ctx.restore();
  }
}

function drawDraftPaths(m) {
  const pseudo = [];
  for (let idx = 0; idx < draftSegments.length; idx++) {
    pseudo.push({ owner: mySeat() ?? 0, cells: draftSegments[idx], path_id: -1000 - idx });
  }
  if (currentSegment && currentSegment.length > 0) {
    let previewCells = currentSegment;
    const seat = mySeat();
    const hoverNode = hoverCell ? nodeAt(hoverCell) : null;
    if (hoverCell && hoverNode && seat !== null && hoverNode.owner === seat && canStepTo(hoverCell)) {
      previewCells = [...currentSegment, hoverCell];
    }
    if (previewCells.length > 1) {
      pseudo.push({ owner: seat ?? 0, cells: previewCells, path_id: -2000 });
    }
  }
  if (!pseudo.length) return;
  ctx.save();
  ctx.globalAlpha = 0.6;
  drawPaths(m, pseudo);
  ctx.restore();
}

function premovePreviewPaths() {
  const action = myPremoveAction();
  if (!action || isMyTurn()) return [];
  if (action.type !== 'um_paths') return [];
  const seat = mySeat();
  return (action.segments || []).filter(seg => Array.isArray(seg) && seg.length > 1)
    .map((seg, idx) => ({ owner: seat ?? 0, cells: seg, path_id: -3000 - idx }));
}

function premovePreviewNode() {
  const action = myPremoveAction();
  if (!action || isMyTurn()) return null;
  if (action.type === 'starter' || action.type === 'um_node') {
    return [Number(action.x), Number(action.y)];
  }
  return null;
}

function drawPremovePreview(m) {
  if (!latestState || !latestState.my_premove || isMyTurn()) return;
  const paths = premovePreviewPaths();
  if (paths.length) {
    ctx.save();
    ctx.globalAlpha = 0.34;
    ctx.setLineDash([Math.max(6, m.cell * 0.25), Math.max(4, m.cell * 0.18)]);
    drawPaths(m, paths);
    ctx.restore();
  }
  const nodeCell = premovePreviewNode();
  if (!nodeCell) return;
  const p = cellCenter(nodeCell, m);
  const r = m.cell * 0.26;
  const owner = mySeat() ?? 0;
  ctx.save();
  const isWhiteSeat = owner === 1;
  ctx.globalAlpha = isWhiteSeat ? 0.62 : 0.4;
  ctx.lineWidth = Math.max(2, m.cell * 0.06);
  ctx.strokeStyle = isWhiteSeat ? '#555555' : (PLAYER_COLORS[owner] || '#ffffff');
  ctx.setLineDash([Math.max(5, m.cell * 0.18), Math.max(3, m.cell * 0.12)]);
  if (isWhiteSeat) {
    ctx.fillStyle = 'rgba(255,255,255,0.16)';
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.beginPath();
  ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
  ctx.stroke();
  if (actionIsStarterPremove()) {
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.beginPath();
    ctx.arc(p.x, p.y, r * 0.22, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function actionIsStarterPremove() {
  const action = myPremoveAction();
  return !!action && !isMyTurn() && action.type === 'starter';
}

function drawHoverMarker(m) {
  if (!hoverCell) return;
  const p = cellCenter(hoverCell, m);
  ctx.save();
  ctx.strokeStyle = 'rgba(255,255,255,0.55)';
  ctx.lineWidth = 2;
  ctx.strokeRect(p.x - m.cell * 0.42, p.y - m.cell * 0.42, m.cell * 0.84, m.cell * 0.84);
  ctx.restore();
}

function drawSelectionGlows(m) {
  if (pendingNode) {
    drawNodeGlow(pendingNode, 'rgba(255, 220, 110, 0.70)', 0.95, 1.02);
  }
  if (currentSegment && currentSegment.length) {
    drawNodeGlow(currentSegment[0], 'rgba(255,255,255,0.26)', 0.9, 1.00);
    const end = currentSegment[currentSegment.length - 1];
    if (!sameCell(end, currentSegment[0]) || currentSegment.length > 1) {
      drawNodeGlow(end, 'rgba(255, 215, 120, 0.72)', 1, 1.08);
    }
  }
}

function drawPendingNode(m) {
  if (!pendingNode) return;
  const p = cellCenter(pendingNode, m);
  const r = m.cell * 0.23;
  drawNodeBody(p, r, mySeat() ?? 0, false, 0.68, 0.95);
}

function drawNodes(m) {
  for (const node of latestState.nodes || []) {
    const p = cellCenter([node.x, node.y], m);
    const r = m.cell * 0.23;
    drawNodeBody(p, r, node.owner, !!node.starter, 1, 1);
  }
}

function drawFadeEffects(m) {
  const now = performance.now();
  for (const fx of fadeEffects) {
    const age = Math.min(1, (now - fx.t0) / fx.duration);
    const p = cellCenter([fx.x, fx.y], m);
    const r = m.cell * (0.23 * (1 - age * 0.36));
    drawNodeBody(p, r, fx.owner, !!fx.starter, 1 - age, 1);
  }
}

function cleanupDraftIfInvalid() {
  if (!latestState) return;
  const seat = mySeat();
  if (seat === null || !canDraftOrQueue()) {
    pendingNode = null;
    currentSegment = null;
    draftSegments = [];
    return;
  }
  if (pendingNode) {
    const nk = keyOf(pendingNode);
    const occ = pathOccupancy();
    const occPaths = occ.get(nk) || [];
    if (nodeAt(pendingNode) || occPaths.some(path => path.owner !== seat) || (!isActiveBoardCell(pendingNode) && !isPreviewRingCell(pendingNode))) pendingNode = null;
  }
  draftSegments = draftSegments.filter(seg => Array.isArray(seg) && seg.length >= 2 && seg.every(cell => Array.isArray(cell) && cell.length === 2));
  if (currentSegment && currentSegment.length) {
    const startNode = nodeAt(currentSegment[0]);
    if (!startNode || startNode.owner !== seat || !isActiveBoardCell(currentSegment[0])) currentSegment = null;
  }
}

function clearDraft() {
  pendingNode = null;
  currentSegment = null;
  draftSegments = [];
  renderState();
}

function ownHalf(cell, seat) {
  const split = (latestState?.board?.width || 0) / 2;
  return seat === 0 ? cell[0] < split : cell[0] >= split;
}

function barrierActive() { return false; }

function countCorners(seg) {
  if (!seg || seg.length < 3) return 0;
  let corners = 0;
  let prevDir = null;
  for (let i = 1; i < seg.length; i++) {
    const d = [seg[i][0] - seg[i - 1][0], seg[i][1] - seg[i - 1][1]];
    if (prevDir && (d[0] !== prevDir[0] || d[1] !== prevDir[1])) corners += 1;
    prevDir = d;
  }
  return corners;
}

function usedSegmentStartKeys() {
  return new Set(draftSegments.map(seg => keyOf(seg[0])));
}


function canDragExtendTo(cell) {
  const seat = mySeat();
  if (!latestState || seat === null || !currentSegment || !currentSegment.length) return false;
  const prev = currentSegment[currentSegment.length - 1];
  if (!isActiveBoardCell(cell)) return false;
  if (barrierActive() && !ownHalf(cell, seat)) return false;
  if (Math.abs(cell[0] - prev[0]) + Math.abs(cell[1] - prev[1]) !== 1) return false;
  if (currentSegment.some(c => sameCell(c, cell))) return false;
  const node = nodeAt(cell);
  if (node && node.owner === seat) return false;
  if (node && node.starter) return false;
  const ownOcc = pathOccupancy(seat);
  if (ownOcc.has(keyOf(cell))) return false;
  for (const seg of draftSegments) {
    for (const internal of seg.slice(1, -1)) {
      if (sameCell(internal, cell)) return false;
    }
  }
  const nextSeg = [...currentSegment, cell];
  return countCorners(nextSeg) <= 1;
}

function extendPathByDrag(cell) {
  if (!currentSegment || !currentSegment.length) return false;
  if (sameCell(cell, currentSegment[currentSegment.length - 1])) return false;
  if (currentSegment.length > 1 && sameCell(cell, currentSegment[currentSegment.length - 2])) {
    currentSegment.pop();
    renderState();
    return true;
  }
  if (!canDragExtendTo(cell)) return false;
  currentSegment = [...currentSegment, cell];
  renderState();
  return true;
}

function canStepTo(cell) {
  const seat = mySeat();
  if (!latestState || seat === null || !currentSegment || !currentSegment.length) return false;
  const prev = currentSegment[currentSegment.length - 1];
  if (!isActiveBoardCell(cell)) return false;
  if (barrierActive() && !ownHalf(cell, seat)) return false;
  if (Math.abs(cell[0] - prev[0]) + Math.abs(cell[1] - prev[1]) !== 1) return false;
  if (currentSegment.some(c => sameCell(c, cell))) return false;
  const node = nodeAt(cell);
  if (node && node.owner === seat) return true;
  if (node && node.starter) return false;
  const ownOcc = pathOccupancy(seat);
  if (ownOcc.has(keyOf(cell))) return false;
  for (const seg of draftSegments) {
    for (const internal of seg.slice(1, -1)) {
      if (sameCell(internal, cell)) return false;
    }
  }
  const nextSeg = [...currentSegment, cell];
  return countCorners(nextSeg) <= 1;
}

function sendPendingNode() {
  if (!pendingNode) return;
  const payload = { type: 'um_node', x: pendingNode[0], y: pendingNode[1] };
  if (!isMyTurn() && isPreviewRingCell(pendingNode)) {
    payload.preview_ref = { width: latestState.board?.width || 0, height: latestState.board?.height || 0 };
  }
  sendUmAction(payload);
  pendingNode = null;
  renderState();
}

function sendPendingPaths() {
  if (!draftSegments.length) return;
  sendUmAction({ type: 'um_paths', segments: draftSegments });
  clearDraft();
}

function commitPendingTurn() {
  if (!canDraftOrQueue()) return;
  if (pendingNode) {
    sendPendingNode();
    return;
  }
  if (draftSegments.length > 0) {
    sendPendingPaths();
  }
}

function handleNodePlacement(cell) {
  const seat = mySeat();
  if (seat === null) return;
  const occ = pathOccupancy();
  const nk = keyOf(cell);
  const occPaths = occ.get(nk) || [];
  const previewCell = isPreviewRingCell(cell);
  if (previewCell && isMyTurn()) {
    setStatus('That square is outside the active board.', true);
    return;
  }
  if (!isActiveBoardCell(cell) && !previewCell) return;
  if (barrierActive() && isActiveBoardCell(cell) && !ownHalf(cell, seat)) {
    setStatus('Enemy side is off-limits until the starting barrier is removed.', true);
    return;
  }
  if (nodeAt(cell)) {
    setStatus('That square is occupied.', true);
    return;
  }
  if (occPaths.some(path => path.owner !== seat)) {
    setStatus('You may only place a node on your own path.', true);
    return;
  }
  currentSegment = null;
  draftSegments = [];
  if (pendingNode && sameCell(pendingNode, cell)) {
    sendPendingNode();
    return;
  }
  pendingNode = cell;
  renderState();
}

function startPathFrom(cell) {
  const seat = mySeat();
  const node = nodeAt(cell);
  if (seat === null || !node || node.owner !== seat) {
    setStatus('Start path drawing from a friendly node.', true);
    return;
  }
  pendingNode = null;
  if (!draftSegments.length) {
    currentSegment = [cell];
    renderState();
    return;
  }
  const lastEnd = draftSegments[draftSegments.length - 1].slice(-1)[0];
  if (!sameCell(cell, lastEnd)) {
    setStatus('A chain must continue from the node you just reached.', true);
    return;
  }
  currentSegment = [cell];
  renderState();
}

function finishCurrentSegment(cell) {
  const seat = mySeat();
  const node = nodeAt(cell);
  if (seat === null || !currentSegment || currentSegment.length < 1) return;
  if (!node || node.owner !== seat) {
    setStatus('Finish the path by clicking a friendly node.', true);
    return;
  }
  if (!canStepTo(cell)) {
    setStatus(`Invalid end node. Use orthogonal moves and at most ${1} corner${1 === 1 ? '' : 's'} per segment.`, true);
    return;
  }
  const usedStarts = usedSegmentStartKeys();
  if (usedStarts.has(keyOf(cell))) {
    setStatus('You cannot end on a node that already started a segment this turn.', true);
    return;
  }
  const segment = [...currentSegment, cell];
  draftSegments = [...draftSegments, segment];
  currentSegment = [cell];
  renderState();
}

function handleBoardClick(evt) {
  if (!latestState) return;
  const cell = eventToCell(evt);
  if (!cell) return;
  const seat = mySeat();
  if (seat === null || !canDraftOrQueue()) return;
  const minePlaced = latestState.starter_placed?.[seat];
  if (!minePlaced) {
    if (!isActiveBoardCell(cell)) return;
    if (!ownHalf(cell, seat)) {
      setStatus('Your castle must be placed on your side.', true);
      return;
    }
    sendUmAction({ type: 'starter', x: cell[0], y: cell[1] });
    return;
  }

  if (currentSegment && currentSegment.length) {
    const node = nodeAt(cell);
    if (node && node.owner === seat) {
      if (sameCell(cell, currentSegment[0]) && currentSegment.length === 1) {
        if (draftSegments.length > 0) {
          commitPendingTurn();
          return;
        }
        renderState();
        return;
      }
      finishCurrentSegment(cell);
      return;
    }
    clearDraft();
    return;
  }

  if (pendingNode) {
    if (sameCell(cell, pendingNode)) {
      sendPendingNode();
    } else {
      pendingNode = null;
      renderState();
    }
    return;
  }

  const node = nodeAt(cell);
  if (isActiveBoardCell(cell) && node && node.owner === seat) {
    startPathFrom(cell);
    return;
  }

  handleNodePlacement(cell);
}

function handleMouseMove(evt) {
  hoverCell = eventToCell(evt);
  if (currentSegment && currentSegment.length && canDraftOrQueue() && hoverCell) {
    extendPathByDrag(hoverCell);
  }
  drawBoard();
}

function tick() {
  if (!latestState) return;
  renderMeta();
}

function setupUi() {
  board.addEventListener('click', handleBoardClick);
  board.addEventListener('mousemove', handleMouseMove);
  board.addEventListener('mouseleave', () => { hoverCell = null; drawBoard(); });
  window.addEventListener('resize', resizeCanvas);
  el('commit-path').addEventListener('click', commitPendingTurn);
  el('clear-draft').addEventListener('click', () => {
    if (!isMyTurn() && myPremoveAction()) {
      send({ type: 'clear_premove' });
      setStatus('Premove cleared.');
      return;
    }
    clearDraft();
  });
  el('resign').addEventListener('click', () => send({ type: 'resign' }));
  el('chat-form').addEventListener('submit', (evt) => {
    evt.preventDefault();
    const input = el('chat-input');
    const text = input.value.trim();
    if (!text) return;
    send({ type: 'chat', text });
    input.value = '';
  });
}

setupUi();
resizeCanvas();
connect();
setInterval(tick, 1000);
requestAnimationFrame(function loop() {
  if (fadeEffects.length) drawBoard();
  requestAnimationFrame(loop);
});
