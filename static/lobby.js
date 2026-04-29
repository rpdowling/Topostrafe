const defaults = window.TOPOS_DEFAULTS;
const settings = defaults.settings;
const settingKeys = ['map_type','map_width','map_height','time_limit_enabled','time_bank_seconds','require_move_confirmation'];
const topotakSettingKeys = ['topotak_map_type','topotak_map_width','topotak_map_height','topotak_time_limit_enabled','topotak_time_bank_seconds','topotak_require_move_confirmation'];

const mapTypeLabels = defaults.map_type_labels || {};
const topotakMapTypes = ['River', 'Prison', 'Bridges', 'Three Mountains', 'Noise', 'Ridges', 'Plains', 'Mountains', 'Altar', 'Custom'];
const topotakMapLabels = {
  'River': 'River',
  'Prison': 'Prison',
  'Bridges': 'Bridges',
  'Three Mountains': 'Three Mountains (randomized)',
  'Noise': 'Noise (randomized)',
  'Ridges': 'Ridges (randomized)',
  'Plains': 'Plains',
  'Mountains': 'Mountains (randomized)',
  'Altar': 'Altar',
  'Custom': 'Custom',
};
const umDefaults = defaults.um_defaults || { board_width: 6, board_height: 6, max_corners: 1, board_color: "yellow", require_move_confirmation: false, infinite_board: true, size_preset: "small", time_limit_enabled: true, time_bank_seconds: 300, game_end_mode: "death", starting_nodes: 0 };
const umBoardColors = defaults.um_board_colors || { yellow: "#e8cf52" };
const umSizePresets = defaults.um_size_presets || { small: { board_width: 6, board_height: 6 }, medium: { board_width: 10, board_height: 10 }, large: { board_width: 20, board_height: 20 } };
const topowarDefaults = defaults.topowar_defaults || { map_width: 30, map_height: 30, tick_rate: 20, match_time_seconds: 600, dig_seconds_per_tile: 5, mg_build_seconds: 30 };

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
  if (el('um_require_move_confirmation')) el('um_require_move_confirmation').checked = !!umDefaults.require_move_confirmation;
  if (el('um_infinite_board')) el('um_infinite_board').checked = umDefaults.infinite_board !== false;
  if (el('um_time_limit_enabled')) el('um_time_limit_enabled').checked = umDefaults.time_limit_enabled !== false;
  if (el('um_time_bank_seconds')) el('um_time_bank_seconds').value = String(umDefaults.time_bank_seconds ?? 300);
  if (el('um_game_end_mode')) el('um_game_end_mode').value = umDefaults.game_end_mode || 'death';
  if (el('um_starting_nodes')) el('um_starting_nodes').value = String(umDefaults.starting_nodes ?? 0);

  const topotakMapType = el('topotak_map_type');
  if (topotakMapType) {
    topotakMapTypes.forEach((name) => {
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = topotakMapLabels[name] || name;
      topotakMapType.appendChild(opt);
    });
    topotakMapType.value = 'River';
  }
  for (const key of topotakSettingKeys) {
    const node = el(key);
    if (!node) continue;
    const settingsKey = key.replace(/^topotak_/, '');
    const fallback = settingsKey === 'map_type' ? 'River' : settings[settingsKey];
    const value = fallback;
    if (node.type === 'checkbox') node.checked = !!value;
    else node.value = value;
  }
  if (el('tw_map_width')) el('tw_map_width').value = String(topowarDefaults.map_width ?? 30);
  if (el('tw_map_height')) el('tw_map_height').value = String(topowarDefaults.map_height ?? 30);
  if (el('tw_tick_rate')) el('tw_tick_rate').value = String(topowarDefaults.tick_rate ?? 20);
  if (el('tw_match_minutes')) el('tw_match_minutes').value = String(((topowarDefaults.match_time_seconds ?? 600) / 60));
  if (el('tw_build_phase_minutes')) el('tw_build_phase_minutes').value = String(((topowarDefaults.build_phase_seconds ?? 180) / 60));
  if (el('tw_dig_seconds')) el('tw_dig_seconds').value = String(topowarDefaults.dig_seconds_per_tile ?? 5);
  if (el('tw_mg_build_seconds')) el('tw_mg_build_seconds').value = String(topowarDefaults.mg_build_seconds ?? 30);
  if (el('tw_generate_terrain')) el('tw_generate_terrain').checked = topowarDefaults.generate_terrain !== false;
}


const SIZE_PRESETS = {
  small: { map_width: 14, map_height: 14 },
  medium: { map_width: 22, map_height: 22 },
  large: { map_width: 30, map_height: 30 },
  huge: { map_width: 46, map_height: 46 },
  ginormous: { map_width: 70, map_height: 70 },
};

function detectPreset() {
  const width = Number(el('map_width').value);
  const height = Number(el('map_height').value);
  for (const [name, cfg] of Object.entries(SIZE_PRESETS)) {
    if (width === cfg.map_width && height === cfg.map_height) return name;
  }
  return 'custom';
}

