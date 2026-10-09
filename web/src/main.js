// Entry point: state, queries and wiring between filters, map and summary panel.
import './styles.css';
import { initDb, query, loadJson } from './db.js';
import {
  createMap, setTheme, setHexagons, setUniverse, hexStats, setSelection, showBounds,
  setView, setPrecinctShapes, setPrecincts, precinctUnit, precinctName, setTint,
  setPin, flyToPoint, fitTo, setHighlight, followTo, followEnd,
} from './map.js';
import { hexAt, hexCenter, hexPolygon, featureAt, meters, circlePolygon, bounds, degLat, degLon } from './geo.js';
import { setupSearch, loadStreets, streetById } from './search.js';
import { GROUP_COLORS, GROUP_LABELS, GROUP_RAMPS } from './colors.js';
import { buildReport } from './report.js';
import { fmt, fmtCompact, fmtChange, fmtShort } from './format.js';
import {
  MODES, MONTH_NAMES, FIRST_YEAR, LAST_YEAR, N_MONTHS, defaultPeriod, monthsOf, monthSql, labelOf,
  daysOf, comparisonOf, mIndex, yearOf, monthOf,
} from './period.js';

const $ = (sel) => document.querySelector(sel);
const YEARS = Array.from({ length: LAST_YEAR - FIRST_YEAR + 1 }, (_, i) => FIRST_YEAR + i);

const state = {
  period: defaultPeriod(),
  cats: null,                                   // Set of selected category codes (all by default)
  notMapped: new Set(),                         // categories NYPD publishes without a location
  selected: null,                               // null (city) | {kind:'borough'|'nta', code} | {kind:'hex', q, r} | {kind:'address', lngLat, label} | {kind:'precinct', props}
  showAllBars: false,
  view: 'hex',                                  // 'hex' (3D hexagons) | 'precincts' (flat, by NYPD precinct)
  panelView: 'details',                         // details panel: 'details' | 'charts'
  wide: false,                                  // details panel expanded
};
const SPLIT_MONTH = 108;                        // 2025-01: first month with the 116th Precinct (see pipeline)
let meta;
let ntaGeo;                                     // neighborhood boundaries (for clicks and outlines)

// ---------- preferences (theme, collapsed blocks): remembered per browser when storage is available
function pref(key, fallback) {
  try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
}
function savePref(key, value) {
  try { localStorage.setItem(key, value); } catch { /* private mode: not remembered */ }
}

// ---------- query helpers
function where(months = monthsOf(state.period)) {
  const cats = [...state.cats];
  return `${monthSql(months)} AND cat IN (${cats.length ? cats.join(',') : '-1'})`;
}
const periodLabel = () => labelOf(state.period);

// ---------- blocks: Hide / Show
function setupBlocks() {
  for (const btn of document.querySelectorAll('.block-toggle')) {
    const body = document.getElementById(btn.getAttribute('aria-controls'));
    const block = btn.closest('[data-block]').dataset.block;
    const key = `block:${block}`;
    const persist = block !== 'detail';           // the details panel opens expanded every time
    const apply = (open) => {
      btn.setAttribute('aria-expanded', String(open));
      btn.textContent = open ? 'Hide' : 'Show';
      body.hidden = !open;
    };
    apply(!persist || pref(key, 'open') === 'open');
    btn.onclick = () => {
      const open = btn.getAttribute('aria-expanded') !== 'true';
      apply(open);
      if (persist) savePref(key, open ? 'open' : 'closed');
    };
    btn.expand = () => apply(true);
  }
}

// ---------- date range block
function option(value, label, selected) {
  return `<option value="${value}"${selected ? ' selected' : ''}>${label}</option>`;
}
function stepper(label, canPrev, canNext, onStep) {
  const el = document.createElement('div');
  el.className = 'stepper';
  el.innerHTML = `<button aria-label="Previous" ${canPrev ? '' : 'disabled'}>−</button>
    <output aria-live="polite">${label}</output>
    <button aria-label="Next" ${canNext ? '' : 'disabled'}>+</button>`;
  const [prev, next] = el.querySelectorAll('button');
  prev.onclick = () => onStep(-1, 'prev');
  next.onclick = () => onStep(1, 'next');
  return el;
}
function monthSelects(value, onChange) {
  const frag = document.createDocumentFragment();
  const month = document.createElement('div');
  month.className = 'select-wrap';
  month.innerHTML = `<select aria-label="Month">${MONTH_NAMES.map((n, i) => option(i, n.slice(0, 3), i === monthOf(value))).join('')}</select>`;
  const year = document.createElement('div');
  year.className = 'select-wrap';
  year.innerHTML = `<select aria-label="Year">${YEARS.map((y) => option(y, y, y === yearOf(value))).join('')}</select>`;
  const read = () => mIndex(+year.querySelector('select').value, +month.querySelector('select').value);
  month.querySelector('select').onchange = () => onChange(read());
  year.querySelector('select').onchange = () => onChange(read());
  frag.append(month, year);
  return frag;
}

function renderPeriod() {
  const p = state.period;
  const mode = $('#period-mode');
  mode.innerHTML = MODES.map(([v, l]) => option(v, l, v === p.mode)).join('');
  mode.onchange = () => { p.mode = mode.value; renderPeriod(); refresh(); };

  const box = $('.period-inputs');
  box.innerHTML = '';
  // Re-render after each change, keeping keyboard focus on the control that was used.
  const set = (patch, focus) => {
    Object.assign(p, patch);
    renderPeriod();
    refresh();
    if (focus) {
      const [prev, next] = document.querySelectorAll('.stepper button');
      const target = focus === 'prev' ? (prev.disabled ? next : prev) : (next.disabled ? prev : next);
      target?.focus();
    }
  };
  if (p.mode === 'year') {
    box.append(stepper(p.year, p.year > FIRST_YEAR, p.year < LAST_YEAR, (d, f) => set({ year: p.year + d }, f)));
  } else if (p.mode === 'month') {
    box.append(stepper(`${MONTH_NAMES[monthOf(p.month)]} ${yearOf(p.month)}`, p.month > 0, p.month < N_MONTHS - 1,
      (d, f) => set({ month: p.month + d }, f)));
  } else if (p.mode === 'crossyear') {
    box.append(stepper(MONTH_NAMES[p.crossMonth], true, true, (d, f) => set({ crossMonth: (p.crossMonth + d + 12) % 12 }, f)));
    const hint = document.createElement('p');
    hint.className = 'hint';
    hint.textContent = `Every ${MONTH_NAMES[p.crossMonth]} from ${FIRST_YEAR} to ${LAST_YEAR}, combined.`;
    box.append(hint);
  } else if (p.mode === 'yearRange') {
    for (const [label, key] of [['From', 'fromYear'], ['To', 'toYear']]) {
      const row = document.createElement('div');
      row.className = 'range-row years';
      row.innerHTML = `<span>${label}</span><div class="select-wrap"><select aria-label="${label} year">
        ${YEARS.map((y) => option(y, y, y === p[key])).join('')}</select></div>`;
      row.querySelector('select').onchange = (e) => set({ [key]: +e.target.value });
      box.append(row);
    }
  } else if (p.mode === 'monthRange') {
    for (const [label, key] of [['From', 'fromMonth'], ['To', 'toMonth']]) {
      const row = document.createElement('div');
      row.className = 'range-row';
      row.innerHTML = `<span>${label}</span>`;
      row.append(monthSelects(p[key], (v) => set({ [key]: v })));
      box.append(row);
    }
  }
}

