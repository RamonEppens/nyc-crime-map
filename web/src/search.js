// Search box (accessible combobox). Boroughs and neighborhoods are suggested from the first
// letter, matched locally; addresses come from NYC Planning's GeoSearch
// (https://geosearch.planninglabs.nyc), the City's open geocoder built on its official address
// database (PAD), from the third character on. Only the typed text is sent; nothing else.
const GEOSEARCH = new URLSearchParams(location.search).get('geosearch') ?? 'https://geosearch.planninglabs.nyc';
const ADDRESS_MIN_CHARS = 3;
const DEBOUNCE_MS = 200;
const MAX_PLACES = 6;
const MAX_ADDRESSES = 5;

// "350 5TH AVENUE" -> "350 5th Avenue"
const titleCase = (s) => s.replace(/\b([A-Z])([A-Z']+)\b/g, (m, a, b) => a + b.toLowerCase())
  .replace(/(\d)([A-Z]+)\b/g, (m, d, t) => d + t.toLowerCase());

// Results come from an outside service, so they are escaped before going into the list.
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const norm = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]/g, ' ')
  .replace(/\s+/g, ' ').trim();

/** 0: name starts with the text, 1: a word starts with it, 2: contains it, -1: no match. */
function matchRank(name, q) {
  const n = norm(name);
  if (n.startsWith(q)) return 0;
  if (n.includes(` ${q}`)) return 1;
  return n.includes(q) ? 2 : -1;
}

/**
 * input: <input>; list: <ul>; places: [{kind: 'borough'|'nta', code, label, detail}];
 * onChoose({kind:'borough'|'nta', code} | {kind:'address', lngLat, label})
 */
export function setupSearch(input, list, places, onChoose) {
  const block = input.closest('.search');
  const clear = block.querySelector('.search-clear');
  const boroughs = places.filter((p) => p.kind === 'borough');
  let items = [];
  let active = -1;
  let timer;
  let controller;

  const setOpen = (open) => {
    list.hidden = !open;
    block.classList.toggle('open', open);
    input.setAttribute('aria-expanded', String(open));
  };
  const close = () => {
    setOpen(false);
    input.removeAttribute('aria-activedescendant');
    active = -1;
  };
  const render = (status = '') => {
    list.innerHTML = items.map((it, i) => `<li role="option" id="search-opt-${i}" aria-selected="${i === active}" data-i="${i}">
        <span class="opt-label">${esc(it.label)}</span><span class="opt-detail">${esc(it.detail)}</span></li>`).join('')
      + (status ? `<li class="search-status" role="presentation">${status}</li>` : '');
    setOpen(items.length > 0 || !!status);
    if (active >= 0) {
      input.setAttribute('aria-activedescendant', `search-opt-${active}`);
      list.querySelector(`#search-opt-${active}`)?.scrollIntoView({ block: 'nearest' });
    } else input.removeAttribute('aria-activedescendant');
  };
  const choose = (it) => {
    input.value = it.label;
    clear.hidden = false;
    close();
    input.blur();
    onChoose(it.kind === 'address' ? { kind: 'address', lngLat: it.lngLat, label: it.label } : { kind: it.kind, code: it.code });
  };

  /** Boroughs and neighborhoods, best matches first (boroughs win ties). */
  function localMatches(text) {
    const q = norm(text);
    if (!q) return [];
    return places
      .map((p, i) => ({ p, i, rank: matchRank(p.label, q) }))
      .filter((x) => x.rank >= 0)
      .sort((a, b) => a.rank - b.rank || a.i - b.i)
      .slice(0, MAX_PLACES)
      .map((x) => x.p);
  }

  async function lookupAddresses(text, local) {
    controller?.abort();
    controller = new AbortController();
    try {
      const res = await fetch(`${GEOSEARCH}/v2/autocomplete?text=${encodeURIComponent(text)}&size=10`, { signal: controller.signal });
      if (!res.ok) throw new Error(res.status);
      const data = await res.json();
      const seen = new Set();
      const addresses = [];
      for (const f of data.features ?? []) {
        const [lon, lat] = f.geometry.coordinates;
        const key = `${lon.toFixed(5)},${lat.toFixed(5)}`;        // one result per location (aliases like B'WAY)
        if (seen.has(key)) continue;
        seen.add(key);
        const borough = f.properties.borough ?? '';
        addresses.push({ kind: 'address', lngLat: [lon, lat], label: titleCase(f.properties.name ?? f.properties.label),
          detail: borough ? `Address · ${borough}` : 'Address' });
        if (addresses.length === MAX_ADDRESSES) break;
      }
      items = [...local, ...addresses];
      if (active < 0 && items.length) active = 0;
      render(items.length ? '' : 'No matches in New York City');
    } catch (err) {
      if (err.name === 'AbortError') return;
      render(local.length ? '' : 'Address search is unavailable right now');
    }
  }

  function update() {
    clearTimeout(timer);
    controller?.abort();
    const text = input.value.trim();
    clear.hidden = !input.value;
    if (!text) {                                       // empty box: suggest the five boroughs
      items = boroughs;
      active = -1;
      render();
      return;
    }
    const local = localMatches(text);
    items = local;
    active = local.length ? 0 : -1;                  // the first suggestion is what Enter picks
    const wantsAddresses = text.length >= ADDRESS_MIN_CHARS;
    render(wantsAddresses && !local.length ? 'Searching addresses…' : local.length ? '' : 'Keep typing to search addresses');
    if (wantsAddresses) timer = setTimeout(() => lookupAddresses(text, local), DEBOUNCE_MS);
  }

  input.addEventListener('input', update);
  input.addEventListener('focus', update);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' && items.length) {
      if (list.hidden) update(); else active = (active + 1) % items.length;
      render(); e.preventDefault();
    } else if (e.key === 'ArrowUp' && items.length) {
      active = (active - 1 + items.length) % items.length; render(); e.preventDefault();
    } else if (e.key === 'Enter' && items.length && !list.hidden) {
      choose(items[Math.max(0, active)]); e.preventDefault();
    } else if (e.key === 'Escape' && !list.hidden) {
      close(); e.stopPropagation();
    }
  });
  list.addEventListener('mousedown', (e) => {          // mousedown: fires before the input loses focus
    const li = e.target.closest('[data-i]');
    if (li) { e.preventDefault(); choose(items[+li.dataset.i]); }
  });
  list.addEventListener('mousemove', (e) => {
    const li = e.target.closest('[data-i]');
    if (li && +li.dataset.i !== active) {
      active = +li.dataset.i;
      list.querySelectorAll('[data-i]').forEach((el) => el.setAttribute('aria-selected', String(+el.dataset.i === active)));
      input.setAttribute('aria-activedescendant', `search-opt-${active}`);
    }
  });
  input.addEventListener('blur', () => setTimeout(close, 120));
  clear.addEventListener('click', () => {
    input.value = '';
    clear.hidden = true;
    input.focus();
    update();
  });
}
