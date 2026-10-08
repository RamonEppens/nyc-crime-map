// Search box: one input, four kinds of results, all answered from our own files (nothing typed
// leaves the site). Every keystroke runs these rules in order:
//   1. CORNER    "5th ave and 42nd st", "&", "at", "/": the best streets for each part (10 x 40:
//                NYC repeats numbered names across boroughs, so BA's 4 x 6 misses Manhattan's
//                West 42nd St), kept only where they really meet (street_corners), max 6.
//   2. AREAS     boroughs, neighborhoods (2020 NTAs) and precincts ("75", "75th", "pct 75",
//                "75th precinct"): exact, then prefix, then natural numeric order; top 3.
//   3. ADDRESS   NYC writes the number first ("350 5th ave", Queens "37-12 80th st"): the 10 best
//                streets, kept only where that number exists on a segment (street_segments).
//   4. STREETS   otherwise: the matching areas plus up to 5 whole streets.
// A borough at the end ("..., brooklyn", "bk") narrows every rule to that borough.
// Street matching: every typed word must be the start of a word of the street's key (clave, same
// function as the pipeline); a typed number must match whole unless it is the word being typed.
import { clave } from './streetnames.js';

const BOROUGH_WORDS = [
  [/\b(?:manhattan|mn|new york)$/i, 1], [/\b(?:the bronx|bronx|bx)$/i, 2], [/\b(?:brooklyn|bk|bklyn)$/i, 3],
  [/\b(?:queens|qn|qns)$/i, 4], [/\b(?:staten island|si|staten)$/i, 5],
];
const CORNER_SPLIT = /\s+(?:and|at)\s+|\s*(?:&|\/|@)\s*/i;
const ADDRESS = /^(\d+(?:-\d+)?)[a-z]?\s+(.+)$/i;                         // 350 5th ave / 37-12 80th st
const PRECINCT = [
  /^(?:precinct|pct\.?|pc)\s*#?\s*(\d{1,3})(?:st|nd|rd|th)?$/i,           // precinct 75, pct 75
  /^(\d{1,3})(?:st|nd|rd|th)?\s*(?:precinct|pct\.?|pc)$/i,                 // 75th precinct, 75 pct
];
const BARE_NUMBER = /^(\d{1,3})(st|nd|rd|th)?$/i;                          // 75 / 75th
const HYPHEN_BASE = 1_000_000;
const DEBOUNCE_MS = 140;

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const norm = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]/g, ' ')
  .replace(/\s+/g, ' ').trim();
const naturalCompare = (a, b) => a.localeCompare(b, 'en', { numeric: true, sensitivity: 'base' });

/** '37-12' -> 1_037_012; '350' -> 350 (same encoding as the pipeline). */
export function parseHouseNumber(s) {
  const m = /^(\d+)-(\d+)$/.exec(s);
  return m ? HYPHEN_BASE + Number(m[1]) * 1000 + Number(m[2]) : Number(s);
}

// ---------------------------------------------------------------- street index
let index = null;            // {streets: [...], words: [[...]], aliasWords: [[[...]]]}
let indexPromise = null;
export function loadStreets(loadJson) {
  indexPromise ??= loadJson('streets.json').then((data) => {
    const streets = data.streets.map(([name, key, aliases, boro, ntas, nNtas, length], id) =>
      ({ id, name, key, aliases, boro, ntas, nNtas, length }));
    index = {
      streets,
      words: streets.map((s) => s.key.split(' ')),
      aliasWords: streets.map((s) => (s.aliases ? s.aliases.split(' | ').map((a) => clave(a).split(' ')) : [])),
    };
    return index;
  });
  return indexPromise;
}
export const streetById = (id) => index?.streets[id];

/** How well typed words match a street's words: null (no match) or a sort key. */
function score(typed, words) {
  let exact = 0;
  const used = new Set();
  for (let i = 0; i < typed.length; i++) {
    const t = typed[i];
    const isNumber = /^\d+$/.test(t);
    const typing = i === typed.length - 1;
    let found = -1;
    for (let j = 0; j < words.length; j++) {
      if (used.has(j)) continue;
      const w = words[j];
      if (w === t) { found = j; exact++; break; }
      if (found < 0 && w.startsWith(t) && (!isNumber || typing)) found = j;
    }
    if (found < 0) return null;
    used.add(found);
  }
  return { exact, extra: words.length - typed.length, len: words.join(' ').length };
}

/** Best streets for typed text, ranked like the BA map: current name before alias, more exact
 *  word matches, fewer extra words, shorter name. */