// ---------- offense types block: one toggle per category, "only", All / None
function renderCategories() {
  const grid = $('.cat-grid');
  grid.innerHTML = '';
  const total = meta.categories.length;
  $('#offenses-count').textContent = state.cats.size === total ? `all ${total}` : `${state.cats.size} of ${total}`;
  for (const g of Object.keys(GROUP_LABELS)) {
    const group = document.createElement('div');
    group.className = 'cat-group';
    group.style.setProperty('--g', GROUP_COLORS[g]);
    group.innerHTML = `<h3 class="cat-group-title">${GROUP_LABELS[g]}${g === 'enforcement' ? ' <span class="group-note">(mostly reflect police activity)</span>' : ''}</h3><div class="chips"></div>`;
    const chips = group.querySelector('.chips');
    for (const c of meta.categories.filter((x) => x.group === g)) {
      const cell = document.createElement('div');
      cell.className = 'cat';
      const on = state.cats.has(c.code);
      const hidden = state.notMapped.has(c.code);
      const tip = hidden ? `${c.label}: location withheld by NYPD, counted in totals but not drawn` : c.label;
      cell.innerHTML = `<button class="cat-toggle" data-code="${c.code}" aria-pressed="${on}" title="${tip}">
          <span class="dot" aria-hidden="true"></span><span class="name">${c.label}</span>${hidden ? '<span class="mark" aria-hidden="true">†</span>' : ''}</button>
        <button class="cat-only" aria-label="Show only ${c.label}">only</button>`;
      cell.querySelector('.cat-toggle').onclick = () => {
        state.cats.has(c.code) ? state.cats.delete(c.code) : state.cats.add(c.code);
        renderCategories(); refresh();
        grid.querySelector(`[data-code="${c.code}"]`).focus();
      };
      cell.querySelector('.cat-only').onclick = () => {
        state.cats = new Set([c.code]);
        renderCategories(); refresh();
      };
      chips.append(cell);
    }
    grid.append(group);
  }
}
function setupCategoryActions() {
  document.querySelector('[data-select="all"]').onclick = () => {
    state.cats = new Set(meta.categories.map((c) => c.code)); renderCategories(); refresh();
  };
  document.querySelector('[data-select="none"]').onclick = () => {
    state.cats = new Set(); renderCategories(); refresh();
  };
}

// Legend: the same ramp and breaks the map is using right now (breaks follow the viewport).
function renderLegend(ramp, breaks, unit = 'hexagon') {
  $('#legend-title').textContent = `Complaints per ${unit}`;
  $('#legend-hint').textContent = unit === 'precinct'
    ? 'A sixth of the precincts per color, sex crimes included'
    : 'Each color holds about a sixth of the hexagons in view';
  $('.legend-ramp').innerHTML = ramp.map((c) => `<span style="background:${c}"></span>`).join('');
  // Each break sits on the boundary between two colors (k / 6 of the width).
  $('.legend-labels').innerHTML = '<span class="end start">fewer</span>'
    + breaks.map((b, i) => `<span style="left:${((i + 1) / ramp.length) * 100}%">${fmtShort(b)}</span>`).join('')
    + '<span class="end stop">more</span>';
}

function renderCity({ total, precinctOnly, previous, compare, days }) {
  const change = compare && previous ? ((total - previous) / previous) * 100 : NaN;
  showFigures([
    fig('Complaints', fmt(total)),
    fig('Per day', fmt(total / days)),
    compare && previous
      ? fig(compare.label.replace(/^vs /, 'Change vs '), fmtChange(change))
      : fig('Location withheld', fmt(precinctOnly), 'counted, not on the map'),
    fig('Per 1,000 residents', fmt(total / (meta.totals.population_2020 / 1000)), '2020 Census population'),
  ]);
}

/** One figure tile: short label above, the number, and an optional small note below. */
const fig = (label, value, note = '', small = false, help = '') => ({ label, value, note, small, help });
const helpMark = (text) => (text
  ? ` <span class="q" tabindex="0" role="img" aria-label="${text.replace(/"/g, '&quot;')}" title="${text.replace(/"/g, '&quot;')}">?</span>` : '');
function showFigures(figures, note = '') {
  $('.figures').innerHTML = figures.map((f) => `<div class="figure"><div class="label">${f.label}${helpMark(f.help)}</div>
    <div class="value${f.small ? ' small' : ''}">${f.value}</div>${f.note ? `<div class="fnote">${f.note}</div>` : ''}</div>`).join('');
  $('.figures-note').textContent = note;
}

/** Change vs the comparison period. Small counts (under 20) show both numbers instead of a
 *  percentage, which would swing wildly. */
function changeNote(total, previous, compare) {
  if (!compare || previous == null) return '';
  if (total < 20 || previous < 20) return `${fmt(previous)} ${compare.label.replace(/^vs /, 'in ')}`;
  return `${fmtChange(((total - previous) / previous) * 100)} ${compare.label}`;
}

