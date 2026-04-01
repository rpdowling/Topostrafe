const defaults = window.TOPOS_DEFAULTS;
const settings = defaults.settings;
const settingKeys = Object.keys(settings);

const mapTypeLabels = defaults.map_type_labels || {};
const umDefaults = defaults.um_defaults || { board_width: 6, board_height: 6, max_corners: 1, board_color: "yellow", require_move_confirmation: false, infinite_board: true, size_preset: "small" };
const umBoardColors = defaults.um_board_colors || { yellow: "#e8cf52" };
const umSizePresets = defaults.um_size_presets || { small: { board_width: 6, board_height: 6 }, medium: { board_width: 10, board_height: 10 }, large: { board_width: 20, board_height: 20 } };

function displayMapType(name) {
  return mapTypeLabels[name] || name;
}


function el(id) {
  return document.getElementById(id);
}

function setStatus(msg, bad = false) {
  const node = el('create-status');
  node.textContent = msg || '';
  node.style.color = bad ? '#ff8d8d' : '';
}

async function fetchJson(url, options = {}) {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.detail || 'Request failed');
  return data;
}

function buildForm() {
  const mapType = el('map_type');
  defaults.map_types.forEach((name) => {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = displayMapType(name);
    mapType.appendChild(opt);
  });
  for (const [key, value] of Object.entries(settings)) {
    const node = el(key);
    if (!node) continue;
    if (node.type === 'checkbox') node.checked = !!value;
    else node.value = value;
  }
  const umColorSelect = el('um_board_color');
  if (umColorSelect) {
    for (const name of Object.keys(umBoardColors)) {
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name.charAt(0).toUpperCase() + name.slice(1);
      umColorSelect.appendChild(opt);
    }
    umColorSelect.value = umDefaults.board_color || 'yellow';
  }
  if (el('um_size_preset')) el('um_size_preset').value = umDefaults.size_preset || 'small';
  if (el('um_max_corners')) el('um_max_corners').value = String(umDefaults.max_corners ?? 1);
  if (el('um_require_move_confirmation')) el('um_require_move_confirmation').checked = !!umDefaults.require_move_confirmation;
  if (el('um_infinite_board')) el('um_infinite_board').checked = umDefaults.infinite_board !== false;
}


const SIZE_PRESETS = {
  small: { map_width: 14, map_height: 14, max_link_distance: 7, path_count: 8 },
  medium: { map_width: 22, map_height: 22, max_link_distance: 11, path_count: 12 },
  large: { map_width: 30, map_height: 30, max_link_distance: 15, path_count: 16 },
  huge: { map_width: 46, map_height: 46, max_link_distance: 23, path_count: 24 },
  ginormous: { map_width: 70, map_height: 70, max_link_distance: 35, path_count: 36 },
};

function detectPreset() {
  const width = Number(el('map_width').value);
  const height = Number(el('map_height').value);
  const link = Number(el('max_link_distance').value);
  const paths = Number(el('path_count').value);
  for (const [name, cfg] of Object.entries(SIZE_PRESETS)) {
    if (width === cfg.map_width && height === cfg.map_height && link === cfg.max_link_distance && paths === cfg.path_count) return name;
  }
  return 'custom';
}

function applyPreset(name) {
  const cfg = SIZE_PRESETS[name];
  const custom = name === 'custom';
  if (cfg) {
    el('map_width').value = cfg.map_width;
    el('map_height').value = cfg.map_height;
    el('max_link_distance').value = cfg.max_link_distance;
    el('path_count').value = cfg.path_count;
  }
  for (const id of ['map_width', 'map_height', 'max_link_distance', 'path_count']) {
    el(id).disabled = !custom;
  }
  for (const id of ['map_width_wrap', 'map_height_wrap', 'max_link_distance_wrap', 'path_count_wrap']) {
    const node = el(id);
    if (node) node.style.display = custom ? '' : 'none';
  }
  el('size_preset').value = custom ? 'custom' : name;
}

function hookSizePreset() {
  const preset = el('size_preset');
  preset.value = detectPreset();
  applyPreset(preset.value);
  preset.addEventListener('change', () => applyPreset(preset.value));
  for (const id of ['map_width', 'map_height', 'max_link_distance', 'path_count']) {
    el(id).addEventListener('input', () => {
      const next = detectPreset();
      if (preset.value !== 'custom') {
        preset.value = next;
        if (next !== 'custom') applyPreset(next);
      }
    });
  }
}

function collectPayload() {
  const payload = {
    settings: {},
    is_private: el('is_private').checked,
    vs_bot: el('vs_bot').checked,
    join_code: el('join_code').value.trim(),
    custom_map_json: el('custom_map_json').value.trim(),
    size_preset: el('size_preset').value,
  };
  for (const key of settingKeys) {
    const node = el(key);
    if (!node) continue;
    payload.settings[key] = node.type === 'checkbox' ? node.checked : node.value;
  }
  const preset = el('size_preset').value;
  if (preset !== 'custom' && SIZE_PRESETS[preset]) {
    const cfg = SIZE_PRESETS[preset];
    payload.settings.map_width = cfg.map_width;
    payload.settings.map_height = cfg.map_height;
    payload.settings.max_link_distance = cfg.max_link_distance;
    payload.settings.path_count = cfg.path_count;
  }
  return payload;
}