export function matchStreets(text, boro, limit) {
  if (!index) return [];
  const typed = clave(text).split(' ').filter(Boolean);
  if (!typed.length) return [];
  const hits = [];
  index.streets.forEach((s, i) => {
    if (boro && s.boro !== boro) return;
    let sc = score(typed, index.words[i]);
    let alias = 0;
    if (!sc) {
      for (const aw of index.aliasWords[i]) {
        const a = score(typed, aw);
        if (a && (!sc || a.exact > sc.exact)) sc = a;
      }
      alias = 1;
    }
    if (sc) hits.push({ s, alias, ...sc });
  });
  hits.sort((a, b) => a.alias - b.alias || b.exact - a.exact || a.extra - b.extra || a.len - b.len
    || a.s.boro - b.s.boro);
  return hits.slice(0, limit).map((h) => h.s);
}

// ---------------------------------------------------------------- locating addresses
/** Point along a segment polyline at fraction t of its length (longitudes scaled by cos(lat)). */
function along(xy, t) {
  const pts = [];
  for (let k = 0; k < xy.length; k += 2) pts.push([xy[k] / 1e5, xy[k + 1] / 1e5]);
  const c = Math.cos((pts[0][1] * Math.PI) / 180);
  const cum = [0];
  for (let k = 1; k < pts.length; k++) {
    cum.push(cum[k - 1] + Math.hypot((pts[k][0] - pts[k - 1][0]) * c, pts[k][1] - pts[k - 1][1]));
  }
  const target = Math.min(Math.max(t, 0), 1) * cum.at(-1);
  for (let k = 1; k < pts.length; k++) {
    if (cum[k] >= target) {
      const r = (target - cum[k - 1]) / (cum[k] - cum[k - 1] || 1);
      return [pts[k - 1][0] + r * (pts[k][0] - pts[k - 1][0]), pts[k - 1][1] + r * (pts[k][1] - pts[k - 1][1])];
    }
  }
  return pts.at(-1);
}

/** Point for a house number on a segment row {lf, lt, rf, rt, xy}, or null. Never invents one. */
export function locateOnSegment(seg, n) {
  for (const [lo, hi] of [[seg.lf, seg.lt], [seg.rf, seg.rt]]) {
    if (lo <= 0 || hi <= 0 || (lo >= HYPHEN_BASE) !== (n >= HYPHEN_BASE)) continue;
    if (n < Math.min(lo, hi) || n > Math.max(lo, hi) || lo % 2 !== n % 2) continue;
    return along(seg.xy, hi === lo ? 0.5 : (n - lo) / (hi - lo));
  }
  return null;
}

const listSql = (ids) => ids.join(',') || '-1';

// ---------------------------------------------------------------- the four rules
/**
 * deps: { query, places: [{type:'area', level, code, label, detail}], ntaName(code), ntaAt(lngLat), boroName(code) }
 * Returns result items: {type:'point'|'street'|'area', label, detail, ...}
 */
export async function suggest(raw, deps) {
  let text = raw.trim().replace(/,/g, ' ').replace(/\s+/g, ' ');
  let boro = 0;
  for (const [re, b] of BOROUGH_WORDS) {
    const m = re.exec(text);
    if (m && m.index > 0) { boro = b; text = text.slice(0, m.index).trim(); break; }
  }
  if (!text) return [];
  // Subtitle of a point: its borough and the neighborhood it falls in.
  const placeOf = (s, lngLat) => [deps.boroName(s.boro), deps.ntaAt(lngLat)].filter(Boolean).join(' · ');

  // 1. corner
  const parts = text.split(CORNER_SPLIT).map((p) => p.trim()).filter(Boolean);
  if (parts.length === 2 && !/^\d+$/.test(parts[0])) {
    const A = matchStreets(parts[0], boro, 10);
    const B = matchStreets(parts[1], boro, 40);
    if (!A.length || !B.length) return [];
    const ids = (xs) => listSql(xs.map((s) => s.id));
    const rows = await deps.query(`SELECT a, b, x, y FROM street_corners
      WHERE (a IN (${ids(A)}) AND b IN (${ids(B)})) OR (a IN (${ids(B)}) AND b IN (${ids(A)}))`);
    const rankA = new Map(A.map((s, i) => [s.id, i]));
    const rankB = new Map(B.map((s, i) => [s.id, i]));
    const seen = new Set();
    return rows
      .map((r) => {
        const [sa, sb] = rankA.has(r.a) && rankB.has(r.b) ? [r.a, r.b] : [r.b, r.a];
        return { ...r, sa, sb, rank: (rankA.get(sa) ?? 9) * 10 + (rankB.get(sb) ?? 9) };
      })
      .sort((p, q) => p.rank - q.rank)
      .filter((r) => !seen.has(`${r.x},${r.y}`) && seen.add(`${r.x},${r.y}`))   // one result per place
      .slice(0, 6)
      .map((r) => {
        const a = streetById(r.sa); const b = streetById(r.sb);
        const lngLat = [r.x / 1e5, r.y / 1e5];
        return { type: 'point', kind: 'corner', label: `${a.name} & ${b.name}`, detail: `Corner · ${placeOf(a, lngLat)}`, lngLat };
      });
  }

  // 2. areas (precinct patterns first, so "75th precinct" never becomes an address)
  const areas = matchAreas(text, deps.places, boro);
  const isPrecinctQuery = PRECINCT.some((re) => re.test(text));
  if (isPrecinctQuery) return areas;
  const bare = BARE_NUMBER.exec(text);
  if (bare && !bare[2]) return areas;                               // "75": only the precinct

  // 3. address
  const addr = ADDRESS.exec(text);
  if (addr) {
    const n = parseHouseNumber(addr[1]);
    const cands = matchStreets(addr[2], boro, 10);
    if (cands.length) {
      const rows = await deps.query(`SELECT street, lf, lt, rf, rt, xy FROM street_segments
        WHERE street IN (${listSql(cands.map((s) => s.id))})
          AND ((lf > 0 AND ${n} BETWEEN least(lf, lt) AND greatest(lf, lt))
            OR (rf > 0 AND ${n} BETWEEN least(rf, rt) AND greatest(rf, rt)))`);
      const found = new Map();
      for (const r of rows) {
        if (found.has(r.street)) continue;
        const p = locateOnSegment(r, n);
        if (p) found.set(r.street, p);
      }
      const out = cands.filter((s) => found.has(s.id)).slice(0, 6).map((s) => ({
        type: 'point', kind: 'address', label: `${addr[1]} ${s.name}`, detail: placeOf(s, found.get(s.id)), lngLat: found.get(s.id),
      }));
      if (out.length) return [...areas, ...out];
    }
  }

  // 4. plain text: areas + whole streets
  const streets = matchStreets(text, boro, 5).map((s) => ({
    type: 'street', id: s.id, label: s.name,
    detail: `Whole street · ${deps.boroName(s.boro)}${s.nNtas > 2 ? ` · ${s.nNtas} neighborhoods`
      : s.ntas.length ? ` · ${s.ntas.map(deps.ntaName).join(', ')}` : ''}`,
  }));
  return [...areas, ...streets];
}