const ordinal = (n) => {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] || s[v] || s[0]}`;
};
/** Share (0-100) of values strictly below x. */
const percentileOf = (values, x) => Math.round((100 * values.filter((v) => v < x).length) / Math.max(1, values.length));

function renderBars(rows) {
  const byCat = new Map(rows.map((r) => [r.cat, r.n]));
  const items = meta.categories
    .filter((c) => state.cats.has(c.code))
    .map((c) => ({ label: c.label, n: byCat.get(c.code) ?? 0 }))
    .sort((a, b) => b.n - a.n);
  const shown = state.showAllBars ? items : items.slice(0, 8);
  const max = Math.max(1, ...items.map((i) => i.n));
  const color = chartColor();
  $('.bars').innerHTML = shown.map(({ label, n }) => `<div class="bar"><span class="name">${label}</span><span class="num">${fmt(n)}</span>
      <span class="track"><span class="fill" style="width:${Math.max(0.6, (n / max) * 100)}%;background:${color}"></span></span></div>`).join('');
  const more = $('.more');
  more.hidden = items.length <= 8;
  more.textContent = state.showAllBars ? 'Show fewer' : `Show all ${items.length}`;
  more.onclick = () => { state.showAllBars = !state.showAllBars; renderBars(rows); };
}

// Summary in the title block: the total for the current filters (a link to the city panel) and
// what part of it the current view cannot draw.
function renderSummary({ total, precinctOnly, none, noPrecinct }) {
  $('#city-total').textContent = `${fmt(total)} complaints`;
  $('#summary-filter').textContent = filterLabel();
  $('#summary-sub').textContent = state.view === 'precincts'
    ? (noPrecinct ? `${fmt(noPrecinct)} without a precinct` : 'All drawn by precinct')
    : `${fmt(precinctOnly + none)} not on the map (location withheld)`;
}

// ---------- selection: a neighborhood (NTA) or a hexagon, shown in the right panel
const CITY_NOTE = 'Counts are complaints reported to the NYPD. They are not arrests or convictions, and they do not measure risk.';
const updatedLabel = () => new Date(meta.source.rows_updated_at).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
const filterLabel = () => {
  const n = state.cats.size;
  const all = meta.categories.length;
  return `${periodLabel()}, ${n === all ? 'all offenses' : `${n} of ${all} offense types`}`;
};

function renderHeader(title, context) {
  $('.detail h2').textContent = title;
  $('.detail .sub').textContent = filterLabel();
  const ctx = $('.detail .context');
  ctx.innerHTML = context ?? '';
  ctx.hidden = !context;
  ctx.querySelector('[data-nta]')?.addEventListener('click', (e) => {
    selectNta(+e.currentTarget.dataset.nta, { move: true });
  });
  ctx.querySelector('[data-boro]')?.addEventListener('click', (e) => selectBorough(+e.currentTarget.dataset.boro));
}

function selectNta(code, { move = false } = {}) {
  const feature = ntaGeo.features.find((f) => f.properties.code === code);
  state.selected = { kind: 'nta', code };
  setSelection(feature, 'area');
  setPin(null);
  if (move) fitTo(bounds(feature), { maxZoom: 15, duration: 1600 });
  refresh();
}
// Borough outlines are only needed once someone picks a borough, so they load on demand.
let boroughGeo;
async function selectBorough(code) {
  state.selected = { kind: 'borough', code };
  boroughGeo ??= await loadJson('boroughs.geojson');
  if (state.selected?.kind !== 'borough' || state.selected.code !== code) return;   // picked something else meanwhile
  const feature = boroughGeo.features.find((f) => f.properties.boro === code);
  setSelection(feature, 'area');
  setPin(null);
  fitTo(bounds(feature), { maxZoom: 15, duration: 1600 });
  refresh();
}
const boroughPopulation = (code) => meta.ntas.filter((n) => n.boro === code).reduce((t, n) => t + n.population, 0);

// Precinct boundaries load the first time the precinct view is used.
let precinctGeo;
async function ensurePrecincts() {
  if (precinctGeo) return;
  precinctGeo = await loadJson('precincts.geojson');
  setPrecinctShapes(precinctGeo);
}
const precinctMerged = () => Math.min(...monthsOf(state.period)) < SPLIT_MONTH;
function selectPrecinct(props, { move = false } = {}) {
  state.selected = { kind: 'precinct', props };
  const feature = precinctGeo.features.find((f) => f.properties === props || (f.properties.pct === props.pct && !props.merged));
  setSelection(feature, 'area');
  setPin(null);
  if (move) fitTo(bounds(feature), { maxZoom: 15, duration: 1600 });
  refresh();
}
/** From search: a precinct number. Before 2025 the 105th, 113th and 116th are one area. */
async function selectPrecinctNumber(pct) {
  await ensurePrecincts();
  const merged = precinctMerged() && precinctGeo.features.find((f) => f.properties.merged?.includes(pct));
  const f = merged || precinctGeo.features.find((x) => x.properties.pct === pct);
  if (f) selectPrecinct(f.properties, { move: true });
}

function selectHex(q, r) {
  state.selected = { kind: 'hex', q, r };
  setSelection(hexPolygon(q, r));
  setPin(null);
  refresh();
}
const RADIUS_M = 200;
/** An address or a corner: pin + 200 m circle, flown to closely enough to show locations. */
function selectPoint(lngLat, label, corner = false) {
  state.selected = { kind: 'point', lngLat, label, corner };
  setSelection(circlePolygon(lngLat, RADIUS_M, 72), 'circle');
  setPin(lngLat);
  flyToPoint(lngLat);
  refresh();
}
// ---------- block highlight (hovering a block in a chart lights it on the map)
// A block is street + hundred of the house number (thousand for Queens hyphen numbers, which
// are stored as 1,000,000 + a·1000 + b). Its geometry is the street's segments whose midpoint
// number falls inside the block, so a segment that only touches the block edge doesn't count.
const segCache = new Map();
const cornerCache = new Map();
function streetSegments(id) {
  if (!segCache.has(id)) {
    segCache.set(id, query(`SELECT lf, lt, rf, rt, xy FROM street_segments WHERE street = ${id}`).then((rows) => rows.map((r) => {
      const left = r.lf > 0 || r.lt > 0;
      const a = left ? r.lf : r.rf, b = left ? r.lt : r.rt;
      const c = [];
      for (let k = 0; k < r.xy.length; k += 2) c.push([r.xy[k], r.xy[k + 1]]);
      return { lo: Math.min(a, b), hi: Math.max(a, b), xy: c };
    }).filter((g) => g.hi > 0)));
  }
  return segCache.get(id);
}
function streetCorners(id) {
  if (!cornerCache.has(id)) {
    cornerCache.set(id, query(`SELECT a, b, x, y FROM street_corners WHERE a = ${id} OR b = ${id}`)
      .then((rows) => rows.map((r) => ({ other: r.a === id ? r.b : r.a, x: r.x, y: r.y }))));
  }
  return cornerCache.get(id);
}
async function blockSegments(street, block) {
  const span = block >= 1_000_000 ? 1000 : 100;
  const segs = await streetSegments(street);
  return segs.filter((g) => { const mid = (g.lo + g.hi) / 2; return mid >= block && mid < block + span; })
    .sort((a, b) => a.lo - b.lo);
}
/** The cross street meeting this street at a node, if any (corners are snapped, so allow ~5 m). */
function crossAt(corners, [x, y], street) {
  let best = null, bestD = 36;
  for (const c of corners) {
    const d = (c.x - x) ** 2 + (c.y - y) ** 2;
    if (d <= bestD && c.other !== street) { best = c; bestD = d; }
  }
  return best && streetById(best.other)?.name;
}
/** Sentence for the tooltip: "between X and Y" or "at X" (null when neither end is a corner). */
async function blockBetween(street, block, segs) {
  if (!segs.length) return null;
  const corners = await streetCorners(street);
  // The block's two ends: the low end of its lowest-numbered segment and the high end of its
  // highest. Segments are drawn in either direction, so try both ends and keep the outermost.
  const ends = (g) => [g.xy[0], g.xy[g.xy.length - 1]];
  const first = segs[0], last = segs[segs.length - 1];
  const names = [];
  for (const g of first === last ? [first] : [first, last]) {
    for (const p of ends(g)) {
      const n = crossAt(corners, p, street);
      if (n && !names.includes(n)) names.push(n);
    }
  }
  if (!names.length) return null;
  if (names.length === 1) return `at ${names[0]}`;
  return `between ${names[0]} and ${names[names.length - 1]}`;
}
let highlightTicket = 0;
/** Light one block on the map; resolves to extra tooltip html (the cross streets). */
async function highlightBlock(street, block) {
  const ticket = ++highlightTicket;
  const segs = await blockSegments(street, block);
  if (ticket !== highlightTicket) return null;
  const feature = segs.length ? { type: 'Feature', properties: {},
    geometry: { type: 'MultiLineString', coordinates: segs.map((g) => g.xy.map(([x, y]) => [x / 1e5, y / 1e5])) } } : null;
  setHighlight(feature);
  if (feature) followTo(bounds(feature));
  const between = await blockBetween(street, block, segs);
  return between && ticket === highlightTicket ? `<span class="tip-between">${between}</span>` : null;
}
/** Go to a block (click in "Busiest blocks"): the 200 m view around its middle. */
async function selectBlock(street, block) {
  const segs = await blockSegments(street, block);
  if (!segs.length) return;
  const g = segs[Math.floor(segs.length / 2)];
  const [a, b] = [g.xy[0], g.xy[g.xy.length - 1]];
  const [x, y] = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  clearHighlight();
  selectPoint([x / 1e5, y / 1e5], `${blockLabel(block)} ${streetById(street)?.name ?? ''}`.trim());
}
/** Light a neighborhood (borough charts) and glide to it; no extra tooltip line. */
function highlightArea(code) {
  highlightTicket++;
  const feature = ntaGeo.features.find((f) => f.properties.code === code);
  setHighlight(feature ?? null);
  if (feature) followTo(bounds(feature), { maxZoom: 14 });
  return null;
}
function clearHighlight() {
  highlightTicket++;
  setHighlight(null);
  followEnd();
}

/** A whole street: all its segments as one line. */
async function selectStreet(id) {
  state.selected = { kind: 'street', id };
  setPin(null);
  const [rows] = await Promise.all([query(`SELECT xy FROM street_segments WHERE street = ${id}`), streetSegments(id)]);
  if (state.selected?.kind !== 'street' || state.selected.id !== id) return;
  const lines = rows.map((r) => {
    const c = [];
    for (let k = 0; k < r.xy.length; k += 2) c.push([r.xy[k] / 1e5, r.xy[k + 1] / 1e5]);
    return c;
  });
  const feature = { type: 'Feature', properties: {}, geometry: { type: 'MultiLineString', coordinates: lines } };
  setSelection(feature, 'line');
  fitTo(bounds(feature), { maxZoom: 15.5, duration: 1600 });
  refresh();
}
function selectCity() {
  state.selected = { kind: 'city' };
  setSelection(null);
  refresh();
}
function clearSelection() {
  state.selected = null;
  setPanelView('details');
  $('#search').value = '';
  $('.search-clear').hidden = true;
  setSelection(null);
  setPin(null);
  refresh();
}

function onPick(pick) {
  if (pick.kind === 'precinct') return selectPrecinct(pick.unit);
  if (pick.kind === 'none') return clearSelection();
  if (pick.kind === 'hex') return selectHex(pick.q, pick.r);
  if (pick.kind === 'point') { const { q, r } = hexAt(pick.lngLat); return selectHex(q, r); }
  const f = featureAt(ntaGeo, pick.lngLat);
  return f ? selectNta(f.properties.code) : clearSelection();
}

// ---------- comparisons
// Each kind of selection has its own denominator, so "Index 2×" always means "double the
// typical", but typical is measured differently: points use a fixed area (200 m circle), streets
// their length (per 100 m), areas their residents, hexagons the median hexagon.
let cmp = null;                                  // compare.json (pipeline 08_streets.py)
let cmpPromise = null;
const loadCompare = () => (cmpPromise ??= loadJson('compare.json').then((c) => { cmp = c; return c; }));
const RESIDENT_NOTE = 'Rate uses resident population: areas with few residents and many visitors (Midtown, for example) come out high.';

/** The precomputed series to compare with, or the reason there is none: only all offense types
 *  or exactly one, and whole years (one year, or a range compared as its yearly average). */
function fairSeries() {
  const all = state.cats.size === meta.categories.length;
  const type = all ? 'all' : state.cats.size === 1 ? String([...state.cats][0]) : null;
  const p = state.period;
  let series = null; let years = 1;
  if (p.mode === 'year') series = String(p.year);
  else if (p.mode === 'yearRange') {
    years = Math.abs(p.toYear - p.fromYear) + 1;
    series = years === 1 ? String(Math.min(p.fromYear, p.toYear)) : 'avg';
  }
  if (!type) return { why: 'compared only for all offense types or exactly one' };
  if (!series) return { why: 'compared only for whole years' };
  return { type, series, years };
}
/** Share (0-100) of the compared set below x, from its 101 percentiles. */
function shareBelow(P, x) {
  let k = 0;
  for (let i = 0; i <= 100; i++) if (P[i] < x) k = i;
  return P[0] >= x ? 0 : Math.min(99, k);
}
const perYear = (days) => days / 365.25;
const fmtIndex = (x) => `${x < 10 ? x.toFixed(1) : Math.round(x)}×`;
const blockLabel = (b) => (b >= 1_000_000
  ? `${Math.floor((b - 1_000_000) / 1000)}-00 to ${Math.floor((b - 1_000_000) / 1000)}-99`
  : `${b}–${b + 99}`);
const fmtLength = (m) => (m >= 1000 ? `${(m / 1000).toFixed(m >= 10000 ? 0 : 1)} km` : `${Math.round(m / 10) * 10} m`);

async function renderSelection(ticket) {
  const sel = state.selected;
  const compare = comparisonOf(state.period);
  const top = (rows) => {
    const best = rows.reduce((a, b) => (b.n > (a?.n ?? -1) ? b : a), null);
    return best ? meta.categories[best.cat].label : 'None';
  };
  const sum = (rows) => rows.reduce((t, r) => t + r.n, 0);

  if (sel.kind === 'nta') {
    const info = meta.ntas[sel.code];
    const [byCat, prev, all] = await Promise.all([
      query(`SELECT cat, sum(n)::INTEGER AS n FROM agg_nta WHERE nta = ${sel.code} AND ${where()} GROUP BY 1`),
      compare ? query(`SELECT sum(n)::INTEGER AS n FROM agg_nta WHERE nta = ${sel.code} AND ${where(compare.months)}`) : [{ n: 0 }],
      query(`SELECT nta, sum(n)::INTEGER AS n FROM agg_nta WHERE ${where()} GROUP BY 1`),
    ]);
    if (ticket !== pending) return;
    const total = sum(byCat);
    const counts = new Map(all.map((r) => [r.nta, r.n]));
    const cityRate = sum(all) / meta.ntas.reduce((t, x) => t + x.population, 0);
    const residential = info.type === 'residential' && info.population >= 1000;
    const rates = meta.ntas.filter((x) => x.type === 'residential' && x.population >= 1000)
      .map((x) => (counts.get(x.code) ?? 0) / x.population);
    const rate = total / Math.max(1, info.population);
    renderHeader(info.name, `Neighborhood in <button class="link" data-boro="${info.boro}">${meta.boroughs[info.boro]}</button>, ${info.population ? `${fmt(info.population)} residents` : 'no resident population'}`);
    const years = perYear(daysOf(monthsOf(state.period)));
    const per100k = (r) => fmt((r * 100000) / years);
    showFigures([
      fig('Complaints', fmt(total)),
      residential ? fig('Compared with typical', fmtIndex(rate / cityRate), 'the city rate per resident', false,
        `Complaints per resident ÷ the city rate. ${per100k(rate)} per 100,000 residents per year (city: ${per100k(cityRate)}).`)
        : fig('Compared with typical', 'n/a', 'few or no residents'),
      fig('Most frequent', top(byCat), '', true),
      residential ? fig('Percentile', ordinal(percentileOf(rates, rate)), 'among neighborhoods, per resident', false,
        'Share of residential neighborhoods (1,000+ residents) with a lower rate per resident.')
        : fig('Percentile', 'n/a', 'not ranked'),
    ], changeNote(total, prev[0]?.n ?? 0, compare));
    renderBars(byCat);
    $('.detail .note').textContent = `${RESIDENT_NOTE} Neighborhood counts include only complaints with a map location; rape and sex crimes are counted by precinct.`;
  } else if (sel.kind === 'borough') {
    // Boroughs use NYPD's precinct field, so they count every complaint, including those NYPD
    // places only at the station house (rape, sex crimes).
    const [byCat, prev, city] = await Promise.all([
      query(`SELECT cat, sum(n)::INTEGER AS n FROM agg_precinct WHERE boro = ${sel.code} AND ${where()} GROUP BY 1`),
      compare ? query(`SELECT sum(n)::INTEGER AS n FROM agg_precinct WHERE boro = ${sel.code} AND ${where(compare.months)}`) : [{ n: 0 }],
      query(`SELECT sum(n)::INTEGER AS n FROM agg_precinct WHERE ${where()}`),
    ]);
    if (ticket !== pending) return;
    const total = sum(byCat);
    const population = boroughPopulation(sel.code);
    const rate = total / population;
    const cityRate = (city[0]?.n ?? 0) / meta.totals.population_2020;
    const byBoro = await query(`SELECT boro, sum(n)::INTEGER AS n FROM agg_precinct WHERE boro BETWEEN 1 AND 5 AND ${where()} GROUP BY 1`);
    if (ticket !== pending) return;
    const boroRates = byBoro.map((r) => r.n / boroughPopulation(r.boro));
    const rank = 1 + boroRates.filter((r) => r > rate).length;
    const years = perYear(daysOf(monthsOf(state.period)));
    renderHeader(meta.boroughs[sel.code], `Borough of New York City, ${fmt(population)} residents`);
    showFigures([
      fig('Complaints', fmt(total)),
      cityRate ? fig('Compared with typical', fmtIndex(rate / cityRate), 'the city rate per resident', false,
        `Complaints per resident ÷ the city rate. ${fmt((rate * 100000) / years)} per 100,000 residents per year (city: ${fmt((cityRate * 100000) / years)}).`)
        : fig('Compared with typical', 'n/a'),
      fig('Most frequent', top(byCat), '', true),
      fig('Rank', ordinal(rank), 'of 5 boroughs, per resident', false, 'Position among the five boroughs by complaints per resident (1st = highest).'),
    ], changeNote(total, prev[0]?.n ?? 0, compare));
    renderBars(byCat);
    $('.detail .note').textContent = `${RESIDENT_NOTE} Borough counts include every complaint, also rape and sex crimes, which NYPD places at the precinct station house.`;
  } else if (sel.kind === 'precinct') {
    // NYPD's precinct field: every complaint counts, including those placed at the station house.
    const pcts = sel.props.merged ?? [sel.props.pct];
    const inList = `pct IN (${pcts.join(',')})`;
    const [byCat, prev, all, boro] = await Promise.all([
      query(`SELECT cat, sum(n)::INTEGER AS n FROM agg_precinct WHERE ${inList} AND ${where()} GROUP BY 1`),
      compare ? query(`SELECT sum(n)::INTEGER AS n FROM agg_precinct WHERE ${inList} AND ${where(compare.months)}`) : [{ n: 0 }],
      query(`SELECT pct, sum(n)::INTEGER AS n FROM agg_precinct WHERE pct > 0 AND ${where()} GROUP BY 1`),
      query(`SELECT boro FROM agg_precinct WHERE ${inList} GROUP BY 1 ORDER BY sum(n) DESC LIMIT 1`),
    ]);
    if (ticket !== pending) return;
    const total = sum(byCat);
    // Rank among the areas drawn for this period (the merged 105/113/116 counts as one).
    const counts = new Map(all.map((r) => [r.pct, r.n]));
    const units = new Map();
    for (const [pct, n] of counts) {
      const unit = precinctUnit(pct) ?? { pct };
      const k = unit.merged ? 'merged' : unit.pct;
      units.set(k, (units.get(k) ?? 0) + n);
    }
    await loadCompare();
    if (ticket !== pending) return;
    const popOf = (k) => (k === 'merged' ? [105, 113, 116].reduce((t, p) => t + (cmp.precinct_population[p] ?? 0), 0)
      : cmp.precinct_population[k] ?? 0);
    const population = pcts.reduce((t, p) => t + (cmp.precinct_population[p] ?? 0), 0);
    const cityRate = sum(all) / meta.totals.population_2020;
    const rate = total / Math.max(1, population);
    const rates = [...units].filter(([k]) => popOf(k) >= 1000).map(([k, n]) => n / popOf(k));
    const ranked = population >= 1000;
    const years = perYear(daysOf(monthsOf(state.period)));
    renderHeader(precinctName(sel.props), `NYPD precinct${sel.props.merged ? 's' : ''} in ${meta.boroughs[boro[0]?.boro] ?? 'New York City'}, ${fmt(population)} residents`
      + (sel.props.merged ? '<br>Shown together: the 116th was created from the 105th and 113th in December 2024.' : ''));
    showFigures([
      fig('Complaints', fmt(total)),
      ranked ? fig('Compared with typical', fmtIndex(rate / cityRate), 'the city rate per resident', false,
        `Complaints per resident ÷ the city rate. ${fmt((rate * 100000) / years)} per 100,000 residents per year (city: ${fmt((cityRate * 100000) / years)}).`)
        : fig('Compared with typical', 'n/a', 'few or no residents'),
      fig('Most frequent', top(byCat), '', true),
      ranked ? fig('Percentile', ordinal(percentileOf(rates, rate)), `among ${units.size} precincts, per resident`, false,
        'Share of precincts with a lower rate of complaints per resident.')
        : fig('Percentile', 'n/a', 'not ranked'),
    ], changeNote(total, prev[0]?.n ?? 0, compare));
    renderBars(byCat);
    $('.detail .note').textContent = `${RESIDENT_NOTE} Precinct counts use NYPD's precinct field and include every complaint, also rape and sex crimes. Population: 2020 Census blocks inside the precinct.`;
  } else if (sel.kind === 'point') {
    await renderPoint(sel, ticket, compare, top, sum);
  } else if (sel.kind === 'street') {
    await renderStreet(sel, ticket, compare, top, sum);
  } else {
    const { q, r } = sel;
    const [byCat, prev, all] = await Promise.all([
      query(`SELECT cat, sum(n)::INTEGER AS n FROM hex WHERE q = ${q} AND r = ${r} AND ${where()} GROUP BY 1`),
      compare ? query(`SELECT sum(n)::INTEGER AS n FROM hex WHERE q = ${q} AND r = ${r} AND ${where(compare.months)}`) : [{ n: 0 }],
      query(`SELECT sum(n)::INTEGER AS n FROM hex WHERE ${where()} GROUP BY q, r`),
    ]);
    if (ticket !== pending) return;
    const total = sum(byCat);
    const values = all.map((x) => x.n).sort((a, b) => a - b);
    const median = values.length ? values[Math.floor(values.length / 2)] : 0;
    const nta = featureAt(ntaGeo, hexCenter(q, r));
    renderHeader('Hexagon', nta
      ? `Hexagon of about 8 blocks in <button class="link" data-nta="${nta.properties.code}">${nta.properties.name}</button>`
      : 'Hexagon of about 8 blocks, 180 m per side');
    showFigures([
      fig('Complaints', fmt(total)),
      median ? fig('Compared with typical', `${(total / median).toFixed(1)}×`, 'the median hexagon') : fig('Compared with typical', 'n/a'),
      fig('Most frequent', top(byCat), '', true),
      fig('Percentile', ordinal(percentileOf(values, total)), 'among hexagons with complaints'),
    ], changeNote(total, prev[0]?.n ?? 0, compare));
    renderBars(byCat);
    $('.detail .note').textContent = 'NYPD places each complaint at the nearest intersection or mid-block, so a hexagon counts the complaints snapped inside it. Rape and sex crimes are never placed on the map.';
  }
}

