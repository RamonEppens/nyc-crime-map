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
// Results are shown in sections (exact locations, streets, boroughs, neighborhoods, parks, other
// places, precincts); every section but exact locations has "See all", a full list to browse.
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
// Sections, in their default order; within a search they are ordered by their best match.
export const GROUPS = [
  { key: 'point', title: 'Exact locations', icon: 'pin' },
  { key: 'borough', title: 'Boroughs', icon: 'area', all: 'boroughs' },
  { key: 'nta', title: 'Neighborhoods', icon: 'area', all: 'neighborhoods' },
  { key: 'park', title: 'Parks', icon: 'area', all: 'parks' },
  { key: 'place', title: 'Other places', icon: 'area', all: 'other places (airports, cemeteries...)' },
  { key: 'precinct', title: 'Precincts', icon: 'area', all: 'precincts' },
  { key: 'street', title: 'Streets', icon: 'street', all: 'streets' },
];
const GROUP = Object.fromEntries(GROUPS.map((g, i) => [g.key, { ...g, order: i }]));
const BORO_ORDER = [1, 3, 4, 2, 5];
const PER_GROUP = { point: 6, street: 5, borough: 3, nta: 3, park: 3, place: 3, precinct: 3 };

/** Sections for the empty box: the five boroughs, and a "See all" for every other list. */
export function browseStart(places) {
  return GROUPS.filter((g) => g.key !== 'point' && g.key !== 'street').map((g) => {
    const all = places.filter((p) => p.group === g.key);
    return { key: g.key, title: g.title, icon: g.icon, total: all.length, items: g.key === 'borough' ? all : [] };
  });
}

/**
 * deps: { query, places: [{type:'area', level, group, code, boro, label, detail}], ntaName(code),
 *         ntaAt(lngLat), boroName(code) }
 * Returns sections: [{key, title, icon, items, total}] (items: {type:'point'|'street'|'area', ...}).
 */
export async function suggest(raw, deps) {
  const { text, boro } = splitBorough(raw);
  if (!text) return [];
  const placeOf = (s, lngLat) => [deps.boroName(s.boro), deps.ntaAt(lngLat)].filter(Boolean).join(' · ');
  const section = (key, items, total = items.length, rank = 0) => ({ ...GROUP[key], items: items.slice(0, PER_GROUP[key]), total, rank });

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
    const items = rows
      .map((r) => {
        const [sa, sb] = rankA.has(r.a) && rankB.has(r.b) ? [r.a, r.b] : [r.b, r.a];
        return { ...r, sa, sb, rank: (rankA.get(sa) ?? 9) * 100 + (rankB.get(sb) ?? 99) };
      })
      .sort((p, q) => p.rank - q.rank)
      .filter((r) => !seen.has(`${r.x},${r.y}`) && seen.add(`${r.x},${r.y}`))   // one result per place
      .map((r) => {
        const a = streetById(r.sa); const b = streetById(r.sb);
        const lngLat = [r.x / 1e5, r.y / 1e5];
        return { type: 'point', kind: 'corner', label: `${a.name} & ${b.name}`, detail: `Corner · ${placeOf(a, lngLat)}`, lngLat };
      });
    return items.length ? [section('point', items)] : [];
  }

  // 2. areas (precinct patterns first, so "75th precinct" never becomes an address)
  // "See all" on an area section opens the whole category, so it shows the category's size.
  const areaSections = groupAreas(matchAreas(text, deps.places, boro), section,
    (key) => deps.places.filter((p) => p.group === key).length);
  if (PRECINCT.some((re) => re.test(text))) return areaSections;
  const bare = BARE_NUMBER.exec(text);
  if (bare && !bare[2]) return areaSections;                         // "75": only the precinct

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
      const items = cands.filter((s) => found.has(s.id)).map((s) => ({
        type: 'point', kind: 'address', label: `${addr[1]} ${s.name}`, detail: placeOf(s, found.get(s.id)), lngLat: found.get(s.id),
      }));
      if (items.length) return [section('point', items), ...areaSections];
    }
  }

  // 4. plain text: areas + whole streets, each section ordered by its best match
  const key = clave(text);
  const streets = matchStreets(text, boro, 2000);
  const sections = [...areaSections];
  if (streets.length) {
    const best = streets[0].key === key ? 0 : streets[0].key.startsWith(key) ? 1 : 2;
    sections.push(section('street', streets.map((s) => streetItem(s, deps)), streets.length, best));
  }
  return sections.sort((a, b) => a.rank - b.rank || a.order - b.order);
}

function streetItem(s, deps) {
  return {
    type: 'street', id: s.id, label: s.name, boro: s.boro,
    detail: `Whole street · ${deps.boroName(s.boro)}${s.nNtas > 2 ? ` · ${s.nNtas} neighborhoods`
      : s.ntas.length ? ` · ${s.ntas.map(deps.ntaName).join(', ')}` : ''}`,
  };
}

