const defaults = window.TOPOS_DEFAULTS;
const ELEVATION_COLORS = {1:'#d73027',2:'#fc8d59',3:'#fee08b',4:'#91cf60',5:'#4575b4'};
const canvas = document.getElementById('editor-board');
const ctx = canvas.getContext('2d');
let boardGeom = {cell: 20, ox: 10, oy: 10};
let mapData = null;
let painting = false;
let lastPainted = null;

function el(id) { return document.getElementById(id); }
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function setStatus(msg) { el('editor-status').textContent = msg || ''; }
function deepCopyMap(data) { return { width: data.width, height: data.height, grid: data.grid.map(r => r.slice()) }; }

function validNeighbors4(x, y, w, h) {
  const out = [];
  if (x > 0) out.push([x - 1, y]);
  if (x + 1 < w) out.push([x + 1, y]);
  if (y > 0) out.push([x, y - 1]);
  if (y + 1 < h) out.push([x, y + 1]);
  return out;
}

function forceLowestEdges(data) {
  for (let x = 0; x < data.width; x++) {
    data.grid[0][x] = 5;
    data.grid[data.height - 1][x] = 5;
  }
  for (let y = 0; y < data.height; y++) {
    data.grid[y][0] = 5;
    data.grid[y][data.width - 1] = 5;
  }
}

function syncJson() {
  forceLowestEdges(mapData);
  el('editor_json').value = JSON.stringify(mapData);
}

function computeGeom() {
  const pad = 20;
  const cell = Math.max(8, Math.floor(Math.min((canvas.clientWidth - pad * 2) / mapData.width, (canvas.clientHeight - pad * 2) / mapData.height)));
  const ox = Math.floor((canvas.clientWidth - cell * mapData.width) / 2);
  const oy = Math.floor((canvas.clientHeight - cell * mapData.height) / 2);
  return { cell, ox, oy };
}

function resizeCanvas() {
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.floor(rect.width * dpr);
  canvas.height = Math.floor(rect.height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  draw();
}

function hitCell(evt) {
  if (!mapData) return null;
  const rect = canvas.getBoundingClientRect();
  const x = evt.clientX - rect.left;
  const y = evt.clientY - rect.top;
  const { cell, ox, oy } = boardGeom;
  const gx = Math.floor((x - ox) / cell);
  const gy = Math.floor((y - oy) / cell);
  if (gx < 0 || gy < 0 || gx >= mapData.width || gy >= mapData.height) return null;
  return [gx, gy];
}

function drawReferenceDots() {
  const centerVX = Math.round(mapData.width / 2);
  const centerVY = Math.round(mapData.height / 2);
  const every = 5;
  ctx.save();
  ctx.fillStyle = '#000';
  for (let vy = centerVY % every; vy <= mapData.height; vy += every) {
    for (let vx = centerVX % every; vx <= mapData.width; vx += every) {
      const cx = boardGeom.ox + vx * boardGeom.cell;
      const cy = boardGeom.oy + vy * boardGeom.cell;
      ctx.beginPath();
      ctx.arc(cx, cy, Math.max(2, boardGeom.cell * 0.07), 0, Math.PI * 2);
      ctx.fill();
    }
  }
  const ccx = boardGeom.ox + centerVX * boardGeom.cell;
  const ccy = boardGeom.oy + centerVY * boardGeom.cell;
  ctx.beginPath();
  ctx.arc(ccx, ccy, Math.max(3, boardGeom.cell * 0.11), 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function draw() {
  const rect = canvas.getBoundingClientRect();
  ctx.clearRect(0, 0, rect.width, rect.height);
  if (!mapData) return;
  boardGeom = computeGeom();
  const { cell, ox, oy } = boardGeom;
  for (let y = 0; y < mapData.height; y++) {
    for (let x = 0; x < mapData.width; x++) {
      ctx.fillStyle = ELEVATION_COLORS[mapData.grid[y][x]] || '#888';
      ctx.fillRect(ox + x * cell, oy + y * cell, cell, cell);
      ctx.strokeStyle = 'rgba(0,0,0,0.18)';
      ctx.strokeRect(ox + x * cell, oy + y * cell, cell, cell);
    }
  }
  drawReferenceDots();
}

async function fetchJson(url, options = {}) {
  const res = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...options });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.detail || 'Request failed');
  return data;
}