/** Address or corner: complaints within 200 m, compared with 200 m circles every 100 m over
 *  all of NYC (compare.json). */
async function renderPoint(sel, ticket, compare, top, sum) {
  const [lon, lat] = sel.lngLat;
  const box = (m) => `lat BETWEEN ${lat - degLat(m)} AND ${lat + degLat(m)} AND lon BETWEEN ${lon - degLon(m)} AND ${lon + degLon(m)}`;
  const near = (rows) => rows.filter((p) => meters(sel.lngLat, [p.lon, p.lat]) <= RADIUS_M);
  const [byLocCat, prevLoc] = await Promise.all([
    query(`SELECT lat, lon, cat, sum(n)::INTEGER AS n FROM points WHERE ${box(RADIUS_M)} AND ${where()} GROUP BY ALL`),
    compare ? query(`SELECT lat, lon, sum(n)::INTEGER AS n FROM points WHERE ${box(RADIUS_M)} AND ${where(compare.months)} GROUP BY ALL`) : [],
    loadCompare(),
  ]);
  if (ticket !== pending) return;
  const byCatMap = new Map();
  for (const p of near(byLocCat)) byCatMap.set(p.cat, (byCatMap.get(p.cat) ?? 0) + p.n);
  const byCat = [...byCatMap].map(([cat, n]) => ({ cat, n }));
  const total = sum(byCat);
  const previous = compare ? sum(near(prevLoc)) : null;
  const fair = fairSeries();
  let index = fig('Compared with typical', '—', fair.why, false, 'Complaints within 200 m ÷ the median 200 m circle in NYC.');
  let pctl = fig('Percentile', '—', fair.why, false, 'Share of NYC 200 m circles with fewer complaints.');
  if (!fair.why) {
    const P = cmp.point[fair.type][fair.series];
    const x = total / fair.years;
    const circles = fmt(cmp.grid_points);
    index = P[50] > 0
      ? fig('Compared with typical', fmtIndex(x / P[50]), 'the typical 200 m circle in NYC', false,
        `Complaints within 200 m ÷ the median of ${circles} circles of 200 m centered every 100 m on land, same offense types and ${fair.series === 'avg' ? 'yearly average' : 'year'} (median: ${fmt(P[50])}).`)
      : fig('Compared with typical', 'n/a', 'the typical circle has none');
    pctl = fig('Percentile', ordinal(shareBelow(P, x)), 'among 200 m circles in NYC', false,
      `Share of the ${circles} 200 m circles across NYC with fewer complaints.`);
  }
  const nta = featureAt(ntaGeo, sel.lngLat);
  renderHeader(sel.label, `Within ${RADIUS_M}&nbsp;m of this ${sel.corner ? 'corner' : 'address'}${nta ? ` in <button class="link" data-nta="${nta.properties.code}">${nta.properties.name}</button>` : ''}`);
  showFigures([
    fig(`Within ${RADIUS_M}&nbsp;m`, fmt(total), 'complaints'),
    index,
    fig('Most frequent', top(byCat), '', true),
    pctl,
  ], changeNote(total, previous, compare));
  renderBars(byCat);
  $('.detail .note').textContent = 'Counts complaints NYPD placed within 200 m (about 2 blocks); NYPD places them at the nearest intersection or mid-block, and never places rape and sex crimes on the map. Addresses are located from the City\'s street centerline house-number ranges.';
}