/** "350 5th ave, brooklyn" -> {text: '350 5th ave', boro: 3} */
function splitBorough(raw) {
  let text = raw.trim().replace(/,/g, ' ').replace(/\s+/g, ' ');
  let boro = 0;
  for (const [re, b] of BOROUGH_WORDS) {
    const m = re.exec(text);
    if (m && m.index > 0) { boro = b; text = text.slice(0, m.index).trim(); break; }
  }
  return { text, boro };
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
  hits.sort((a, b) => a.rank - b.rank || naturalCompare(a.p.label, b.p.label));
  return hits;
}

/** Area hits -> one section per group (boroughs, neighborhoods, parks, other places, precincts). */
function groupAreas(hits, section, categorySize) {
  const by = new Map();
  for (const h of hits) {
    if (!by.has(h.p.group)) by.set(h.p.group, []);
    by.get(h.p.group).push(h);
  }
  return [...by].map(([key, hs]) => section(key, hs.map((h) => h.p), categorySize(key), hs[0].rank));
}

/** The full list behind "See all": areas of one kind, or every street matching the text, by borough. */
export function browseList(key, raw, deps) {
  const byBoro = (items) => BORO_ORDER
    .map((b) => ({ title: deps.boroName(b), items: items.filter((it) => it.boro === b) }))
    .filter((sec) => sec.items.length);
  if (key === 'street') {
    const { text, boro } = splitBorough(raw);
    const items = matchStreets(text, boro, 5000).map((s) => streetItem(s, deps))
      .sort((a, b) => naturalCompare(a.label, b.label));
    return { title: `Streets matching “${raw.trim()}”`, total: items.length, sections: byBoro(items) };
  }
  const items = deps.places.filter((p) => p.group === key)
    .sort((a, b) => (key === 'precinct' ? a.code - b.code : naturalCompare(a.label, b.label)));
  if (key === 'borough') return { title: 'All boroughs', total: items.length, sections: [{ title: '', items }] };
  return { title: `All ${GROUP[key].all}`, total: items.length, sections: byBoro(items) };
}

// ---------------------------------------------------------------- the combobox
/**
 * input, list: elements; deps: see suggest(); onChoose(item); onFocus(): load what search needs.
 * The list is built from rows: section titles (with "See all" when there is more to browse),
 * results, and in a full list a "Back" row. Arrow keys move over results, "See all" and "Back".
 */