async function generateMap() {
  const payload = {
    width: Number(el('editor_width').value || 30),
    height: Number(el('editor_height').value || 30),
    map_type: el('editor_map_type').value,
  };
  const generated = await fetchJson('/api/generate-map', { method: 'POST', body: JSON.stringify(payload) });
  mapData = deepCopyMap(generated);
  el('editor_width').value = mapData.width;
  el('editor_height').value = mapData.height;
  syncJson();
  draw();
  setStatus('Generated.');
}

function tryPaint(evt) {
  if (!mapData) return;
  const cell = hitCell(evt);
  if (!cell) return;
  const [x, y] = cell;
  if (lastPainted && lastPainted[0] === x && lastPainted[1] === y) return;
  const delta = el('editor_mode').value === 'raise' ? -1 : 1;
  const cur = mapData.grid[y][x];
  const next = clamp(cur + delta, 1, 5);
  if (next === cur) return;
  if (x === 0 || y === 0 || x === mapData.width - 1 || y === mapData.height - 1) return;
  const neighbors = validNeighbors4(x, y, mapData.width, mapData.height).map(([nx, ny]) => mapData.grid[ny][nx]);
  if (!el('ignore_adjacency').checked && neighbors.some((n) => Math.abs(next - n) > 1)) {
    setStatus('Edit blocked: adjacent cells must differ by at most 1.');
    return;
  }
  mapData.grid[y][x] = next;
  forceLowestEdges(mapData);
  syncJson();
  draw();
  lastPainted = [x, y];
  setStatus(`Edited (${x}, ${y}) -> ${next}`);
}

function loadFromJsonText() {
  try {
    const parsed = JSON.parse(el('editor_json').value);
    if (!parsed || !parsed.width || !parsed.height || !Array.isArray(parsed.grid)) throw new Error('Invalid map JSON.');
    mapData = deepCopyMap(parsed);
    forceLowestEdges(mapData);
    el('editor_width').value = mapData.width;
    el('editor_height').value = mapData.height;
    syncJson();
    draw();
    setStatus('Loaded JSON.');
  } catch (err) {
    setStatus(err.message || 'Invalid JSON.');
  }
}

function downloadJson() {
  syncJson();
  const blob = new Blob([JSON.stringify(mapData, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'topostrafe_map.json';
  a.click();
  URL.revokeObjectURL(url);
}

function useInLobby() {
  syncJson();
  localStorage.setItem('topos_custom_map_json', JSON.stringify(mapData));
  window.location.href = '/';
}

function buildForm() {
  const sel = el('editor_map_type');
  defaults.map_types.filter((name) => name !== 'Custom').forEach((name) => {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    sel.appendChild(opt);
  });
  el('editor_map_type').value = defaults.settings.map_type || 'Altar';
  el('editor_width').value = defaults.settings.map_width || 30;
  el('editor_height').value = defaults.settings.map_height || 30;
}

function restoreEditorMap() {
  const stored = localStorage.getItem('topos_custom_map_json');
  if (!stored) return false;
  try {
    mapData = deepCopyMap(JSON.parse(stored));
    forceLowestEdges(mapData);
    el('editor_width').value = mapData.width;
    el('editor_height').value = mapData.height;
    syncJson();
    draw();
    setStatus('Loaded existing custom map.');
    return true;
  } catch (_) {
    return false;
  }
}

window.addEventListener('resize', resizeCanvas);
canvas.addEventListener('mousedown', (evt) => { painting = true; lastPainted = null; tryPaint(evt); });
canvas.addEventListener('mousemove', (evt) => { if (painting) tryPaint(evt); });
canvas.addEventListener('mouseup', () => { painting = false; lastPainted = null; });
canvas.addEventListener('mouseleave', () => { painting = false; lastPainted = null; });
el('generate-map').onclick = () => generateMap().catch((err) => setStatus(err.message));
el('use-map').onclick = useInLobby;
el('download-map').onclick = downloadJson;
el('editor_json').addEventListener('change', loadFromJsonText);
el('load-map-file').addEventListener('change', async (evt) => {
  const file = evt.target.files?.[0];
  if (!file) return;
  el('editor_json').value = await file.text();
  loadFromJsonText();
});
buildForm();
resizeCanvas();
if (!restoreEditorMap()) generateMap().catch((err) => setStatus(err.message));