/** Whole street: complaints within 30 m of its centerline, as a rate per 100 m of street. */
async function renderStreet(sel, ticket, compare, top, sum) {
  const s = streetById(sel.id);
  const [byCat, prev, busiest] = await Promise.all([
    query(`SELECT cat, sum(n)::INTEGER AS n FROM street_blocks WHERE street = ${sel.id} AND ${where()} GROUP BY 1`),
    compare ? query(`SELECT sum(n)::INTEGER AS n FROM street_blocks WHERE street = ${sel.id} AND ${where(compare.months)}`) : [{ n: 0 }],
    query(`SELECT block, sum(n)::INTEGER AS n FROM street_blocks WHERE street = ${sel.id} AND block >= 0 AND ${where()}
           GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 1`),
    loadCompare(),
  ]);
  if (ticket !== pending) return;
  const total = sum(byCat);
  const months = new Set(monthsOf(state.period));
  let cityN = 0;
  for (const [m, c, n] of cmp.street_city.m_cat_n) if (months.has(m) && state.cats.has(c)) cityN += n;
  const rate = (total / s.length) * 100;
  const cityRate = (cityN / cmp.street_city.length_m) * 100;
  const short = s.length < cmp.short_street_m;
  const fair = fairSeries();
  const rateText = (r) => (r >= 10 ? fmt(r) : r.toFixed(1));
  let pctl;
  if (short) pctl = fig('Percentile', '—', 'streets under 300 m are not ranked');
  else if (fair.why) pctl = fig('Percentile', '—', fair.why);
  else {
    const P = cmp.street[fair.type][fair.series];
    pctl = fig('Percentile', ordinal(shareBelow(P, rate / fair.years)), 'among NYC streets, per 100 m', false,
      'Share of NYC streets 300 m or longer with a lower rate of complaints per 100 m.');
  }
  const ntas = s.nNtas > 3 ? `${s.nNtas} neighborhoods` : s.ntas.map((c) => meta.ntas[c]?.name).filter(Boolean).join(', ');
  renderHeader(s.name, `Street in ${meta.boroughs[s.boro]}, ${fmtLength(s.length)} long${ntas ? `, through ${ntas}` : ''}`);
  const notes = [changeNote(total, prev[0]?.n ?? 0, compare)];
  if (busiest[0]?.n) notes.push(`Busiest block: numbers ${blockLabel(busiest[0].block)} (${fmt(busiest[0].n)})`);
  showFigures([
    fig('Complaints', fmt(total), `${rateText(rate)} per 100 m`),
    cityRate > 0 ? fig('Compared with typical', fmtIndex(rate / cityRate), 'the NYC street average per 100 m', false,
      `Complaints per 100 m of this street ÷ all complaints on NYC streets per 100 m of street (${rateText(cityRate)}).`)
      : fig('Compared with typical', 'n/a'),
    fig('Most frequent', top(byCat), '', true),
    pctl,
  ], notes.filter(Boolean).join('\n'));
  renderBars(byCat);
  $('.detail .note').textContent = 'Complaints within 30 m of the street centerline; at an intersection they count for every street that meets there, also in the NYC average.'
    + (short || total < 20 ? ' This street is short or has few complaints, so each case moves the numbers a lot.' : '');
}

