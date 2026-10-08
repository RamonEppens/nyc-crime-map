// Entry point: state, queries and wiring between filters, map and summary panel.
import './styles.css';
import { initDb, query, loadJson } from './db.js';
import {
  createMap, setTheme, setHexagons, setUniverse, hexStats, setSelection, showBounds,
  setView, setPrecinctShapes, setPrecincts, precinctUnit, precinctName,
} from './map.js';
import { hexAt, hexCenter, hexPolygon, featureAt, meters, circlePolygon, bounds, degLat, degLon } from './geo.js';
import { setupSearch } from './search.js';
import { GROUP_COLORS, GROUP_LABELS } from './colors.js';
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
    const key = `block:${btn.closest('.block').dataset.block}`;
    const apply = (open) => {
      btn.setAttribute('aria-expanded', String(open));
      btn.textContent = open ? 'Hide' : 'Show';
      body.hidden = !open;
    };
    apply(pref(key, 'open') === 'open');
    btn.onclick = () => {
      const open = btn.getAttribute('aria-expanded') !== 'true';
      apply(open);
      savePref(key, open ? 'open' : 'closed');
    };
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
  for (const g of Object.keys(GROUP_LABELS)) {
    const head = document.createElement('div');
    head.className = 'cat-group';
    head.textContent = GROUP_LABELS[g];
    grid.append(head);
    meta.categories.filter((c) => c.group === g).forEach((c, i) => {
      const cell = document.createElement('div');
      cell.className = 'cat';
      if (i % 2 === 0) cell.style.borderRight = '1px solid var(--line)';
      const on = state.cats.has(c.code);
      const tip = state.notMapped.has(c.code) ? `${c.label}: location withheld by NYPD, counted in totals but not drawn` : c.label;
      cell.innerHTML = `<button class="cat-toggle" data-code="${c.code}" aria-pressed="${on}" title="${tip}">
          <span class="dot" style="background:${GROUP_COLORS[g]}"></span><span class="name">${c.label}</span>${state.notMapped.has(c.code) ? '<span class="mark" aria-hidden="true">†</span>' : ''}</button>
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
      grid.append(cell);
    });
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
    ? 'Each color holds about a sixth of the precincts. Includes rape and sex crimes.'
    : 'Each color holds about a sixth of the hexagons in view.';
  $('.legend-ramp').innerHTML = ramp.map((c) => `<span style="background:${c}"></span>`).join('');
  const labels = ['', ...breaks.map((b) => `>${fmtShort(b)}`)];
  $('.legend-labels').innerHTML = labels.map((l) => `<span>${l}</span>`).join('');
}

function renderFigures({ total, precinctOnly, previous, compare, days }) {
  const change = compare && previous ? ((total - previous) / previous) * 100 : NaN;
  showFigures([
    [fmt(total), 'complaints'],
    [fmt(total / days), 'per day'],
    compare && previous
      ? [fmtChange(change), compare.label, true]
      : [fmt(precinctOnly), 'location withheld', true],
    [fmt(total / (meta.totals.population_2020 / 1000)), 'per 1,000 residents'],
  ]);
}

/** figures: [[value, label, neutral?, small?], ...] */
function showFigures(figures, note = '') {
  $('.figures').innerHTML = figures.map(([v, l, neutral, small]) =>
    `<div class="figure"><div class="value${neutral ? ' neutral' : ''}${small ? ' small' : ''}">${v}</div><div class="label">${l}</div></div>`).join('');
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
  $('.bars').innerHTML = shown.map(({ label, n }) => {
    const w = (n / max) * 100;
    const outside = w < 22;
    return `<div class="bar"><span class="name">${label}</span>
      <div class="track"><div class="fill${outside ? ' outside' : ''}" style="width:${w}%;--w:${w}%">
      <span>${fmtCompact(n)}</span></div></div></div>`;
  }).join('');
  const more = $('.more');
  more.hidden = items.length <= 8;
  more.textContent = state.showAllBars ? 'Show fewer' : `Show all ${items.length}`;
  more.onclick = () => { state.showAllBars = !state.showAllBars; renderBars(rows); };
}

function renderStatus({ drawable, precinctOnly, none, byPrecinct, noPrecinct }) {
  const updated = new Date(meta.source.rows_updated_at).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
  if (byPrecinct !== undefined) {
    $('.status').innerHTML = `<span>${fmt(byPrecinct)} by precinct${noPrecinct ? ` · ${fmt(noPrecinct)} without precinct` : ''} · Data as of ${updated}</span>`;
    return;
  }
  $('.status').innerHTML = `<span>${fmt(drawable)} on the map · ${fmt(precinctOnly)} by precinct only`
    + `${none ? ` · ${fmt(none)} without location` : ''} · Data as of ${updated}</span>`;
}

// ---------- selection: a neighborhood (NTA) or a hexagon, shown in the right panel
const CITY_NOTE = 'Counts are complaints reported to the NYPD. They are not arrests or convictions, and they do not measure risk.';
const filterLabel = () => {
  const n = state.cats.size;
  const all = meta.categories.length;
  return `${periodLabel()} · ${n === all ? 'all offenses' : `${n} of ${all} offense types`}`;
};

function renderHeader(title, context) {
  $('.detail h2').textContent = title;
  $('.detail .sub').textContent = filterLabel();
  const back = $('.detail .back');
  back.hidden = !state.selected;
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
  setSelection(feature);
  if (move) showBounds(bounds(feature));
  refresh();
}
// Borough outlines are only needed once someone picks a borough, so they load on demand.
let boroughGeo;
async function selectBorough(code) {
  state.selected = { kind: 'borough', code };
  boroughGeo ??= await loadJson('boroughs.geojson');
  if (state.selected?.kind !== 'borough' || state.selected.code !== code) return;   // picked something else meanwhile
  const feature = boroughGeo.features.find((f) => f.properties.boro === code);
  setSelection(feature);
  showBounds(bounds(feature));
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
function selectPrecinct(props) {
  state.selected = { kind: 'precinct', props };
  setSelection(precinctGeo.features.find((f) => f.properties === props || (f.properties.pct === props.pct && !props.merged)));
  refresh();
}

function selectHex(q, r) {
  state.selected = { kind: 'hex', q, r };
  setSelection(hexPolygon(q, r));
  refresh();
}
const RADIUS_M = 200;
function selectAddress(lngLat, label) {
  state.selected = { kind: 'address', lngLat, label };
  const circle = circlePolygon(lngLat, RADIUS_M);
  setSelection(circle);
  showBounds(bounds(circlePolygon(lngLat, RADIUS_M * 3)));
  refresh();
}
function clearSelection() {
  state.selected = null;
  $('#search').value = '';
  $('.search-clear').hidden = true;
  setSelection(null);
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
    renderHeader(info.name, `<button class="link" data-boro="${info.boro}">${meta.boroughs[info.boro]}</button> · neighborhood (2020 NTA) · ${info.population ? `${fmt(info.population)} residents` : 'no resident population'}`);
    showFigures([
      [fmt(total), 'complaints'],
      residential ? [`${(rate / cityRate).toFixed(1)}×`, 'the city rate per resident', true] : ['n/a', 'few or no residents', true],
      [top(byCat), 'most frequent', true, true],
      residential ? [ordinal(percentileOf(rates, rate)), 'percentile among neighborhoods', true] : ['n/a', 'not ranked', true],
    ], changeNote(total, prev[0]?.n ?? 0, compare));
    renderBars(byCat);
    $('.detail .note').textContent = 'Neighborhood counts include only complaints with a map location. Rape, sex crimes and others NYPD places at station houses are counted citywide and by precinct.';
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
    renderHeader(meta.boroughs[sel.code], `Borough · ${fmt(population)} residents (2020 Census)`);
    showFigures([
      [fmt(total), 'complaints'],
      [fmt(rate * 1000), 'per 1,000 residents'],
      cityRate ? [`${(rate / cityRate).toFixed(1)}×`, 'the city rate per resident', true] : ['n/a', 'no comparison', true],
      [top(byCat), 'most frequent', true, true],
    ], changeNote(total, prev[0]?.n ?? 0, compare));
    renderBars(byCat);
    $('.detail .note').textContent = 'Borough counts include every complaint, also rape and sex crimes, which NYPD places only at the precinct station house.';
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
    const rank = 1 + [...units.values()].filter((n) => n > total).length;
    renderHeader(precinctName(sel.props), `${meta.boroughs[boro[0]?.boro] ?? 'New York City'} · NYPD precinct${sel.props.merged ? 's, shown together: the 116th was created from the 105th and 113th in December 2024' : ''}`);
    showFigures([
      [fmt(total), 'complaints'],
      [fmt(total / daysOf(monthsOf(state.period))), 'per day', true],
      [ordinal(rank), `most complaints of ${units.size} precincts`, true],
      [top(byCat), 'most frequent', true, true],
    ], changeNote(total, prev[0]?.n ?? 0, compare));
    renderBars(byCat);
    $('.detail .note').textContent = 'Precinct counts use NYPD\'s precinct field and include every complaint, also rape and sex crimes. Precincts differ a lot in size, population and visitors, so compare them with care.';
  } else if (sel.kind === 'address') {
    await renderAddress(sel, ticket, compare, top, sum);
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
      ? `About 8 blocks, 180 m per side · in <button class="link" data-nta="${nta.properties.code}">${nta.properties.name}</button>`
      : 'About 8 blocks, 180 m per side');
    showFigures([
      [fmt(total), 'complaints'],
      median ? [`${(total / median).toFixed(1)}×`, 'the median hexagon', true] : ['n/a', 'no comparison', true],
      [top(byCat), 'most frequent', true, true],
      [ordinal(percentileOf(values, total)), 'percentile among hexagons', true],
    ], changeNote(total, prev[0]?.n ?? 0, compare));
    renderBars(byCat);
    $('.detail .note').textContent = 'NYPD places each complaint at the nearest intersection or mid-block, so a hexagon counts the complaints snapped inside it. Rape and sex crimes are never placed on the map.';
  }
}

/**
 * Address: complaints within 200 m, compared with every 200 m area of its neighborhood
 * (circles centered every 100 m inside the neighborhood), like the Buenos Aires map.
 */
async function renderAddress(sel, ticket, compare, top, sum) {
  const [lon, lat] = sel.lngLat;
  const nta = featureAt(ntaGeo, sel.lngLat);
  const box = (m) => `lat BETWEEN ${lat - degLat(m)} AND ${lat + degLat(m)} AND lon BETWEEN ${lon - degLon(m)} AND ${lon + degLon(m)}`;
  const near = (rows) => rows.filter((p) => meters(sel.lngLat, [p.lon, p.lat]) <= RADIUS_M);
  const code = nta?.properties.code;
  const [byLocCat, prevLoc, ntaLocs] = await Promise.all([
    query(`SELECT lat, lon, cat, sum(n)::INTEGER AS n FROM points WHERE ${box(RADIUS_M)} AND ${where()} GROUP BY ALL`),
    compare ? query(`SELECT lat, lon, sum(n)::INTEGER AS n FROM points WHERE ${box(RADIUS_M)} AND ${where(compare.months)} GROUP BY ALL`) : [],
    code !== undefined
      ? query(`SELECT lat, lon, sum(n)::INTEGER AS n FROM points WHERE nta = ${code} AND ${where()} GROUP BY ALL`)
      : [],
  ]);
  if (ticket !== pending) return;
  const inside = near(byLocCat);
  const byCatMap = new Map();
  for (const p of inside) byCatMap.set(p.cat, (byCatMap.get(p.cat) ?? 0) + p.n);
  const byCat = [...byCatMap].map(([cat, n]) => ({ cat, n }));
  const total = sum(byCat);
  const previous = compare ? sum(near(prevLoc)) : null;

  // Distribution of 200 m areas across the neighborhood.
  let areas = [];
  if (nta) {
    const [[w, s], [e, n]] = bounds(nta);
    for (let y = s; y <= n; y += degLat(100)) {
      for (let x = w; x <= e; x += degLon(100)) {
        if (!featureAt({ features: [nta] }, [x, y])) continue;
        let c = 0;
        for (const p of ntaLocs) if (meters([x, y], [p.lon, p.lat]) <= RADIUS_M) c += p.n;
        areas.push(c);
      }
    }
  }
  areas.sort((a, b) => a - b);
  const median = areas.length ? areas[Math.floor(areas.length / 2)] : 0;
  const ntaName = nta?.properties.name;
  renderHeader(sel.label, `Within ${RADIUS_M}&nbsp;m, about 2 blocks${ntaName ? ` · in <button class="link" data-nta="${code}">${ntaName}</button>` : ''}`);
  showFigures([
    [fmt(total), `complaints within ${RADIUS_M}&nbsp;m`],
    median ? [`${(total / median).toFixed(1)}×`, `the typical ${RADIUS_M}&nbsp;m area in ${ntaName}`, true] : ['n/a', 'no comparison', true],
    [top(byCat), 'most frequent', true, true],
    areas.length ? [ordinal(percentileOf(areas, total)), `percentile among ${fmt(areas.length)} areas in this neighborhood`, true] : ['n/a', 'not ranked', true],
  ], changeNote(total, previous, compare));
  renderBars(byCat);
  $('.detail .note').textContent = 'Counts only complaints with a map location; NYPD places them at the nearest intersection or mid-block. Rape and sex crimes are never placed on the map.';
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
  if (precinctGeo) setPrecincts(new Map(byPct.map((r) => [r.pct, r.n])), precinctMerged());

  const lt = Object.fromEntries(byLt.map((r) => [r.lt, r.n]));
  const total = (lt[0] ?? 0) + (lt[1] ?? 0) + (lt[2] ?? 0);
  setHexagons(hex, periodLabel());
  if (state.selected) {
    await renderSelection(ticket);
  } else {
    renderHeader('New York City', null);
    renderFigures({ total, precinctOnly: lt[1] ?? 0, previous: previous[0]?.n, compare, days: daysOf(monthsOf(state.period)) });
    renderBars(byCat);
    $('.detail .note').textContent = CITY_NOTE;
  }
  if (ticket !== pending) return;
  if (state.view === 'precincts') {
    const noPct = byPct.find((r) => r.pct < 0)?.n ?? 0;
    renderStatus({ byPrecinct: total - noPct, noPrecinct: noPct });
    renderNotice({ drawable: total, total });       // every complaint with a precinct is drawn
  } else {
    renderStatus({ drawable: lt[0] ?? 0, precinctOnly: lt[1] ?? 0, none: lt[2] ?? 0 });
    renderNotice({ drawable: lt[0] ?? 0, total });
  }
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
  $('.detail .back').onclick = clearSelection;
  const places = [
    ...[1, 3, 4, 2, 5].map((code) => ({ kind: 'borough', code, label: meta.boroughs[code], detail: 'Borough' })),
    ...meta.ntas.map((n) => ({ kind: 'nta', code: n.code, label: n.name, detail: `Neighborhood · ${meta.boroughs[n.boro]}` })),
  ];
  setupSearch($('#search'), $('#search-results'), places, (choice) => {
    if (choice.kind === 'borough') return selectBorough(choice.code);
    if (choice.kind === 'nta') return selectNta(choice.code, { move: true });
    return selectAddress(choice.lngLat, choice.label);
  });
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
  if (params.has('db')) {                        // test mode only: hooks for headless tests
    window.__nycmap = map;
    window.__hexStats = hexStats;
    window.__select = { precinct: (pct) => selectPrecinct(precinctUnit(pct)), borough: selectBorough, nta: selectNta, hex: selectHex, address: selectAddress, clear: clearSelection };
  }
  await refresh();
}

main().catch((err) => {
  console.error(err);
  $('.status').innerHTML = `<span>Could not load the data: ${err.message}</span>`;
});
