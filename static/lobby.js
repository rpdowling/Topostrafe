const defaults = window.TOPOS_DEFAULTS;
const settings = defaults.settings;
const settingKeys = Object.keys(settings);

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
    opt.textContent = name;
    mapType.appendChild(opt);
  });
  for (const [key, value] of Object.entries(settings)) {
    const node = el(key);
    if (!node) continue;
    if (node.type === 'checkbox') node.checked = !!value;
    else node.value = value;
  }
}

function collectPayload() {
  const payload = {
    settings: {},
    is_private: el('is_private').checked,
    vs_bot: el('vs_bot').checked,
    join_code: el('join_code').value.trim(),
    custom_map_json: el('custom_map_json').value.trim(),
  };
  for (const key of settingKeys) {
    const node = el(key);
    if (!node) continue;
    payload.settings[key] = node.type === 'checkbox' ? node.checked : node.value;
  }
  return payload;
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
      left.innerHTML = `<strong>${game.game_id}</strong><small>${game.map_type} · ${game.size}</small><small>Path ${game.path_count} · Link ${game.max_link_distance} · ${game.time_limit_enabled ? formatTime(game.time_bank_seconds) + ' bank' : 'No clock'}</small>`;
      const btn = document.createElement('button');
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

function hookFileLoader() {
  el('custom_map_file').addEventListener('change', async (evt) => {
    const file = evt.target.files?.[0];
    if (!file) return;
    el('custom_map_json').value = await file.text();
    el('map_type').value = 'Custom';
  });
}

buildForm();
hookFileLoader();
el('create-form').addEventListener('submit', createGame);
el('join-private-form').addEventListener('submit', joinPrivate);
refreshGames();
setInterval(refreshGames, 3000);