function matchAreas(text, places, boro) {
  const q = norm(text);
  if (!q) return [];
  let pct = null;
  for (const re of [...PRECINCT, BARE_NUMBER]) {
    const m = re.exec(text);
    if (m) { pct = Number(m[1]); break; }
  }
  const hits = [];
  for (const p of places) {
    if (boro && p.boro && p.boro !== boro) continue;
    if (p.level === 'precinct') {
      if (pct === p.code) hits.push({ p, rank: 0 });
      continue;
    }
    const name = norm(p.label);
    const rank = name === q ? 0 : name.startsWith(q) ? 1 : name.split(' ').some((w) => w.startsWith(q)) ? 2 : -1;
    if (rank >= 0) hits.push({ p, rank });
  }
  const LEVEL = { borough: 0, nta: 1, precinct: 2 };
  hits.sort((a, b) => a.rank - b.rank || LEVEL[a.p.level] - LEVEL[b.p.level] || naturalCompare(a.p.label, b.p.label));
  return hits.slice(0, 3).map((h) => h.p);
}

// ---------------------------------------------------------------- the combobox
/**
 * input, list: elements; deps: see suggest(); onChoose(item); onFocus(): load what search needs.
 */
export function setupSearch(input, list, deps, onChoose, onFocus) {
  const block = input.closest('.search');
  const clear = block.querySelector('.search-clear');
  let items = [];
  let active = -1;
  let timer;
  let ticket = 0;

  const setOpen = (open) => {
    list.hidden = !open;
    block.classList.toggle('open', open);
    input.setAttribute('aria-expanded', String(open));
  };
  const close = () => { setOpen(false); input.removeAttribute('aria-activedescendant'); active = -1; };
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
    onChoose(it);
  };

  async function update() {
    clearTimeout(timer);
    const text = input.value.trim();
    clear.hidden = !input.value;
    const my = ++ticket;
    if (!text) {                                     // empty box: the five boroughs
      items = deps.places.filter((p) => p.level === 'borough');
      list.dataset.query = '';
      active = -1;
      render();
      return;
    }
    timer = setTimeout(async () => {
      try {
        await deps.ready();
        const res = await suggest(text, deps);
        if (my !== ticket) return;                   // a newer keystroke won
        items = res;
        list.dataset.query = text;                   // which text these results answer (tests wait on it)
        active = items.length ? 0 : -1;              // the first suggestion is what Enter picks
        render(items.length ? '' : 'No results. Try "350 5th Ave" or "5th Ave and 42nd St".');
      } catch (err) {
        if (my !== ticket) return;
        console.error(err);
        items = [];
        render('Search is unavailable right now');
      }
    }, DEBOUNCE_MS);
  }

  input.addEventListener('input', update);
  input.addEventListener('focus', () => { onFocus?.(); update(); });
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