function applyPreset(name) {
  const cfg = SIZE_PRESETS[name];
  const custom = name === 'custom';
  if (cfg) {
    el('map_width').value = cfg.map_width;
    el('map_height').value = cfg.map_height;
  }
  for (const id of ['map_width', 'map_height']) {
    if (el(id)) el(id).disabled = !custom;
  }
  for (const id of ['map_width_wrap', 'map_height_wrap']) {
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
  for (const id of ['map_width', 'map_height']) {
    if (!el(id)) continue;
    el(id).addEventListener('input', () => {
      const next = detectPreset();
      if (preset.value !== 'custom') {
        preset.value = next;
        if (next !== 'custom') applyPreset(next);
      }
    });
  }
}

function detectTopotakPreset() {
  const width = Number(el('topotak_map_width')?.value);
  const height = Number(el('topotak_map_height')?.value);
  for (const [name, cfg] of Object.entries(SIZE_PRESETS)) {
    if (width === cfg.map_width && height === cfg.map_height) return name;
  }
  return 'custom';
}

function applyTopotakPreset(name) {
  const cfg = SIZE_PRESETS[name];
  const custom = name === 'custom';
  if (cfg) {
    el('topotak_map_width').value = cfg.map_width;
    el('topotak_map_height').value = cfg.map_height;
  }
  for (const id of ['topotak_map_width', 'topotak_map_height']) {
    if (el(id)) el(id).disabled = !custom;
  }
  for (const id of ['topotak_map_width_wrap', 'topotak_map_height_wrap']) {
    const node = el(id);
    if (node) node.style.display = custom ? '' : 'none';
  }
  el('topotak_size_preset').value = custom ? 'custom' : name;
}

function hookTopotakSizePreset() {
  const preset = el('topotak_size_preset');
  if (!preset) return;
  preset.value = detectTopotakPreset();
  applyTopotakPreset(preset.value);
  preset.addEventListener('change', () => applyTopotakPreset(preset.value));
  for (const id of ['topotak_map_width', 'topotak_map_height']) {
    if (!el(id)) continue;
    el(id).addEventListener('input', () => {
      const next = detectTopotakPreset();
      if (preset.value !== 'custom') {
        preset.value = next;
        if (next !== 'custom') applyTopotakPreset(next);
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
    game_mode: 'topostrafe',
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
  }
  return payload;
}


let umVsBot = false;
let topotakVsBot = false;

function collectUmPayload() {
  return {
    game_mode: 'um',
    vs_bot: umVsBot,
    is_private: !!el('um_is_private')?.checked,
    join_code: el('um_join_code')?.value.trim() || '',
    um_settings: {
      size_preset: el('um_size_preset')?.value || 'small',
      max_corners: 1,
      board_color: el('um_board_color')?.value || 'yellow',
      require_move_confirmation: !!el('um_require_move_confirmation')?.checked,
      infinite_board: !!el('um_infinite_board')?.checked,
      time_limit_enabled: !!el('um_time_limit_enabled')?.checked,
      time_bank_seconds: Number(el('um_time_bank_seconds')?.value || 300),
      game_end_mode: el('um_game_end_mode')?.value || 'death',
      starting_nodes: Number(el('um_starting_nodes')?.value || 0),
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

function collectTopotakPayload() {
  const payload = {
    settings: {},
    is_private: el('topotak_is_private').checked,
    vs_bot: topotakVsBot,
    join_code: el('topotak_join_code').value.trim(),
    custom_map_json: el('topotak_custom_map_json').value.trim(),
    size_preset: el('topotak_size_preset').value,
    game_mode: 'topotak',
  };
  for (const key of topotakSettingKeys) {
    const node = el(key);
    if (!node) continue;
    const settingKey = key.replace(/^topotak_/, '');
    payload.settings[settingKey] = node.type === 'checkbox' ? node.checked : node.value;
  }
  const preset = el('topotak_size_preset').value;
  if (preset !== 'custom' && SIZE_PRESETS[preset]) {
    const cfg = SIZE_PRESETS[preset];
    payload.settings.map_width = cfg.map_width;
    payload.settings.map_height = cfg.map_height;
  }
  return payload;
}

async function createTopotakGame(evt) {
  evt.preventDefault();
  setStatus('Creating…');
  try {
    const created = await fetchJson('/api/create', {
      method: 'POST',
      body: JSON.stringify(collectTopotakPayload()),
    });
    window.location.href = created.url;
  } catch (err) {
    setStatus(err.message, true);
  }
}

function collectTopowarPayload() {
  return {
    game_mode: 'topowar',
    is_private: !!el('tw_is_private')?.checked,
    join_code: el('tw_join_code')?.value.trim() || '',
    topowar_settings: {
      map_width: Number(el('tw_map_width')?.value || 30),
      map_height: Number(el('tw_map_height')?.value || 30),
      tick_rate: Number(el('tw_tick_rate')?.value || 20),
      match_minutes: Number(el('tw_match_minutes')?.value || 10),
      build_phase_minutes: Number(el('tw_build_phase_minutes')?.value || 3),
      dig_seconds_per_tile: Number(el('tw_dig_seconds')?.value || 5),
      mg_build_seconds: Number(el('tw_mg_build_seconds')?.value || 30),
      generate_terrain: el('tw_generate_terrain')?.checked !== false,
    },
  };
}

async function createTopowarGame(evt) {
  evt.preventDefault();
  setStatus('Creating…');
  try {
    const created = await fetchJson('/api/create', {
      method: 'POST',
      body: JSON.stringify(collectTopowarPayload()),
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

function submitUmNormalGame() {
  umVsBot = false;
  setStatus('');
  el('um-form').requestSubmit();
}

function submitUmBotGame() {
  umVsBot = true;
  setStatus('');
  el('um-form').requestSubmit();
}

function submitTopotakNormalGame() {
  topotakVsBot = false;
  setStatus('');
  el('topotak-form').requestSubmit();
}

function submitTopotakBotGame() {
  topotakVsBot = true;
  setStatus('');
  el('topotak-form').requestSubmit();
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
        left.innerHTML = `<strong>${game.game_id}</strong><small>Um · ${game.size}</small><small>${String(game.board_color || '').replace(/^./, c => c.toUpperCase())} · ${game.time_limit_enabled ? formatTime(game.time_bank_seconds) + ' bank' : 'No clock'}</small>`;
      } else if (game.game_mode === 'topotak') {
        left.innerHTML = `<strong>${game.game_id}</strong><small>Topotak · ${displayMapType(game.map_type)} · ${game.size}</small><small>${game.time_limit_enabled ? formatTime(game.time_bank_seconds) + ' bank' : 'No clock'}</small>`;
      } else if (game.game_mode === 'topowar') {
        left.innerHTML = `<strong>${game.game_id}</strong><small>Topowar · ${game.size}</small><small>${formatTime(game.time_bank_seconds || 600)} limit</small>`;
      } else {
        left.innerHTML = `<strong>${game.game_id}</strong><small>${displayMapType(game.map_type)} · ${game.size}</small><small>${game.time_limit_enabled ? formatTime(game.time_bank_seconds) + ' bank' : 'No clock'}</small>`;
      }
      const btn = document.createElement('button');
      btn.className = `join-button${game.game_mode === 'um' ? ' um-join-button' : ''}${game.game_mode === 'topotak' ? ' topotak-join-button' : ''}`;
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

function hookTopotakFileLoader() {
  if (!el('topotak_custom_map_file')) return;
  el('topotak_custom_map_file').addEventListener('change', async (evt) => {
    const file = evt.target.files?.[0];
    if (!file) return;
    el('topotak_custom_map_json').value = await file.text();
    el('topotak_map_type').value = 'Custom';
  });
}

function hookHeroSectionSync() {
  const sectionIds = ['topostrafe-section', 'um-section', 'topotak-section', 'topowar-section'];
  const sections = sectionIds
    .map((id) => el(id))
    .filter(Boolean);
  if (!sections.length) return;
  const openOnly = (targetId) => {
    sections.forEach((section) => {
      section.open = section.id === targetId;
    });
  };
  document.querySelectorAll('[data-target-section]').forEach((card) => {
    card.addEventListener('click', () => {
      const targetId = card.getAttribute('data-target-section');
      if (!targetId) return;
      openOnly(targetId);
      const section = el(targetId);
      if (section) section.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  });
}

buildForm();
restoreEditorMap();
hookFileLoader();
hookSizePreset();
hookTopotakFileLoader();
hookTopotakSizePreset();
hookHeroSectionSync();
el('play-button').addEventListener('click', submitNormalGame);
el('bot-button').addEventListener('click', submitBotGame);
el('create-form').addEventListener('submit', createGame);
if (el('um-form')) el('um-form').addEventListener('submit', createUmGame);
if (el('um-play-button')) el('um-play-button').addEventListener('click', (evt) => { evt.preventDefault(); submitUmNormalGame(); });
if (el('um-bot-button')) el('um-bot-button').addEventListener('click', (evt) => { evt.preventDefault(); submitUmBotGame(); });
if (el('topotak-form')) el('topotak-form').addEventListener('submit', createTopotakGame);
if (el('topotak-play-button')) el('topotak-play-button').addEventListener('click', (evt) => { evt.preventDefault(); submitTopotakNormalGame(); });
if (el('topotak-bot-button')) el('topotak-bot-button').addEventListener('click', (evt) => { evt.preventDefault(); submitTopotakBotGame(); });
if (el('topowar-form')) el('topowar-form').addEventListener('submit', createTopowarGame);
if (el('topowar-play-button')) el('topowar-play-button').addEventListener('click', (evt) => { evt.preventDefault(); el('topowar-form').requestSubmit(); });
el('join-private-form').addEventListener('submit', joinPrivate);
refreshGames();
setInterval(refreshGames, 3000);