export function setupSearch(input, list, deps, onChoose, onFocus) {
  const block = input.closest('.search');
  const clear = block.querySelector('.search-clear');
  let rows = [];               // {kind: 'title'|'sub'|'item'|'all'|'back', ...}
  let active = -1;
  let timer;
  let ticket = 0;
  let browsing = null;         // key of the full list being browsed, or null
  const selectable = () => rows.map((r, i) => (r.kind === 'item' || r.kind === 'all' || r.kind === 'back' ? i : -1)).filter((i) => i >= 0);

  const setOpen = (open) => {
    list.hidden = !open;
    block.classList.toggle('open', open);
    input.setAttribute('aria-expanded', String(open));
  };
  const close = () => { setOpen(false); input.removeAttribute('aria-activedescendant'); active = -1; };
  const icon = (name) => `<span class="opt-icon icon-${name}" aria-hidden="true"></span>`;
  const rowHtml = (r, i) => {
    const sel = i === active;
    if (r.kind === 'title') {
      return `<li class="search-group" role="presentation"><span>${esc(r.title)}</span>${r.allIndex != null
        ? `<span class="search-all" role="option" id="search-opt-${r.allIndex}" data-i="${r.allIndex}" aria-selected="${r.allIndex === active}">See all ${r.total}</span>` : ''}</li>`;
    }
    if (r.kind === 'sub') return `<li class="search-sub" role="presentation">${esc(r.title)}</li>`;
    if (r.kind === 'back') {
      return `<li class="search-back" role="option" id="search-opt-${i}" data-i="${i}" aria-selected="${sel}">
        <span class="back-arrow" aria-hidden="true"></span><span>${esc(r.title)}</span><span class="search-count">${r.total}</span></li>`;
    }
    if (r.kind === 'all') return '';                     // drawn inside its section title
    return `<li role="option" id="search-opt-${i}" aria-selected="${sel}" data-i="${i}">${icon(r.icon)}
      <span class="opt-text"><span class="opt-label">${esc(r.item.label)}</span>${r.item.detail ? `<span class="opt-detail">${esc(r.item.detail)}</span>` : ''}</span></li>`;
  };
  const render = (status = '') => {
    list.innerHTML = rows.map(rowHtml).join('') + (status ? `<li class="search-status" role="presentation">${status}</li>` : '');
    setOpen(rows.length > 0 || !!status);
    if (active >= 0) {
      input.setAttribute('aria-activedescendant', `search-opt-${active}`);
      list.querySelector(`#search-opt-${active}`)?.scrollIntoView({ block: 'nearest' });
    } else input.removeAttribute('aria-activedescendant');
  };
  /** Sections -> rows. A section title carries "See all" (a selectable row of its own). */
  const fromSections = (sections, detailOf = (it) => it.detail) => {
    const out = [];
    for (const sec of sections) {
      const title = { kind: 'title', title: sec.title, total: sec.total };
      out.push(title);
      if (GROUP[sec.key]?.all && sec.total > sec.items.length) {        // only when there is more to see
        title.allIndex = out.length;
        out.push({ kind: 'all', key: sec.key, total: sec.total });
      }
      for (const it of sec.items) out.push({ kind: 'item', item: { ...it, detail: detailOf(it, sec) }, icon: sec.icon });
    }
    return out;
  };
  const choose = (r) => {
    if (r.kind === 'all') return openList(r.key);
    if (r.kind === 'back') return closeList();
    const it = r.item;
    input.value = it.label;
    clear.hidden = false;
    browsing = null;
    close();
    input.blur();
    onChoose(it);
  };

  function openList(key) {
    browsing = key;
    const res = browseList(key, input.value, deps);
    const icon = GROUP[key].icon;
    rows = [{ kind: 'back', title: res.title, total: res.total }];
    for (const sec of res.sections) {
      if (sec.title) rows.push({ kind: 'sub', title: sec.title });
      for (const it of sec.items) {
        rows.push({ kind: 'item', icon, item: { ...it, detail: key === 'street' ? it.detail.replace(/^Whole street · [^·]+(· )?/, '') : '' } });
      }
    }
    list.dataset.query = `all:${key}`;
    active = selectable()[1] ?? 0;
    render();
    list.scrollTop = 0;
    input.focus();
  }
  function closeList() {
    browsing = null;
    update();
    input.focus();
  }

  async function update() {
    clearTimeout(timer);
    const text = input.value.trim();
    clear.hidden = !input.value;
    browsing = null;
    const my = ++ticket;
    if (!text) {                                     // empty box: boroughs, and every list to browse
      rows = fromSections(browseStart(deps.places), (it) => (it.level === 'borough' ? '' : it.detail));
      list.dataset.query = '';
      active = -1;
      render();
      return;
    }
    timer = setTimeout(async () => {
      try {
        await deps.ready();
        const sections = await suggest(text, deps);
        if (my !== ticket) return;                   // a newer keystroke won
        // Inside a section the kind is in its title, so details keep only what tells results apart.
        rows = fromSections(sections, (it, sec) => (sec.key === 'street' ? it.detail.replace(/^Whole street · /, '')
          : sec.key === 'point' ? it.detail : it.level === 'borough' ? '' : (it.boroName ?? it.detail)));
        list.dataset.query = text;                   // which text these results answer (tests wait on it)
        active = rows.findIndex((r) => r.kind === 'item');   // the first result is what Enter picks
        render(rows.length ? '' : 'No results. Try "350 5th Ave" or "5th Ave and 42nd St".');
      } catch (err) {
        if (my !== ticket) return;
        console.error(err);
        rows = [];
        render('Search is unavailable right now');
      }
    }, DEBOUNCE_MS);
  }

  const move = (step) => {
    const sel = selectable();
    if (!sel.length) return;
    const k = sel.indexOf(active);
    active = sel[(k + step + sel.length) % sel.length];
    render();
  };
  input.addEventListener('input', update);
  input.addEventListener('focus', () => { onFocus?.(); if (!browsing) update(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { if (list.hidden) update(); else move(1); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { move(-1); e.preventDefault(); }
    else if (e.key === 'Enter' && !list.hidden && active >= 0 && rows[active]) { choose(rows[active]); e.preventDefault(); }
    else if (e.key === 'Escape' && !list.hidden) {
      if (browsing) closeList(); else close();
      e.preventDefault();                            // a search input clears itself on Esc otherwise
      e.stopPropagation();
    }
  });
  list.addEventListener('mousedown', (e) => {          // mousedown: fires before the input loses focus
    const li = e.target.closest('[data-i]');
    e.preventDefault();
    if (li) choose(rows[+li.dataset.i]);
  });
  list.addEventListener('mousemove', (e) => {
    const li = e.target.closest('[data-i]');
    if (li && +li.dataset.i !== active) {
      active = +li.dataset.i;
      list.querySelectorAll('[data-i]').forEach((el) => el.setAttribute('aria-selected', String(+el.dataset.i === active)));
      input.setAttribute('aria-activedescendant', `search-opt-${active}`);
    }
  });
  input.addEventListener('blur', () => setTimeout(() => { if (document.activeElement !== input) { browsing = null; close(); } }, 150));
  clear.addEventListener('click', () => {
    input.value = '';
    clear.hidden = true;
    input.focus();
    update();
  });
}
