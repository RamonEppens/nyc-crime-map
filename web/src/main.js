// Entry point: state, queries and wiring between filters, map and summary panel.
import './styles.css';
import { initDb, query, loadJson } from './db.js';
import { createMap, setTheme, setHexagons, setUniverse, hexStats } from './map.js';
import { GROUP_COLORS, GROUP_LABELS } from './colors.js';
import { fmt, fmtCompact, fmtChange } from './format.js';
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
  showAllBars: false,
};
let meta;

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
function renderLegend(ramp, breaks) {
  $('.legend-ramp').innerHTML = ramp.map((c) => `<span style="background:${c}"></span>`).join('');
  const labels = ['', ...breaks.map((b) => `>${fmtCompact(b)}`)];
  $('.legend-labels').innerHTML = labels.map((l) => `<span>${l}</span>`).join('');
}

function renderFigures({ total, precinctOnly, previous, compare, days }) {
  const change = compare && previous ? ((total - previous) / previous) * 100 : NaN;
  const figures = [
    [fmt(total), 'complaints'],
    [fmt(total / days), 'per day'],
    compare && previous
      ? [fmtChange(change), compare.label, true]
      : [fmt(precinctOnly), 'location withheld', true],
    [fmt(total / (meta.totals.population_2020 / 1000)), 'per 1,000 residents'],
  ];
  $('.figures').innerHTML = figures.map(([v, l, neutral]) =>
    `<div class="figure"><div class="value${neutral ? ' neutral' : ''}">${v}</div><div class="label">${l}</div></div>`).join('');
}

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

function renderStatus({ drawable, precinctOnly, none }) {
  const updated = new Date(meta.source.rows_updated_at).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
  $('.status').innerHTML = `<span>${fmt(drawable)} on the map · ${fmt(precinctOnly)} by precinct only`
    + `${none ? ` · ${fmt(none)} without location` : ''} · Data as of ${updated}</span>`;
}

// ---------- refresh everything for the current filters
let pending = 0;
async function refresh() {
  const ticket = ++pending;
  const compare = comparisonOf(state.period);
  const [hex, byLt, byCat, previous] = await Promise.all([
    query(`SELECT q, r, sum(n)::INTEGER AS n FROM hex WHERE ${where()} GROUP BY 1, 2`),
    query(`SELECT lt, sum(n)::INTEGER AS n FROM agg_precinct WHERE ${where()} GROUP BY 1`),
    query(`SELECT cat, sum(n)::INTEGER AS n FROM agg_precinct WHERE ${where()} GROUP BY 1`),
    compare
      ? query(`SELECT sum(n)::INTEGER AS n FROM agg_precinct WHERE ${where(compare.months)}`)
      : Promise.resolve([{ n: 0 }]),
  ]);
  if (ticket !== pending) return;      // a newer refresh started; drop this one

  const lt = Object.fromEntries(byLt.map((r) => [r.lt, r.n]));
  const total = (lt[0] ?? 0) + (lt[1] ?? 0) + (lt[2] ?? 0);
  setHexagons(hex, periodLabel());
  renderFigures({ total, precinctOnly: lt[1] ?? 0, previous: previous[0]?.n, compare, days: daysOf(monthsOf(state.period)) });
  renderBars(byCat);
  const n = state.cats.size;
  const all = meta.categories.length;
  $('.detail .sub').textContent = `${periodLabel()} · ${n === all ? 'all offenses' : `${n} of ${all} offense types`}`;
  renderStatus({ drawable: lt[0] ?? 0, precinctOnly: lt[1] ?? 0, none: lt[2] ?? 0 });
  renderNotice({ drawable: lt[0] ?? 0, total });
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
  renderPeriod();

  const [m] = await Promise.all([loadJson('meta.json'), initDb()]);
  meta = m;
  state.cats = new Set(meta.categories.map((c) => c.code));
  const [cells, drawn] = await Promise.all([
    query('SELECT DISTINCT q, r FROM hex ORDER BY q, r'),
    query('SELECT cat, sum(n) FILTER (WHERE lt = 0)::INTEGER AS drawn FROM agg_precinct GROUP BY cat'),
  ]);
  state.notMapped = new Set(drawn.filter((d) => !d.drawn).map((d) => d.cat));
  renderCategories();
  setupCategoryActions();
  const map = await createMap($('#map'), {
    theme,
    grid: meta.grid,
    categories: meta.categories,
    hooks: { onLegend: renderLegend, loadPoints },
  });
  setUniverse(cells);
  if (params.has('db')) {                        // test mode only: hooks for headless tests
    window.__nycmap = map;
    window.__hexStats = hexStats;
  }
  await refresh();
}

main().catch((err) => {
  console.error(err);
  $('.status').innerHTML = `<span>Could not load the data: ${err.message}</span>`;
});