function collectUmPayload() {
  return {
    game_mode: 'um',
    is_private: !!el('um_is_private')?.checked,
    join_code: el('um_join_code')?.value.trim() || '',
    um_settings: {
      size_preset: el('um_size_preset')?.value || 'small',
      max_corners: Number(el('um_max_corners')?.value || 1),
      board_color: el('um_board_color')?.value || 'yellow',
      require_move_confirmation: !!el('um_require_move_confirmation')?.checked,
      infinite_board: !!el('um_infinite_board')?.checked,
    },
  };
}

async function createUmGame(evt) {
  evt.preventDefault();
  setStatus('Creating…');
  try {
    const created = await fetchJson('/api/create', {
      method: 'POST',
      body: JSON.stringify(collectUmPayload()),
    });
    window.location.href = created.url;
  } catch (err) {
    setStatus(err.message, true);
  }
}

function submitBotGame() {
  el('vs_bot').checked = true;
  setStatus('');
  el('create-form').requestSubmit();
}

function submitNormalGame() {
  el('vs_bot').checked = false;
}

async function createGame(evt) {
  evt.preventDefault();
  setStatus('Creating…');
  try {
    const created = await fetchJson('/api/create', {
      method: 'POST',
      body: JSON.stringify(collectPayload()),
    });
    window.location.href = created.url;
  } catch (err) {
    setStatus(err.message, true);
  }
}

function formatTime(seconds) {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

async function refreshGames() {
  const wrap = el('games-list');
  try {
    const data = await fetchJson('/api/public-games');
    wrap.innerHTML = '';
    if (!data.games.length) {
      wrap.innerHTML = '<div class="muted">No open public games.</div>';
      return;
    }
    for (const game of data.games) {
      const row = document.createElement('div');
      row.className = 'game-row';
      const left = document.createElement('div');
      if (game.game_mode === 'um') {
        left.innerHTML = `<strong>${game.game_id}</strong><small>Um · ${game.size}</small><small>Max Corners ${game.max_corners} · ${String(game.board_color || '').replace(/^./, c => c.toUpperCase())}</small>`;
      } else {
        left.innerHTML = `<strong>${game.game_id}</strong><small>${displayMapType(game.map_type)} · ${game.size}</small><small>Path ${game.path_count} · Link ${game.max_link_distance} · ${game.time_limit_enabled ? formatTime(game.time_bank_seconds) + ' bank' : 'No clock'}</small>`;
      }
      const btn = document.createElement('button');
      btn.className = `join-button${game.game_mode === 'um' ? ' um-join-button' : ''}`;
      btn.textContent = 'Join';
      btn.onclick = async () => {
        try {
          const joined = await fetchJson(`/api/join/public/${game.game_id}`, { method: 'POST' });
          window.location.href = joined.url;
        } catch (err) {
          setStatus(err.message, true);
          refreshGames();
        }
      };
      row.appendChild(left);
      row.appendChild(btn);
      wrap.appendChild(row);
    }
  } catch (err) {
    wrap.innerHTML = `<div class="muted">${err.message}</div>`;
  }
}

async function joinPrivate(evt) {
  evt.preventDefault();
  try {
    const joined = await fetchJson('/api/join/private', {
      method: 'POST',
      body: JSON.stringify({ join_code: el('private_code').value.trim() }),
    });
    window.location.href = joined.url;
  } catch (err) {
    setStatus(err.message, true);
  }
}


function restoreEditorMap() {
  const stored = localStorage.getItem('topos_custom_map_json');
  if (!stored) return;
  try {
    const parsed = JSON.parse(stored);
    if (!parsed || !Array.isArray(parsed.grid) || !parsed.width || !parsed.height) return;
    el('custom_map_json').value = JSON.stringify(parsed);
    el('map_type').value = 'Custom';
    localStorage.removeItem('topos_custom_map_json');
    setStatus('Loaded map from editor.');
  } catch (_) {}
}

function hookFileLoader() {
  el('custom_map_file').addEventListener('change', async (evt) => {
    const file = evt.target.files?.[0];
    if (!file) return;
    el('custom_map_json').value = await file.text();
    el('map_type').value = 'Custom';
  });
}

buildForm();
restoreEditorMap();
hookFileLoader();
hookSizePreset();
el('play-button').addEventListener('click', submitNormalGame);
el('bot-button').addEventListener('click', submitBotGame);
el('create-form').addEventListener('submit', createGame);
if (el('um-form')) el('um-form').addEventListener('submit', createUmGame);
if (el('um-play-button')) el('um-play-button').addEventListener('click', () => setStatus(''));
el('join-private-form').addEventListener('submit', joinPrivate);
hookInfoModal();
refreshGames();
setInterval(refreshGames, 3000);


function hookInfoModal() {
  const openBtn = el('info-button');
  const overlay = el('info-overlay');
  const closeBtn = el('info-close');
  const modal = el('info-modal');
  if (!openBtn || !overlay || !closeBtn || !modal) return;

  function openModal() {
    overlay.classList.remove('hidden');
    overlay.setAttribute('aria-hidden', 'false');
    document.body.classList.add('info-modal-open');
  }

  function closeModal() {
    overlay.classList.add('hidden');
    overlay.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('info-modal-open');
  }

  openBtn.addEventListener('click', openModal);
  closeBtn.addEventListener('click', closeModal);
  overlay.addEventListener('click', (evt) => {
    if (evt.target === overlay) closeModal();
  });
  document.addEventListener('keydown', (evt) => {
    if (evt.key === 'Escape' && !overlay.classList.contains('hidden')) closeModal();
  });
}