// The map takes an offense group's color when every selected type belongs to that group
// (one type, or a whole group); all types or a mix of groups keep the usual blue.
function selectionGroup() {
  if (!state.cats.size || state.cats.size === meta.categories.length) return null;
  const groups = new Set([...state.cats].map((c) => meta.categories[c].group));
  return groups.size === 1 ? [...groups][0] : null;
}

// ---------- charts: how the selected place changed over time (src/report.js, src/charts.js)
const toSeries = (rows) => {
  const out = new Map();
  for (const r of rows) {
    if (!out.has(r.cat)) out.set(r.cat, new Float64Array(120));
    out.get(r.cat)[r.m] += r.n;
  }
  return out;
};
const cache = new Map();
const cachedQuery = (key, sql) => { if (!cache.has(key)) cache.set(key, query(sql).then(toSeries)); return cache.get(key); };
const catList = (cats) => [...cats].join(',') || '-1';
const yearsOf = (months) => [...new Set(months.map((m) => 2016 + Math.floor(m / 12)))];

function chartColor() {
  const g = selectionGroup();
  const dark = document.documentElement.dataset.theme === 'dark';
  if (g) return dark ? GROUP_COLORS[g] : GROUP_RAMPS[g].light[4];
  return dark ? '#4f9dd6' : '#2468a5';
}

/** Rows {lat, lon, ...} inside a hexagon or a 200 m circle (the SQL box is only a first cut). */
const insideSel = (sel) => (sel.kind === 'hex'
  ? (r) => { const h = hexAt([r.lon, r.lat]); return h.q === sel.q && h.r === sel.r; }
  : (r) => meters(sel.lngLat, [r.lon, r.lat]) <= RADIUS_M);
const boxOf = (sel) => {
  const [lon, lat] = sel.kind === 'hex' ? hexCenter(sel.q, sel.r) : sel.lngLat;
  const m = sel.kind === 'hex' ? meta.grid.side * 1.05 : RADIUS_M;
  return `lat BETWEEN ${lat - degLat(m)} AND ${lat + degLat(m)} AND lon BETWEEN ${lon - degLon(m)} AND ${lon + degLon(m)}`;
};

/** Where the chart data for the current selection comes from. */
async function chartContext(sel) {
  const nycAll = () => cachedQuery('nyc:all', 'SELECT m, cat, sum(n)::INTEGER AS n FROM agg_precinct GROUP BY 1, 2');
  const nycMapped = () => cachedQuery('nyc:mapped', 'SELECT m, cat, sum(n)::INTEGER AS n FROM hex GROUP BY 1, 2');
  const fromAggTime = (kind, ids) => async (months, cats) => {
    const years = yearsOf(months);
    const rows = await query(`SELECT dow, hour, sum(n)::INTEGER AS n FROM agg_time WHERE kind = ${kind} AND id IN (${ids.join(',')})
      AND year IN (${years.join(',')}) AND cat IN (${catList(cats)}) GROUP BY 1, 2`);
    const grid = Array.from({ length: 7 }, () => new Array(24).fill(0));
    for (const r of rows) if (r.dow >= 0 && r.hour >= 0) grid[r.dow][r.hour] += r.n;
    const whole = months.length === years.length * 12;
    return { grid, years: whole ? null : years };
  };
  const fromIncidents = async (months, cats) => {
    const rows = await query(`SELECT lat, lon, dow, hour, count(*)::INTEGER AS n FROM incidents
      WHERE lt = 0 AND ${boxOf(sel)} AND ${monthSql(months)} AND cat IN (${catList(cats)}) GROUP BY ALL`);
    const ok = insideSel(sel);
    const grid = Array.from({ length: 7 }, () => new Array(24).fill(0));
    for (const r of rows) if (ok(r) && r.dow >= 0 && r.hour >= 0) grid[r.dow][r.hour] += r.n;
    return { grid, years: null };
  };
  await loadStreets(loadJson);
  const blockRows = (rows) => rows.map((r) => ({
    key: `${r.street}:${r.block}`, street: r.street, block: r.block, n: r.n, label: `${blockLabel(r.block)} ${streetById(r.street)?.name ?? ''}`.trim(),
    name: streetById(r.street)?.name ?? '', range: blockLabel(r.block),
  }));
  // The busiest 40 blocks; with "only" (the rows of another period), exactly those blocks, so the
  // earlier period is not limited to its own top 40 (which would show real blocks as 0 before).
  const areaBlocks = (from, filter, count = 'sum(p.n)') => async (months, cats, only) => blockRows(await query(`
    SELECT ls.street, ls.block, ${count}::INTEGER AS n FROM ${from} JOIN loc_street ls USING (lat, lon)
    WHERE ${filter} AND ls.block >= 0 AND ${monthSql(months)} AND cat IN (${catList(cats)})
    ${only ? `AND ls.street::BIGINT * 10000000 + ls.block IN (${only.map((b) => b.street * 10_000_000 + b.block).join(',') || -1})` : ''}
    GROUP BY 1, 2 ORDER BY 3 DESC ${only ? '' : 'LIMIT 40'}`));

  switch (sel.kind) {
    case 'city':
      return { name: 'New York City', byCat: nycAll, nycByCat: nycAll, time: fromAggTime(0, [0]), blocks: null };
    case 'borough': {
      const ntas = meta.ntas.filter((n) => n.boro === sel.code).map((n) => n.code);
      return {
        name: meta.boroughs[sel.code], nycByCat: nycAll, time: fromAggTime(1, [sel.code]),
        byCat: () => cachedQuery(`b:${sel.code}`, `SELECT m, cat, sum(n)::INTEGER AS n FROM agg_precinct WHERE boro = ${sel.code} GROUP BY 1, 2`),
        blocks: areaBlocks('points p', `p.nta IN (${ntas.join(',')})`),
        areas: async (months, cats) => (await query(`SELECT nta, sum(n)::INTEGER AS n FROM agg_nta
          WHERE nta IN (${ntas.join(',')}) AND ${monthSql(months)} AND cat IN (${catList(cats)}) GROUP BY 1`))
          .map((r) => ({ key: r.nta, label: meta.ntas[r.nta].name, n: r.n, residential: meta.ntas[r.nta].type === 'residential' })),
      };
    }
    case 'precinct': {
      const pcts = sel.props.merged ?? [sel.props.pct];
      return {
        name: precinctName(sel.props), nycByCat: nycAll, time: fromAggTime(2, pcts),
        byCat: () => cachedQuery(`p:${pcts}`, `SELECT m, cat, sum(n)::INTEGER AS n FROM agg_precinct WHERE pct IN (${pcts.join(',')}) GROUP BY 1, 2`),
        blocks: areaBlocks('incidents p', `p.pct IN (${pcts.join(',')}) AND p.lt = 0`, 'count(*)'),
      };
    }
    case 'nta':
      return {
        name: meta.ntas[sel.code].name, nycByCat: nycMapped, time: fromAggTime(3, [sel.code]),
        byCat: () => cachedQuery(`n:${sel.code}`, `SELECT m, cat, sum(n)::INTEGER AS n FROM agg_nta WHERE nta = ${sel.code} GROUP BY 1, 2`),
        blocks: areaBlocks('points p', `p.nta = ${sel.code}`),
      };
    case 'street': {
      const s = streetById(sel.id);
      return {
        name: s.name, nycByCat: nycMapped, time: fromAggTime(4, [sel.id]),
        byCat: () => cachedQuery(`s:${sel.id}`, `SELECT m, cat, sum(n)::INTEGER AS n FROM street_blocks WHERE street = ${sel.id} GROUP BY 1, 2`),
        blocks: async (months, cats) => (await query(`SELECT block, sum(n)::INTEGER AS n FROM street_blocks
          WHERE street = ${sel.id} AND block >= 0 AND ${monthSql(months)} AND cat IN (${catList(cats)}) GROUP BY 1`))
          .map((r) => ({ key: r.block, street: sel.id, block: r.block, n: r.n, order: r.block, label: blockLabel(r.block),
            short: r.block >= 1_000_000 ? `${Math.floor((r.block - 1_000_000) / 1000)}-` : String(r.block) })),
      };
    }
    case 'hex':
    case 'point': {
      const ok = insideSel(sel);
      const byCat = async () => {
        const rows = await query(`SELECT lat, lon, m, cat, sum(n)::INTEGER AS n FROM points WHERE ${boxOf(sel)} GROUP BY ALL`);
        return toSeries(rows.filter(ok));
      };
      const blocks = sel.kind === 'point' ? null : async (months, cats) => {
        const rows = await query(`SELECT p.lat, p.lon, ls.street, ls.block, sum(p.n)::INTEGER AS n FROM points p
          JOIN loc_street ls USING (lat, lon) WHERE ${boxOf(sel).replaceAll('lat', 'p.lat').replaceAll('lon', 'p.lon')}
          AND ls.block >= 0 AND ${monthSql(months)} AND cat IN (${catList(cats)}) GROUP BY ALL`);
        const agg = new Map();
        for (const r of rows.filter(ok)) {
          const k = `${r.street}:${r.block}`;
          agg.set(k, { street: r.street, block: r.block, n: (agg.get(k)?.n ?? 0) + r.n });
        }
        return blockRows([...agg.values()].sort((a, b) => b.n - a.n));
      };
      return { name: sel.label ?? 'Hexagon', byCat, nycByCat: nycMapped, time: fromIncidents, blocks };
    }
    default:
      return null;
  }
}

