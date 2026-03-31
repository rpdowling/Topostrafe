const gameId = window.TOPOS_GAME_ID;
const playerKey = new URLSearchParams(window.location.search).get('player') || '';
const board = document.getElementById('board');
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

const PLAYER_COLORS = { 0: '#ff00ff', 1: '#ffffff' };
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

function requireMoveConfirmation() {
  return !!latestState?.settings?.require_move_confirmation;
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


function resizeCanvas() {
  if (!board) return;
  const panel = board.parentElement;
  const toolbar = panel?.querySelector('.toolbar');
  const panelWidth = Math.max(480, Math.floor((panel?.clientWidth || 1200) - 2));
  const availableHeight = Math.max(420, Math.floor(window.innerHeight - (toolbar?.offsetHeight || 56) - 70));
  const aspect = 11 / 9;
  let width = panelWidth;
  let height = Math.floor(width / aspect);
  if (height > availableHeight) {
    height = availableHeight;
    width = Math.floor(height * aspect);
  }
  board.width = width;
  board.height = height;
  drawBoard();
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
  const width = latestState?.board?.width || 10;
  const height = latestState?.board?.height || 10;
  const pad = 40;
  const usableW = board.width - pad * 2;
  const usableH = board.height - pad * 2;
  const cell = Math.floor(Math.min(usableW / Math.max(1, width), usableH / Math.max(1, height)));
  const boardW = cell * width;
  const boardH = cell * height;
  const ox = Math.floor((board.width - boardW) / 2);
  const oy = Math.floor((board.height - boardH) / 2);
  return { width, height, cell, boardW, boardH, ox, oy };
}

function cellCenter(cell, m = boardMetrics()) {
  return {
    x: m.ox + (cell[0] + 0.5) * m.cell,
    y: m.oy + (cell[1] + 0.5) * m.cell,
  };
}

function eventToCell(evt) {
  if (!latestState) return null;
  const rect = board.getBoundingClientRect();
  const x = (evt.clientX - rect.left) * (board.width / rect.width);
  const y = (evt.clientY - rect.top) * (board.height / rect.height);
  const m = boardMetrics();
  const cx = Math.floor((x - m.ox) / m.cell);
  const cy = Math.floor((y - m.oy) / m.cell);
  if (cx < 0 || cy < 0 || cx >= m.width || cy >= m.height) return null;
  return [cx, cy];
}

function captureFadeEffects(prev, next) {
  if (!prev || !next) return;
  const prevNodes = new Map((prev.nodes || []).map(n => [`${n.x},${n.y}`, n]));
  const nextNodes = new Set((next.nodes || []).map(n => `${n.x},${n.y}`));
  const now = performance.now();
  for (const [key, node] of prevNodes.entries()) {
    if (nextNodes.has(key)) continue;
    const [x, y] = parseKey(key);
    fadeEffects.push({ type: 'node', x, y, owner: node.owner, starter: !!node.starter, t0: now, duration: 550 });
  }
}

function cleanupFadeEffects() {
  const now = performance.now();
  fadeEffects = fadeEffects.filter(f => now - f.t0 < f.duration);
}

function renderState() {
  if (!latestState) return;
  cleanupDraftIfInvalid();
  renderMeta();
  drawBoard();
}

function renderMeta() {
  el('seat-line').textContent = latestState.my_name || 'Spectator';
  el('turn-line').textContent = latestState.winner === null ? `${latestState.current_owner_name} to move.` : '';
  el('winner-line').textContent = latestState.win_reason || '';
  el('castle0').textContent = latestState.starter_placed?.[0] ? 'Placed' : 'Unplaced';
  el('castle1').textContent = latestState.starter_placed?.[1] ? 'Placed' : 'Unplaced';
  const draftCount = (currentSegment && currentSegment.length > 1 ? 1 : 0) + draftSegments.length + (pendingNode ? 1 : 0);
  el('segment-count').textContent = String(draftCount);
  el('share-line').textContent = latestState.join_code ? `Code: ${latestState.join_code}` : '';
  const stat0 = el('stat-player0');
  const stat1 = el('stat-player1');
  if (stat0) stat0.classList.toggle('active-turn', latestState.current_owner === 0 && latestState.winner === null);
  if (stat1) stat1.classList.toggle('active-turn', latestState.current_owner === 1 && latestState.winner === null);
  renderLog();
  renderChat();
  renderDraftLine();
  updateActionButtons();
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
    node.textContent = 'Place your castle on your side of the board.';
    return;
  }
  if (pendingNode) {
    node.textContent = `Pending node at ${pendingNode[0] + 1},${pendingNode[1] + 1}. ${requireMoveConfirmation() ? 'Click Confirm Turn or click the same square again.' : ''}`.trim();
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
  node.textContent = 'Click an empty square to place a node, or click a friendly node to start a path.';
}

function updateActionButtons() {
  const canConfirmNode = isMyTurn() && !!pendingNode;
  const canConfirmPath = isMyTurn() && draftSegments.length > 0 && (!currentSegment || currentSegment.length <= 1);
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
  const boardColor = latestState.board?.color || '#efe3a3';
  ctx.clearRect(0, 0, board.width, board.height);
  ctx.fillStyle = '#0a0f14';
  ctx.fillRect(0, 0, board.width, board.height);
  ctx.fillStyle = boardColor;
  ctx.fillRect(m.ox, m.oy, m.boardW, m.boardH);

  ctx.strokeStyle = 'rgba(0,0,0,0.22)';
  ctx.lineWidth = 1;
  for (let x = 0; x <= m.width; x++) {
    const px = m.ox + x * m.cell;
    ctx.beginPath();
    ctx.moveTo(px, m.oy);
    ctx.lineTo(px, m.oy + m.boardH);
    ctx.stroke();
  }
  for (let y = 0; y <= m.height; y++) {
    const py = m.oy + y * m.cell;
    ctx.beginPath();
    ctx.moveTo(m.ox, py);
    ctx.lineTo(m.ox + m.boardW, py);
    ctx.stroke();
  }

  if (!latestState.starter_placed?.every(Boolean)) {
    const splitX = m.ox + (m.width / 2) * m.cell;
    ctx.save();
    ctx.strokeStyle = 'rgba(0,0,0,0.78)';
    ctx.setLineDash([12, 10]);
    ctx.lineWidth = Math.max(2, m.cell * 0.05);
    ctx.beginPath();
    ctx.moveTo(splitX, m.oy);
    ctx.lineTo(splitX, m.oy + m.boardH);
    ctx.stroke();
    ctx.restore();
  }

  drawPaths(m, pathList());
  drawDraftPaths(m);
  drawHoverMarker(m);
  drawPendingNode(m);
  drawNodes(m);
  drawFadeEffects(m);
}

function drawPaths(m, paths) {
  for (const path of paths) {
    const cells = path.cells || [];
    if (cells.length < 2) continue;
    const color = PLAYER_COLORS[path.owner] || '#ffffff';
    ctx.save();
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.lineWidth = Math.max(6, m.cell * 0.26);
    ctx.strokeStyle = PLAYER_OUTLINES[path.owner] || '#000000';
    ctx.beginPath();
    const first = cellCenter(cells[0], m);
    ctx.moveTo(first.x, first.y);
    for (const cell of cells.slice(1)) {
      const p = cellCenter(cell, m);
      ctx.lineTo(p.x, p.y);
    }
    ctx.stroke();
    ctx.lineWidth = Math.max(3, m.cell * 0.14);
    ctx.strokeStyle = color;
    ctx.stroke();
    ctx.restore();
  }
}

function drawDraftPaths(m) {
  const pseudo = [];
  for (let idx = 0; idx < draftSegments.length; idx++) {
    pseudo.push({ owner: mySeat() ?? 0, cells: draftSegments[idx], path_id: -1000 - idx });
  }
  if (currentSegment && currentSegment.length > 1) {
    pseudo.push({ owner: mySeat() ?? 0, cells: currentSegment, path_id: -2000 });
  }
  if (!pseudo.length) return;
  ctx.save();
  ctx.globalAlpha = 0.6;
  drawPaths(m, pseudo);
  ctx.restore();
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

function drawPendingNode(m) {
  if (!pendingNode) return;
  const p = cellCenter(pendingNode, m);
  const r = m.cell * 0.23;
  ctx.save();
  ctx.globalAlpha = 0.6;
  ctx.lineWidth = Math.max(2, m.cell * 0.06);
  ctx.strokeStyle = '#000000';
  ctx.fillStyle = PLAYER_COLORS[mySeat() ?? 0] || '#ff00ff';
  ctx.beginPath();
  ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

function drawNodes(m) {
  for (const node of latestState.nodes || []) {
    const p = cellCenter([node.x, node.y], m);
    const r = m.cell * 0.23;
    const fill = node.owner === 0 ? '#ff00ff' : '#ffffff';
    ctx.save();
    ctx.lineWidth = Math.max(2, m.cell * 0.06);
    ctx.strokeStyle = '#000000';
    ctx.fillStyle = fill;
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    if (node.starter) {
      ctx.fillStyle = '#000000';
      ctx.beginPath();
      ctx.arc(p.x, p.y, r * 0.28, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }
}

function drawFadeEffects(m) {
  const now = performance.now();
  for (const fx of fadeEffects) {
    const age = Math.min(1, (now - fx.t0) / fx.duration);
    const p = cellCenter([fx.x, fx.y], m);
    const r = m.cell * (0.22 + age * 0.12);
    ctx.save();
    ctx.globalAlpha = 1 - age;
    ctx.lineWidth = Math.max(2, m.cell * 0.05);
    ctx.strokeStyle = '#000000';
    ctx.fillStyle = fx.owner === 0 ? '#ff00ff' : '#ffffff';
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    if (fx.starter) {
      ctx.fillStyle = '#000000';
      ctx.beginPath();
      ctx.arc(p.x, p.y, r * 0.28, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }
}

function cleanupDraftIfInvalid() {
  if (!latestState) return;
  const seat = mySeat();
  if (seat === null) {
    clearDraft();
    return;
  }
  if (pendingNode) {
    const occ = pathOccupancy();
    const nk = keyOf(pendingNode);
    if (nodeAt(pendingNode) || occ.has(nk)) pendingNode = null;
  }
  draftSegments = draftSegments.filter(seg => Array.isArray(seg) && seg.length >= 2 && seg.every(cell => Array.isArray(cell) && cell.length === 2));
  if (currentSegment && currentSegment.length) {
    const startNode = nodeAt(currentSegment[0]);
    if (!startNode || startNode.owner !== seat) currentSegment = null;
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
  return countCorners(nextSeg) <= Number(latestState.settings.max_corners || 1);
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
  return countCorners(nextSeg) <= Number(latestState.settings.max_corners || 1);
}

function sendPendingNode() {
  if (!pendingNode) return;
  send({ type: 'um_node', x: pendingNode[0], y: pendingNode[1] });
  pendingNode = null;
  renderState();
}

function sendPendingPaths() {
  if (!draftSegments.length) return;
  send({ type: 'um_paths', segments: draftSegments });
  clearDraft();
}

function commitPendingTurn() {
  if (!isMyTurn()) return;
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
  if (nodeAt(cell) || occ.has(nk)) {
    setStatus('That square is occupied.', true);
    return;
  }
  currentSegment = null;
  draftSegments = [];
  if (requireMoveConfirmation()) {
    if (pendingNode && sameCell(pendingNode, cell)) {
      sendPendingNode();
      return;
    }
    pendingNode = cell;
    renderState();
    return;
  }
  pendingNode = null;
  send({ type: 'um_node', x: cell[0], y: cell[1] });
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
    setStatus(`Invalid end node. Use orthogonal moves and at most ${latestState.settings.max_corners} corner${latestState.settings.max_corners === 1 ? '' : 's'} per segment.`, true);
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
  if (!isMyTurn() || seat === null) return;
  const minePlaced = latestState.starter_placed?.[seat];
  if (!minePlaced) {
    if (!ownHalf(cell, seat)) {
      setStatus('Your castle must be placed on your side.', true);
      return;
    }
    send({ type: 'starter', x: cell[0], y: cell[1] });
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
    if (!node && currentSegment.length === 1) {
      clearDraft();
      return;
    }
    if (canStepTo(cell)) {
      currentSegment = [...currentSegment, cell];
      renderState();
      return;
    }
    setStatus('Trace the path with the mouse, then click a friendly end node.', true);
    return;
  }

  const node = nodeAt(cell);
  if (node && node.owner === seat) {
    startPathFrom(cell);
    return;
  }

  handleNodePlacement(cell);
}

function handleMouseMove(evt) {
  hoverCell = eventToCell(evt);
  if (currentSegment && currentSegment.length && isMyTurn() && hoverCell) {
    extendPathByDrag(hoverCell);
  }
  drawBoard();
}

function setupUi() {
  board.addEventListener('click', handleBoardClick);
  board.addEventListener('mousemove', handleMouseMove);
  board.addEventListener('mouseleave', () => { hoverCell = null; drawBoard(); });
  window.addEventListener('resize', resizeCanvas);
  el('commit-path').addEventListener('click', commitPendingTurn);
  el('clear-draft').addEventListener('click', clearDraft);
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
