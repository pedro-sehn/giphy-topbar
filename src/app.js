const PAGE_SIZE = 24;
const API = 'https://api.giphy.com/v1/gifs';

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

// Thin wrapper over the Rust commands so the rest of the file reads the same
// regardless of what the backend is.
const api = {
  getConfig: () => invoke('get_config'),
  setConfig: (patch) => invoke('set_config', { patch }),
  copy: (text) => invoke('copy_text', { text }),
  hide: () => invoke('hide_window'),
  quit: () => invoke('quit_app'),
  onShown: (cb) => listen('window-shown', cb)
};

const els = {
  search: document.getElementById('search'),
  grid: document.getElementById('grid'),
  results: document.getElementById('results'),
  sentinel: document.getElementById('sentinel'),
  status: document.getElementById('status'),
  settingsBtn: document.getElementById('settings-btn'),
  setup: document.getElementById('setup'),
  keyInput: document.getElementById('key-input'),
  keySave: document.getElementById('key-save'),
  keyCancel: document.getElementById('key-cancel'),
  quit: document.getElementById('quit'),
  toast: document.getElementById('toast')
};

const state = {
  apiKey: null,
  query: '',
  offset: 0,
  total: Infinity,
  loading: false,
  // Bumped on every new search so in-flight responses from an older query
  // can be discarded instead of appended to the wrong result set.
  generation: 0
};

function setStatus(text) {
  els.status.textContent = text;
}

let toastTimer;
function toast(text) {
  els.toast.textContent = text;
  els.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { els.toast.hidden = true; }, 1200);
}

/* ---------- setup / api key ---------- */

function showSetup(cancellable) {
  els.keyCancel.hidden = !cancellable;
  els.keyInput.value = state.apiKey || '';
  els.setup.hidden = false;
  els.keyInput.focus();
}

function hideSetup() {
  els.setup.hidden = true;
  els.search.focus();
}

els.settingsBtn.addEventListener('click', () => showSetup(Boolean(state.apiKey)));
els.keyCancel.addEventListener('click', hideSetup);
els.quit.addEventListener('click', () => api.quit());

els.keySave.addEventListener('click', async () => {
  const key = els.keyInput.value.trim();
  if (!key) return;
  try {
    await api.setConfig({ apiKey: key });
  } catch (err) {
    // Surface it instead of leaving the modal up with no explanation.
    toast(`Could not save key: ${err}`);
    return;
  }
  state.apiKey = key;
  hideSetup();
  resetAndLoad(els.search.value.trim());
});

els.keyInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') els.keySave.click();
});

/* ---------- fetching ---------- */

function endpointFor(query, offset) {
  const params = new URLSearchParams({
    api_key: state.apiKey,
    limit: String(PAGE_SIZE),
    offset: String(offset),
    rating: 'pg-13',
    bundle: 'messaging_non_clips'
  });
  if (query) {
    params.set('q', query);
    return `${API}/search?${params}`;
  }
  return `${API}/trending?${params}`;
}

async function loadPage() {
  if (state.loading || !state.apiKey) return;
  if (state.offset >= state.total) return;

  const generation = state.generation;
  state.loading = true;
  setStatus(state.offset === 0 ? 'Loading…' : 'Loading more…');

  try {
    const res = await fetch(endpointFor(state.query, state.offset));
    if (!res.ok) {
      if (res.status === 401 || res.status === 403) {
        setStatus('Invalid API key.');
        showSetup(true);
        return;
      }
      throw new Error(`Giphy responded ${res.status}`);
    }
    const body = await res.json();
    if (generation !== state.generation) return; // stale query, drop it

    const items = body.data || [];
    state.total = body.pagination?.total_count ?? state.offset + items.length;
    state.offset += items.length;

    render(items);

    if (state.offset === 0 && items.length === 0) setStatus('No GIFs found.');
    else if (items.length === 0 || state.offset >= state.total) setStatus('End of results.');
    else setStatus('');
  } catch (err) {
    if (generation === state.generation) setStatus(`Error: ${err.message}`);
  } finally {
    if (generation === state.generation) {
      state.loading = false;
      // A short page may not have filled the scroll area; check again.
      requestAnimationFrame(maybeLoadMore);
    }
  }
}

function render(items) {
  const frag = document.createDocumentFragment();

  for (const gif of items) {
    const preview = gif.images.fixed_width_downsampled || gif.images.fixed_width;
    const tile = document.createElement('button');
    tile.className = 'tile';
    tile.title = `${gif.title || 'GIF'} — click to copy, ⇧click for page link`;

    const img = document.createElement('img');
    img.loading = 'lazy';
    img.src = preview.url;
    img.alt = gif.title || 'GIF';
    // Reserve the right box before the image loads so the grid does not jump.
    img.width = Number(preview.width) || 200;
    img.height = Number(preview.height) || 200;
    tile.appendChild(img);

    tile.addEventListener('click', async (e) => {
      const link = e.shiftKey ? gif.url : gif.images.original.url;
      await api.copy(link);
      tile.classList.add('copied');
      toast(e.shiftKey ? 'Page link copied' : 'GIF link copied');
      setTimeout(() => api.hide(), 350);
    });

    frag.appendChild(tile);
  }

  els.grid.appendChild(frag);
}

function resetAndLoad(query) {
  state.generation += 1;
  state.query = query;
  state.offset = 0;
  state.total = Infinity;
  state.loading = false;
  els.grid.textContent = '';
  els.results.scrollTop = 0;
  setStatus('');
  loadPage();
}

/* ---------- infinite scroll ---------- */

const observer = new IntersectionObserver(
  (entries) => { if (entries.some((e) => e.isIntersecting)) loadPage(); },
  { root: els.results, rootMargin: '400px' }
);
observer.observe(els.sentinel);

function maybeLoadMore() {
  const r = els.results;
  if (r.scrollHeight <= r.clientHeight + 400) loadPage();
}

/* ---------- search input ---------- */

let debounce;
els.search.addEventListener('input', () => {
  clearTimeout(debounce);
  const value = els.search.value.trim();
  debounce = setTimeout(() => resetAndLoad(value), 350);
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') api.hide();
});

api.onShown(() => {
  els.search.focus();
  els.search.select();
});

/* ---------- boot ---------- */

(async () => {
  const config = await api.getConfig();
  state.apiKey = config.apiKey || null;
  if (!state.apiKey) {
    showSetup(false);
    return;
  }
  els.search.focus();
  loadPage();
})();