function setPanelView(view) {
  state.panelView = view;
  $('.details-view').hidden = view !== 'details';
  $('.charts-view').hidden = view !== 'charts';
  $('.detail').classList.toggle('charts-mode', view === 'charts');
  $('.charts-back').setAttribute('aria-selected', String(view === 'details'));
  $('.charts-open').setAttribute('aria-selected', String(view === 'charts'));
}

let chartDraws = [];
async function renderCharts(ticket) {
  if (state.panelView !== 'charts' || !state.selected) return;
  const list = $('.charts-list');
  if (!list.children.length) list.innerHTML = '<p class="charts-loading">Loading charts</p>';
  const src = await chartContext(state.selected);
  if (!src || ticket !== pending) return;
  const compare = comparisonOf(state.period);
  const report = await buildReport({
    ...src, kind: state.selected.kind, period: state.period, months: monthsOf(state.period),
    prevMonths: compare?.months ?? null, prevLabel: compare?.label ?? '', periodLabel: periodLabel(),
    cats: state.cats, categories: meta.categories, color: chartColor(), highlightBlock, clearHighlight,
    highlightArea, selectArea: (code) => selectNta(code, { move: true }), selectBlock,
  });
  if (ticket !== pending) return;
  list.innerHTML = '';
  chartDraws = [];
  for (const s of report.sections) {
    const card = document.createElement('section');
    card.className = 'chart-card';
    const legend = (s.legend ?? []).map(([cls, label]) => `<span class="key ${cls}"><i style="--c:${chartColor()}"></i>${label}</span>`).join('');
    card.innerHTML = `<h3>${s.title}</h3><p class="answer">${s.answer}</p>${legend ? `<div class="chart-legend">${legend}</div>` : ''}
      <div class="chart-host"></div>${s.note ? `<p class="chart-note">${s.note}</p>` : ''}`;
    list.append(card);
    const host = card.querySelector('.chart-host');
    const draw = () => s.draw(host);
    draw();
    chartDraws.push(draw);
  }
  $('.charts-hidden').innerHTML = report.hidden.length
    ? `<strong>Not shown</strong> ${report.hidden.map((h) => `${h.title}: ${h.why}.`).join(' ')}` : '';
}

// ---------- refresh everything for the current filters
let pending = 0;
async function refresh() {
  const ticket = ++pending;
  const compare = comparisonOf(state.period);
  const [hex, byLt, byCat, previous, byPct] = await Promise.all([
    query(`SELECT q, r, sum(n)::INTEGER AS n FROM hex WHERE ${where()} GROUP BY 1, 2`),
    query(`SELECT lt, sum(n)::INTEGER AS n FROM agg_precinct WHERE ${where()} GROUP BY 1`),
    query(`SELECT cat, sum(n)::INTEGER AS n FROM agg_precinct WHERE ${where()} GROUP BY 1`),
    compare
      ? query(`SELECT sum(n)::INTEGER AS n FROM agg_precinct WHERE ${where(compare.months)}`)
      : Promise.resolve([{ n: 0 }]),
    precinctGeo ? query(`SELECT pct, sum(n)::INTEGER AS n FROM agg_precinct WHERE ${where()} GROUP BY 1`) : [],
  ]);
  if (ticket !== pending) return;      // a newer refresh started; drop this one
  setTint(selectionGroup());                      // before both layers, so they change color together
  if (precinctGeo) setPrecincts(new Map(byPct.map((r) => [r.pct, r.n])), precinctMerged());

  const lt = Object.fromEntries(byLt.map((r) => [r.lt, r.n]));
  const total = (lt[0] ?? 0) + (lt[1] ?? 0) + (lt[2] ?? 0);
  setHexagons(hex, periodLabel());
  const panel = $('.detail');
  if (state.selected?.kind === 'city') {
    renderHeader('New York City', `All five boroughs, ${fmt(meta.totals.population_2020)} residents`);
    renderCity({ total, precinctOnly: lt[1] ?? 0, previous: previous[0]?.n, compare, days: daysOf(monthsOf(state.period)) });
    renderBars(byCat);
    $('.detail .note').textContent = CITY_NOTE;
  } else if (state.selected) {
    await renderSelection(ticket);
  }
  if (ticket !== pending) return;
  await renderCharts(ticket);
  if (ticket !== pending) return;
  if (panel.hidden !== !state.selected) {          // opening: always start expanded
    panel.hidden = !state.selected;
    if (state.selected) panel.querySelector('.block-toggle').expand();
  }
  const noPrecinct = byPct.find((r) => r.pct < 0)?.n ?? 0;
  renderSummary({ total, precinctOnly: lt[1] ?? 0, none: lt[2] ?? 0, noPrecinct });
  renderNotice(state.view === 'precincts' ? { drawable: total, total } : { drawable: lt[0] ?? 0, total });
  document.body.dataset.ready = 'true';
}

// When the selection has nothing to draw, say why instead of showing an empty map.
function renderNotice({ drawable, total }) {
  const el = $('.map-notice');
  if (drawable > 0) { el.hidden = true; return; }
  const withheld = [...state.cats].filter((c) => state.notMapped.has(c)).map((c) => meta.categories[c].label);
  if (total > 0 && withheld.length) {
    el.innerHTML = `<strong>${withheld.join(', ')}: not shown on the map</strong>
      <p>NYPD does not publish where these offenses happened, to protect victims. Each one is placed at the
      precinct station house, so we count them in the totals on the right but do not draw them.</p>`;
  } else if (total > 0) {
    el.innerHTML = '<strong>Nothing to draw for this selection</strong><p>These complaints have no location in the data. They are counted in the totals on the right.</p>';
  } else {
    el.innerHTML = '<strong>No complaints for this selection</strong><p>Try another period or more offense types.</p>';
  }
  el.hidden = false;
}

// ---------- view switch (3D hexagons / Precincts), in the legend block
function setupViewSwitch() {
  const buttons = document.querySelectorAll('.view-switch button');
  const sync = () => buttons.forEach((b) => b.setAttribute('aria-checked', String(state.view === b.dataset.view)));
  buttons.forEach((b) => b.addEventListener('click', async () => {
    if (state.view === b.dataset.view) return;
    state.view = b.dataset.view;
    sync();
    savePref('view', state.view);
    document.body.dataset.view = state.view;
    if (state.view === 'precincts') {
      await ensurePrecincts();
      await refresh();                            // fills the precincts before they fade in
    }
    setView(state.view);
    if (state.view === 'hex') refresh();
  }));
  sync();
}

// ---------- theme switch (Night / Light), bottom left
function setupThemeSwitch() {
  const buttons = document.querySelectorAll('.theme-switch button');
  const sync = () => buttons.forEach((b) =>
    b.setAttribute('aria-checked', String(document.documentElement.dataset.theme === b.dataset.value)));
  buttons.forEach((b) => (b.onclick = () => {
    if (document.documentElement.dataset.theme === b.dataset.value) return;
    document.documentElement.dataset.theme = b.dataset.value;
    savePref('theme', b.dataset.value);
    sync();
    setTheme(b.dataset.value);
  }));
  sync();
}

// Complaint locations for the zoomed-in view: one row per snapped location, with its count and
// its most frequent category (which sets the dot color).
function loadPoints([west, south, east, north]) {
  return query(`
    WITH t AS (
      SELECT lat, lon, cat, sum(n) AS n FROM points
      WHERE ${where()} AND lat BETWEEN ${south} AND ${north} AND lon BETWEEN ${west} AND ${east}
      GROUP BY ALL)
    SELECT lat, lon, sum(n)::INTEGER AS n, arg_max(cat, n) AS cat FROM t GROUP BY lat, lon
    LIMIT 250000`);
}

async function main() {
  const params = new URLSearchParams(location.search);
  const theme = params.get('theme') ?? pref('theme', matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  document.documentElement.dataset.theme = theme;
  setupThemeSwitch();
  setupBlocks();
  state.view = params.get('view') ?? pref('view', 'hex');
  if (!['hex', 'precincts'].includes(state.view)) state.view = 'hex';
  document.body.dataset.view = state.view;
  setupViewSwitch();
  renderPeriod();

  const [m, g] = await Promise.all([loadJson('meta.json'), loadJson('nta.geojson'), initDb()]);
  meta = m;
  ntaGeo = g;
  $('.detail .close').onclick = clearSelection;
  $('.charts-open').onclick = () => { setPanelView('charts'); $('.detail-body').scrollTop = 0; renderCharts(pending); };
  $('.charts-back').onclick = () => setPanelView('details');
  // Tabs: arrow keys move between "Details" and "Over time" (WAI-ARIA tabs pattern)
  $('.tabs').addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const next = state.panelView === 'charts' ? $('.charts-back') : $('.charts-open');
    next.click(); next.focus(); e.preventDefault();
  });
  $('.detail .expand').onclick = (e) => {
    state.wide = !state.wide;
    e.currentTarget.setAttribute('aria-pressed', String(state.wide));
    e.currentTarget.setAttribute('aria-label', state.wide ? 'Narrow panel' : 'Expand panel');
    e.currentTarget.title = state.wide ? 'Narrow panel' : 'Expand panel';
    $('.detail').classList.toggle('wide', state.wide);
  };
  let redraw;
  new ResizeObserver(() => { clearTimeout(redraw); redraw = setTimeout(() => chartDraws.forEach((d) => d()), 60); }).observe($('.charts-list'));
  $('#city-total').onclick = () => (state.selected?.kind === 'city' ? clearSelection() : selectCity());
  $('.detail .updated').textContent = updatedLabel();
  const pctBoro = await query(`SELECT pct, arg_max(boro, n) AS boro FROM
    (SELECT pct, boro, sum(n) AS n FROM agg_precinct WHERE pct > 0 GROUP BY 1, 2) GROUP BY 1 ORDER BY 1`);
  const places = [
    ...[1, 3, 4, 2, 5].map((code) => ({ type: 'area', level: 'borough', group: 'borough', code, boro: code, label: meta.boroughs[code], detail: 'Borough' })),
    ...meta.ntas.map((n) => ({
      type: 'area', level: 'nta', code: n.code, boro: n.boro, label: n.name, boroName: meta.boroughs[n.boro],
      group: n.type === 'residential' ? 'nta' : n.type === 'park' ? 'park' : 'place',
      detail: `${n.type === 'residential' ? 'Neighborhood' : n.type === 'park' ? 'Park' : 'Place'} in ${meta.boroughs[n.boro]}`,
    })),
    ...pctBoro.map((p) => ({ type: 'area', level: 'precinct', group: 'precinct', code: p.pct, boro: p.boro, boroName: meta.boroughs[p.boro],
      label: precinctName({ pct: p.pct }), detail: `Precinct in ${meta.boroughs[p.boro]}` })),
  ];
  const searchDeps = {
    query, places,
    ready: () => loadStreets(loadJson),
    ntaName: (code) => meta.ntas[code]?.name,
    ntaAt: (lngLat) => featureAt(ntaGeo, lngLat)?.properties.name,
    boroName: (code) => meta.boroughs[code],
  };
  setupSearch($('#search'), $('#search-results'), searchDeps, (it) => {
    if (it.type === 'point') return selectPoint(it.lngLat, it.label, it.kind === 'corner');
    if (it.type === 'street') return selectStreet(it.id);
    if (it.level === 'borough') return selectBorough(it.code);
    if (it.level === 'precinct') return selectPrecinctNumber(it.code);
    return selectNta(it.code, { move: true });
  }, () => { loadStreets(loadJson); loadCompare(); });
  addEventListener('keydown', (e) => { if (e.key === 'Escape' && state.selected) clearSelection(); });
  state.cats = new Set(meta.categories.map((c) => c.code));
  const [cells, drawn] = await Promise.all([
    query('SELECT DISTINCT q, r FROM hex ORDER BY q, r'),
    query('SELECT cat, sum(n) FILTER (WHERE lt = 0)::INTEGER AS drawn FROM agg_precinct GROUP BY cat'),
  ]);
  state.notMapped = new Set(drawn.filter((d) => !d.drawn).map((d) => d.cat));
  renderCategories();
  setupCategoryActions();
  if (state.view === 'precincts') await ensurePrecincts();
  const map = await createMap($('#map'), {
    view: state.view,
    theme,
    grid: meta.grid,
    categories: meta.categories,
    hooks: { onLegend: renderLegend, loadPoints, onPick },
  });
  setUniverse(cells);
  // The details panel ends above the zoom buttons and credits, whatever their size.
  const brControls = document.querySelector('.maplibregl-ctrl-bottom-right');
  const fitPanel = () => document.documentElement.style.setProperty('--controls-br', `${brControls.offsetHeight + 16}px`);
  new ResizeObserver(fitPanel).observe(brControls);
  fitPanel();
  if (params.has('db')) {                        // test mode only: hooks for headless tests
    window.__nycmap = map;
    window.__hexStats = hexStats;
    window.__select = { city: selectCity, precinct: (pct) => (precinctGeo ? selectPrecinct(precinctUnit(pct)) : selectPrecinctNumber(pct)), borough: selectBorough, nta: selectNta, hex: selectHex, point: selectPoint, street: selectStreet, clear: clearSelection };
  }
  await refresh();
}

main().catch((err) => {
  console.error(err);
  $('#city-total').textContent = `Could not load the data: ${err.message}`;
});
