// Entry point: state, queries and wiring between filters, map and summary panel.
import './styles.css';
import { initDb, query, loadJson, loadText, warmRemote, loadStartCache, whenEngineReady } from './db.js';
import * as db from './db.js';
import {
  createMap, setTheme, setHexagons, setUniverse, hexStats, setSelection, showBounds,
  setView, setPrecinctShapes, setPrecincts, precinctUnit, precinctName, setTint, setBoroughShapes, setBoroughs, setUnit2d,
  setPin, flyToPoint, fitTo, setHighlight, followTo, followEnd, setMask, setTilt, addMapButton, FEW_RESIDENTS,
} from './map.js';
import { hexAt, hexCenter, hexPolygon, featureAt, meters, circlePolygon, bounds, degLat, degLon } from './geo.js';
import { setupSearch, loadStreets, streetById } from './search.js';
import { GROUP_COLORS, GROUP_LABELS, RAMPS } from './colors.js';
import { buildReport } from './report.js';
import { fmt, fmtShort, tnum } from './format.js';
import {
  MONTH_NAMES, FIRST_YEAR, LAST_YEAR, N_MONTHS, defaultPeriod, monthsOf, monthSql, labelOf,
  daysOf, comparisonOf, baselineOf, mIndex, yearOf, monthOf, spanOf, periodFromSpan, PRESETS,
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
let keyHelp = null;

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

// ---------- dates: preset chips, a month strip (drag, or arrow keys), custom month pickers
function option(value, label, selected) {
  return `<option value="${value}"${selected ? ' selected' : ''}>${label}</option>`;
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
const presetOf = (span) => PRESETS.find((x) => x.span[0] === span[0] && x.span[1] === span[1]);
let customOpen = false;
let monthly = null;                                // complaints per month for the selected offenses (the strip)
let stripSpan = null;                              // span being dragged / keyed, before it is applied

/** Apply a span of months: the strip and label update at once, the map follows. */
function setSpan(a, b, { now = true } = {}) {
  state.period = periodFromSpan(state.period, a, b);
  stripSpan = null;
  renderPeriod();
  if (now) refresh(); else scheduleRefresh();
}
let refreshTimer = 0;
function scheduleRefresh() { clearTimeout(refreshTimer); refreshTimer = setTimeout(refresh, 250); }

function renderPeriod() {
  const span = stripSpan ?? spanOf(state.period);
  const preset = presetOf(span);
  const label = labelOf(periodFromSpan(state.period, span[0], span[1]));
  $('#period-label').textContent = label;
  const chips = $('#period-presets');
  const items = [...PRESETS.map((x) => [x.id, x.label]), ['custom', 'Custom']];
  const current = preset && !customOpen ? preset.id : 'custom';
  chips.innerHTML = items.map(([id, l]) => `<button type="button" class="chip" role="radio" data-preset="${id}" aria-checked="${id === current}" tabindex="${id === current ? 0 : -1}">${l}</button>`).join('');
  chips.onclick = (e) => {
    const id = e.target.closest('[data-preset]')?.dataset.preset;
    if (!id) return;
    if (id === 'custom') { customOpen = true; renderPeriod(); $('#period-custom select')?.focus(); return; }
    customOpen = false;
    const x = PRESETS.find((p) => p.id === id);
    setSpan(...x.span);
    if (e.detail === 0) chips.querySelector(`[data-preset="${id}"]`)?.focus();   // keyboard: keep focus on the new chip
  };
  // Radio group keys: arrows move between chips (and choose), like native radios.
  chips.onkeydown = (e) => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
    const all = [...chips.querySelectorAll('.chip')];
    const i = all.indexOf(document.activeElement);
    const next = all[(i + (e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 1) + all.length) % all.length];
    next.click(); next.focus(); e.preventDefault();
  };
  // Custom: From / To month pickers
  const custom = $('#period-custom');
  custom.hidden = !customOpen && !!preset;
  if (!custom.hidden) {
    custom.innerHTML = '';
    for (const [l, i] of [['From', 0], ['To', 1]]) {
      const row = document.createElement('div');
      row.className = 'range-row';
      row.innerHTML = `<span>${l}</span>`;
      row.append(monthSelects(span[i], (v) => {
        customOpen = true;
        const s = [...span]; s[i] = v;
        setSpan(s[0], s[1]);
        custom.querySelectorAll('select')[i * 2]?.focus();
      }));
      custom.append(row);
    }
  }
  drawStrip(span, label);
}

/** The month strip: one bar per month (complaints for the selected offenses), the chosen span in ink. */
function drawStrip(span, label) {
  const el = $('#strip');
  const svg = el.querySelector('svg');
  const w = el.clientWidth || 280, h = el.clientHeight || 40, n = N_MONTHS;
  const bw = w / n;
  const max = monthly ? Math.max(1, ...monthly) : 1;
  let bars = `<rect class="band" x="${span[0] * bw}" y="0" width="${(span[1] - span[0] + 1) * bw}" height="${h}"/>`;
  for (let m = 0; m < n; m++) {
    const v = monthly ? monthly[m] : 0;
    const bh = monthly ? Math.max(1, (v / max) * (h - 4)) : 1;
    const inside = m >= span[0] && m <= span[1];
    bars += `<rect class="${inside ? 'bar-in' : 'bar-out'}" x="${m * bw + 0.25}" y="${h - bh}" width="${Math.max(0.6, bw - 0.6)}" height="${bh}"/>`;
  }
  bars += `<line class="edge" x1="${span[0] * bw}" x2="${span[0] * bw}" y1="0" y2="${h}"/><line class="edge" x1="${(span[1] + 1) * bw}" x2="${(span[1] + 1) * bw}" y1="0" y2="${h}"/>`;
  svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  svg.innerHTML = bars;
  el.setAttribute('aria-valuenow', String(span[0]));
  el.setAttribute('aria-valuetext', label);
}

function setupStrip() {
  const el = $('#strip');
  const monthAt = (x) => {
    const r = el.getBoundingClientRect();
    return Math.max(0, Math.min(N_MONTHS - 1, Math.floor(((x - r.left) / r.width) * N_MONTHS)));
  };
  let anchor = null;
  // Pressing on the chosen span (or within 2 months of an edge) grabs its nearer edge and stretches
  // it; the other edge stays put. Pressing elsewhere starts a new span (decision #80).
  const grab = (m) => {
    const [a, b] = spanOf(state.period);
    if (m < a - 2 || m > b + 2) return null;
    return Math.abs(m - a) <= Math.abs(m - b) ? b : a;        // the anchor is the far edge
  };
  el.addEventListener('pointermove', (e) => {
    if (anchor !== null) return;
    el.style.cursor = grab(monthAt(e.clientX)) !== null ? 'ew-resize' : 'crosshair';
  });
  el.addEventListener('pointerdown', (e) => {
    const m = monthAt(e.clientX);
    const fixed = grab(m);
    anchor = fixed ?? m;
    el.setPointerCapture(e.pointerId);
    customOpen = false;
    stripSpan = fixed !== null ? [Math.min(fixed, m), Math.max(fixed, m)] : [m, m];
    if (fixed !== null) { const [a, b] = spanOf(state.period); stripSpan = [a, b]; }   // a click without dragging changes nothing
    renderPeriod();
    e.preventDefault();                               // no text selection; no focus ring for a mouse press
  });
  el.addEventListener('pointermove', (e) => {
    if (anchor === null) return;
    const m = monthAt(e.clientX);
    stripSpan = [Math.min(anchor, m), Math.max(anchor, m)];
    renderPeriod();                                   // feedback while dragging; the map follows on release
  });
  const end = () => {
    if (anchor === null) return;
    anchor = null;
    const [a, b] = stripSpan ?? spanOf(state.period);
    const [a0, b0] = spanOf(state.period);
    if (a === a0 && b === b0) { stripSpan = null; renderPeriod(); return; }   // a plain click on the span: nothing to change
    setSpan(a, b);
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
  // Keys: arrows move the span; Shift + arrows change its length. Whole-year spans move by a year.
  el.addEventListener('keydown', (e) => {
    const dir = { ArrowLeft: -1, ArrowDown: -1, ArrowRight: 1, ArrowUp: 1 }[e.key];
    if (!dir && e.key !== 'Home' && e.key !== 'End') return;
    e.preventDefault();
    let [a, b] = stripSpan ?? spanOf(state.period);
    const step = monthOf(a) === 0 && monthOf(b) === 11 ? 12 : 1;
    if (e.key === 'Home') { b -= a; a = 0; }
    else if (e.key === 'End') { a += N_MONTHS - 1 - b; b = N_MONTHS - 1; }
    else if (e.shiftKey) b = Math.max(a + step - 1, Math.min(N_MONTHS - 1, b + dir * step));
    else if (a + dir * step >= 0 && b + dir * step <= N_MONTHS - 1) { a += dir * step; b += dir * step; }
    customOpen = false;
    stripSpan = [a, b];
    renderPeriod();
    clearTimeout(keyTimer);
    keyTimer = setTimeout(() => setSpan(a, b), 250);  // holding a key: one refresh at the end
  });
  new ResizeObserver(() => renderPeriod()).observe(el);
}
let keyTimer = 0;
/** Complaints per month for the selected offenses, for the strip (cached per offense set). */
const monthlyCache = new Map();
async function loadMonthly() {
  // With nothing selected the strip keeps the shape of all complaints, greyed, so the data
  // visibly still exists.
  const greyed = !state.cats.size;
  $('#strip').classList.toggle('greyed', greyed);
  const key = greyed ? catList(meta.categories.map((c) => c.code)) : catList(state.cats);
  if (!monthlyCache.has(key)) {
    monthlyCache.set(key, query(`SELECT m, sum(n)::INTEGER AS n FROM agg_precinct WHERE cat IN (${key}) GROUP BY 1`).then((rows) => {
      const out = new Array(N_MONTHS).fill(0);
      for (const r of rows) if (r.m >= 0 && r.m < N_MONTHS) out[r.m] = r.n;
      return out;
    }));
  }
  const values = await monthlyCache.get(key);
  if (greyed !== !state.cats.size || (!greyed && key !== catList(state.cats))) return;
  monthly = values;
  renderPeriod();
}

// ---------- offenses: four group rows (folded), each type with its count and a thin bar
// Short names where the full one doesn't fit the row (the full name is the accessible name and the
// tooltip, and is used everywhere else).
const SHORT_LABELS = {};                          // one name everywhere (decision #77)
const openGroups = new Set();                     // groups unfolded this visit (all folded at first)
let catCounts = new Map();                        // complaints per type in the chosen dates (every type)
function renderCategories() {
  const grid = $('.cat-grid');
  const keep = document.activeElement?.closest('.cat-grid') ? document.activeElement.dataset.focus : null;
  const total = meta.categories.length;
  $('#offenses-count').textContent = state.cats.size === total ? `all ${total}` : `${state.cats.size} of ${total}`;
  const max = Math.max(1, ...meta.categories.map((c) => catCounts.get(c.code) ?? 0));
  const count = (n) => (catCounts.size ? `<span class="cat-count">${tnum(fmt(n))}</span>` : '');
  const only = (codes, name) => `<button type="button" class="cat-only" data-only="${codes.join(',')}" data-focus="only:${codes.join(',')}" aria-label="Show only ${name}">Only</button>`;
  let html = '';
  for (const g of Object.keys(GROUP_LABELS)) {
    const cats = meta.categories.filter((x) => x.group === g);
    const on = cats.filter((c) => state.cats.has(c.code)).length;
    const checked = on === cats.length ? 'true' : on === 0 ? 'false' : 'mixed';
    const n = cats.reduce((t, c) => t + (catCounts.get(c.code) ?? 0), 0);
    const single = cats.length === 1;
    const open = openGroups.has(g);
    const codes = cats.map((c) => c.code);
    html += `<div class="cat-row group" style="--g:${GROUP_COLORS[g]}">
      <button type="button" class="cat-check" role="checkbox" aria-checked="${checked}" data-group="${g}" data-focus="g:${g}">
        <span class="box" aria-hidden="true"></span><span class="name"><i class="swatch" aria-hidden="true"></i><span class="label-text">${GROUP_LABELS[g]}</span></span><span class="cat-n">${count(n)}</span></button>
      ${only(codes, GROUP_LABELS[g].toLowerCase())}
      ${single ? '<span class="cat-fold" aria-hidden="true" style="visibility:hidden"></span>'
        : `<button type="button" class="cat-fold" aria-expanded="${open}" aria-controls="types-${g}" data-fold="${g}" data-focus="f:${g}" aria-label="${open ? 'Hide' : 'Show'} the types of ${GROUP_LABELS[g].toLowerCase()}"></button>`}
    </div>`;
    if (single) continue;
    html += `<div class="cat-types" id="types-${g}" style="--g:${GROUP_COLORS[g]}"${open ? '' : ' hidden'}>
      ${g === 'enforcement' ? '<span class="group-note">Mostly found by police on patrol</span>' : ''}`;
    // Most complaints first (for the chosen dates); groups keep their place so they don't jump.
    const byCount = [...cats].sort((a, b) => (catCounts.get(b.code) ?? 0) - (catCounts.get(a.code) ?? 0));
    for (const c of byCount) {
      const hidden = state.notMapped.has(c.code);
      const v = catCounts.get(c.code) ?? 0;
      html += `<div class="cat-row">
        <button type="button" class="cat-check" role="checkbox" aria-checked="${state.cats.has(c.code)}" data-code="${c.code}" data-focus="c:${c.code}"
          aria-label="${c.label}" title="${c.label}${hidden ? ': location withheld by NYPD, counted in totals, not drawn' : ''}"
          ${hidden ? `aria-description="Location withheld by NYPD: counted in totals, not drawn"` : ''}>
          <span class="box" aria-hidden="true"></span><span class="name"><span class="label-text">${SHORT_LABELS[c.label] ?? c.label}</span>${hidden ? '<span class="mark" aria-hidden="true">†</span>' : ''}</span><span class="cat-n">${count(v)}<span class="cat-bar" aria-hidden="true"><i style="width:${(100 * v) / max}%"></i></span></span></button>
        ${only([c.code], c.label.toLowerCase())}
        <span class="cat-fold" aria-hidden="true" style="visibility:hidden"></span>
      </div>`;
    }
    html += '</div>';
  }
  grid.innerHTML = html;
  if (keep) grid.querySelector(`[data-focus="${keep}"]`)?.focus();
}
function setupCategoryActions() {
  const changed = () => { renderCategories(); loadMonthly(); refresh(); };
  window.__setCats = (codes) => { state.cats = new Set(codes); changed(); };   // tests
  $('.cat-grid').addEventListener('click', (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    if (t.dataset.fold) {
      const g = t.dataset.fold;
      openGroups.has(g) ? openGroups.delete(g) : openGroups.add(g);
      renderCategories();
      return;
    }
    if (t.dataset.only) { state.cats = new Set(t.dataset.only.split(',').map(Number)); return changed(); }
    if (t.dataset.group) {
      const cats = meta.categories.filter((x) => x.group === t.dataset.group);
      const all = cats.every((c) => state.cats.has(c.code));
      for (const c of cats) all ? state.cats.delete(c.code) : state.cats.add(c.code);   // all on -> off; else -> all on
      return changed();
    }
    if (t.dataset.code) {
      const code = +t.dataset.code;
      state.cats.has(code) ? state.cats.delete(code) : state.cats.add(code);
      return changed();
    }
  });
  document.querySelector('[data-select="all"]').onclick = () => { state.cats = new Set(meta.categories.map((c) => c.code)); changed(); };
  document.querySelector('[data-select="none"]').onclick = () => { state.cats = new Set(); changed(); };
}

// Legend: the same ramp and breaks the map is using right now (breaks follow the viewport).
/** What the current offense filter is, as words for the key title ("crimes against persons"). */
function selectionWords() {
  const n = state.cats.size, all = meta.categories.length;
  if (n === all || n === 0) return '';
  const groups = [...new Set([...state.cats].map((c) => meta.categories[c].group))];
  const full = (g) => meta.categories.filter((c) => c.group === g).every((c) => state.cats.has(c.code));
  if (n === 1) return meta.categories[[...state.cats][0]].label.toLowerCase();
  if (groups.length === 1 && full(groups[0])) return GROUP_LABELS[groups[0]].toLowerCase();
  return `${n} of ${all} offense types`;
}
// Key: the classes the map is showing, as numeric ranges, with measure, unit and period in the title.
let lastLegend = null;
function renderLegend(spec = lastLegend) {
  if (!spec || !meta) return;
  lastLegend = spec;
  document.querySelector('.legend').classList.toggle('points', !!spec.points);
  if (spec.points) {                               // zoomed in: dots, sized by count, colored by group
    const what = selectionWords();
    $('#legend-title').textContent = `Complaint locations, ${[what, periodLabel()].filter(Boolean).join(', ')}`;
    $('#legend-hint').textContent = 'To protect privacy, the NYPD moves every complaint to the middle of its block or to the nearest corner. That is why the dots line up along streets and gather at intersections: each one is a stretch of street, never one address. The size of a dot grows with the number of complaints there, and its color is the offense group with the most complaints there. Rape and sex crimes are never placed on the map.';
    const groups = Object.entries(GROUP_LABELS).map(([g, l]) => `<span class="pk-group"><i style="background:${GROUP_COLORS[g]}"></i>${{ person: 'Persons', property: 'Property', enforcement: 'Enforcement', other: 'Other' }[g] ?? l}</span>`).join('');
    const sizes = [1, 10, 50].map((n) => { const r = spec.radius(n); return `<span class="pk-size"><svg width="${2 * r + 2}" height="20" aria-hidden="true"><circle cx="${r + 1}" cy="10" r="${r}"/></svg>${n}</span>`; }).join('');
    $('.legend-ramp').innerHTML = '';
    $('.legend-labels').innerHTML = `<div class="pk-row"><span class="pk-k">Color: most frequent group</span>${groups}</div>
      <div class="pk-row"><span class="pk-k">Size: complaints at this location</span>${sizes}</div>
      <p class="pk-note"><span>NYPD moves each complaint to mid-block or the nearest corner, so dots line up along streets.</span></p>`;
    $('.legend-few').hidden = true;
    return;
  }
  const { ramp, breaks, unit, rate, few } = spec;
  const what = selectionWords();
  const tail = [what, periodLabel()].filter(Boolean).join(', ');
  $('#legend-title').textContent = rate ? `Complaints per 1,000 residents a year, ${tail}`
    : `Complaints per hexagon, ${tail}`;
  $('#legend-hint').textContent = rate
    ? 'Precincts and boroughs are colored by complaints per 1,000 residents a year (2020 Census), in six classes with about the same number of precincts in each; the limits are rounded. Boroughs use the same classes. Precincts with fewer than 2,000 residents are hatched and get no rate. Rape and sex crimes are included.'
    : 'Each hexagon is 180 m on a side, about eight blocks. The colors split all the hexagons with complaints in the city at the 20th, 40th, 60th, 80th and 95th percentiles (rounded), so the darkest shade is the top 5%. They change only when you change the dates or offenses, so panning never recolors the map. Column height shows the count too.';
  if (!breaks.length || breaks.some((b) => !Number.isFinite(b))) {     // nothing to classify (yet: before the first counts)
    $('.legend-ramp').innerHTML = '';
    $('.legend-labels').innerHTML = '<span>No complaints to show</span>';
    $('.legend-few').hidden = true;
    return;
  }
  const fmtB = (v) => (rate ? (v >= 100 ? fmt(Math.round(v)) : String(+v.toFixed(1))) : fmtShort(v));
  // Ranges that don't overlap: rates as "under 40 · 40–49 · … · 100+" when the breaks are whole numbers.
  const whole = rate && breaks.every((b) => Number.isInteger(b) && b >= 10);
  const ranges = ramp.map((_, i) => {
    if (i === 0) return rate ? `under ${fmtB(breaks[0])}` : `1–${fmtB(breaks[0])}`;
    if (i === ramp.length - 1) return `${rate ? fmtB(breaks[i - 1]) : fmtB(breaks[i - 1] + 1)}+`;
    const lo = rate ? breaks[i - 1] : breaks[i - 1] + 1;
    const hi = whole ? breaks[i] - 1 : breaks[i];
    return lo === hi ? fmtB(lo) : `${fmtB(lo)}–${fmtB(hi)}`;
  });
  $('.legend-ramp').style.setProperty('--k', ramp.length);
  $('.legend-ramp').innerHTML = ramp.map((c) => `<span style="background:${c}"></span>`).join('');
  $('.legend-labels').innerHTML = ranges.map((r) => `<span>${tnum(r)}</span>`).join('');
  $('.legend-few').hidden = !few;
}

function renderCity({ total, precinctOnly, previous, base, days }) {
  showSummary({ total, base: base && { ...base, n: previous }, cityRate: true,
    ratio: { value: (total / (meta.totals.population_2020 / 1000) / (days / 365.25)).toFixed(1), label: 'Rate',
      note: 'per 1,000 residents a year (2020 Census)', words: `${(total / (meta.totals.population_2020 / 1000) / (days / 365.25)).toFixed(1)} per 1,000 residents a year` },
    notes: [precinctOnly ? `${fmt(precinctOnly)} have their location withheld by NYPD: counted, not on the map.` : ''] });
}

const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
const helpMark = (text, label = 'this') => (text
  ? ` <button type="button" class="q" aria-expanded="false" aria-label="How ${esc(label.toLowerCase())} is measured" data-help="${esc(text)}">?</button>` : '');
// The tiles' "?": a short explanation under the tiles; one open at a time, Esc or a second click closes.
let helpOpen = null;
function closeHelp({ focus = false } = {}) {
  if (!helpOpen) return;
  helpOpen.setAttribute('aria-expanded', 'false');
  document.querySelector('.help-pop')?.remove();
  if (focus) helpOpen.focus();
  helpOpen = null;
}
function setupHelpMarks() {
  $('.figures').addEventListener('click', (e) => {
    const q = e.target.closest('.q[data-help]');
    if (!q) return;
    const same = helpOpen === q;
    closeHelp();
    if (same) return;
    const pop = document.createElement('p');
    pop.className = 'help-pop';
    pop.id = 'help-pop';
    pop.setAttribute('role', 'note');
    pop.textContent = q.dataset.help;
    $('.figures').after(pop);
    q.setAttribute('aria-expanded', 'true');
    q.setAttribute('aria-controls', 'help-pop');
    helpOpen = q;
  });
}
/** Change against the baseline (2019, or the period before): tile value, note and the words for
 *  the lead sentence. Small counts (under 20) give both numbers instead of a percentage. */
function changeOf(total, base) {
  if (!base) return { value: '—', note: 'no earlier period in the data', words: '' };
  const year = base.label.replace(/^Change since /, '');
  const x = total * base.scale;
  if (total < 20 || base.n < 20) {
    return { value: `${fmt(base.n)} → ${fmt(x)}`, note: base.scale === 1 ? `${year} → now` : `${year} → yearly average`, words: `${fmt(base.n)} ${base.words.replace(/^from /, 'in ')}` };
  }
  const pct = ((x - base.n) / base.n) * 100;
  const shown = Math.abs(pct) >= 10 ? Math.round(pct) : +pct.toFixed(1);
  const value = shown === 0 ? '0%' : `${shown > 0 ? '+' : '−'}${Math.abs(shown)}%`;
  const note = `${year}: ${fmt(base.n)}${base.scale === 1 ? '' : ', vs yearly average'}`;
  const words = Math.abs(pct) < 1 ? `about the same as ${base.words.replace(/^from /, '')}`
    : `${pct > 0 ? 'up' : 'down'} ${Math.abs(shown)}% ${base.words}`;
  // A jump over +300% is almost always NYPD moving where it places complaints (decision #82).
  return { value, note, words: pct > 300 ? `${words} (a jump this large usually means NYPD changed how it records locations here)` : words };
}
/** The panel's lead sentence and three tiles: Total · Compared with the city · Change since 2019. */
function showSummary({ total, totalNote = '', ratio = { value: 'n/a' }, label = 'Compared with the city', base, notes = [], changeOverride = null, leadParts = null }) {
  const change = changeOverride ?? changeOf(total, base);
  const parts = [`${fmt(total)} complaint${total === 1 ? '' : 's'} in ${periodLabel()}`];
  if (leadParts) parts.push(...leadParts);
  else {
    if (ratio.words) parts.push(ratio.words);
    if (change.words) parts.push(change.words);
  }
  $('.lead').textContent = `${parts.join(', ')}.`;
  if (total === 0) {
    $('.lead').innerHTML = `No complaints${state.cats.size === meta.categories.length ? '' : ' of the selected types'} here in ${periodLabel()}. <button type="button" class="chip reset-filters">Reset filters</button>`;
    $('.lead .reset-filters').onclick = resetFilters;
  }
  // A ledger, not KPI cards (decision #77): short label, the number, a comparison line; "?" in the corner.
  const short = (l) => ({ 'Compared with the city': 'vs city', 'Compared with typical': 'vs typical' }[l]
    ?? (/^Change since \d{4}$/.test(l) ? l.replace(/^Change since /, 'vs ') : /^Change since /.test(l) ? 'vs earlier' : l));
  const tile = (l, v, note = '', help = '') => `<div class="figure"><div class="label">${short(l)}</div>${helpMark(help, l)}
    <div class="value${/^[−+]?[\d.,]+[×%]?$|<span/.test(v) ? (String(v).replace(/<[^>]+>/g, '').length > 5 ? ' long' : '') : ' text'}">${v}</div>${note ? `<div class="fnote">${note}</div>` : ''}</div>`;
  closeHelp();
  $('.figures').innerHTML = tile('Total', tnum(fmt(total)), totalNote || 'complaints')
    + tile(ratio.label ?? label, ratio.value, ratio.note ?? '', ratio.help ?? '')
    + tile(changeOverride?.label ?? base?.label ?? 'Change', change.value, change.note,
      base ? `The same months in ${base.label.replace(/^Change since /, '')}${base.scale === 1 ? '' : ' (a whole year, against this period\'s yearly average)'}, same offenses.${base.label.endsWith('2019') ? ' 2019 is the last year before the pandemic changed reporting.' : ''}` : '');
  $('.figures-note').textContent = notes.filter(Boolean).join('\n');
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
  // Each bar in its offense group's color (decision #78): the same four colors as the dots and the
  // offense list, so a dot's color can be read off its panel. Above them, the totals by group, in
  // order, which say why a dot has the color it has (its most frequent group).
  const items = meta.categories
    .filter((c) => state.cats.has(c.code))
    .map((c) => ({ label: c.label, group: c.group, n: byCat.get(c.code) ?? 0 }))
    .sort((a, b) => b.n - a.n);
  const shown = state.showAllBars ? items : items.slice(0, 8);
  const max = Math.max(1, ...items.map((i) => i.n));
  const groups = Object.keys(GROUP_LABELS)
    .map((g) => ({ g, n: items.filter((i) => i.group === g).reduce((t, i) => t + i.n, 0) }))
    .filter((x) => x.n > 0).sort((a, b) => b.n - a.n);
  const total = groups.reduce((t, x) => t + x.n, 0);
  const short = { person: 'Persons', property: 'Property', enforcement: 'Enforcement', other: 'Other' };
  $('.group-split').innerHTML = groups.length > 1 ? `<div class="split-bar" aria-hidden="true">${groups.map((x) => `<i style="width:${(100 * x.n) / total}%;background:${GROUP_COLORS[x.g]}"></i>`).join('')}</div>
    <p class="split-keys">${groups.map((x) => `<span><i style="background:${GROUP_COLORS[x.g]}" aria-hidden="true"></i>${short[x.g]}&nbsp;<b>${tnum(fmt(x.n))}</b></span>`).join('')}</p>` : '';
  $('.bars').innerHTML = shown.map(({ label, group, n }) => `<div class="bar"><span class="name">${label}</span><span class="num">${tnum(fmt(n))}</span>
      <span class="track"><span class="fill" style="width:${Math.max(0.6, (n / max) * 100)}%;background:${GROUP_COLORS[group]}"></span></span></div>`).join('');
  const more = $('.more');
  more.hidden = items.length <= 8;
  more.textContent = state.showAllBars ? 'Show fewer' : `Show all ${items.length}`;
  more.onclick = () => { state.showAllBars = !state.showAllBars; renderBars(rows); };
}

// Summary in the title block: the total for the current filters (a link to the city panel) and
// what part of it the current view cannot draw.
function renderSummary({ total, precinctOnly, none, noPrecinct, noBorough }) {
  $('#city-total').innerHTML = `${tnum(fmt(total))} complaints`;
  // One sentence, like the dek under a headline: "579,560 complaints in 2025, all offenses.
  // 16,430 have no location on the map."
  $('#summary-filter').textContent = `in ${filterLabel()}.`;
  const byBorough = state.unit2d === 'borough';
  const missing = byBorough ? noBorough : noPrecinct;
  $('#summary-sub').textContent = state.view === 'precincts'
    ? (missing > 0 ? `${fmt(missing)} have no ${byBorough ? 'borough' : 'precinct'}.` : `All are drawn by ${byBorough ? 'borough' : 'precinct'}.`)
    : (precinctOnly + none ? `${fmt(precinctOnly + none)} can't be placed on the map.` : '');
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
  // Hyphenated names don't break at the hyphen ("Bedford-/Stuyvesant") unless they are too long
  // for one line ("Downtown Brooklyn-DUMBO-Boerum Hill"), which would push the buttons off the panel.
  $('.detail h2').innerHTML = String(title).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/(\S+-\S+)/g, (w) => (w.length <= 18 ? `<span class="nobr">${w}</span>` : w.replace(/-/g, '-<wbr>')));
  $('.detail .sub').textContent = filterLabel();
  const ctx = $('.detail .context');
  ctx.innerHTML = context ?? '';
  ctx.hidden = !context;
  ctx.querySelector('[data-nta]')?.addEventListener('click', (e) => {
    selectNta(+e.currentTarget.dataset.nta, { move: true });
  });
  ctx.querySelector('[data-boro]')?.addEventListener('click', (e) => selectBorough(+e.currentTarget.dataset.boro));
}

function selectNta(code, { move = isPhone() } = {}) {
  const feature = ntaGeo.features.find((f) => f.properties.code === code);
  state.selected = { kind: 'nta', code };
  setSelection(feature, 'area', meta.ntas[code]?.name);
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
  setSelection(feature, 'area', meta.boroughs[code]);
  setPin(null);
  fitTo(bounds(feature), { maxZoom: 15, duration: 1600 });
  refresh();
}
const boroughPopulation = (code) => meta.ntas.filter((n) => n.boro === code).reduce((t, n) => t + n.population, 0);

// Precinct boundaries load the first time the precinct view is used.
let precinctGeo;
async function ensurePrecincts() {
  if (precinctGeo) return;
  [precinctGeo] = await Promise.all([loadJson('precincts.geojson'), loadCompare()]);   // rates need populations
  setPrecinctShapes(precinctGeo);
}
const precinctMerged = () => Math.min(...monthsOf(state.period)) < SPLIT_MONTH;
function selectPrecinct(props, { move = isPhone() } = {}) {
  state.selected = { kind: 'precinct', props };
  const feature = precinctGeo.features.find((f) => f.properties === props || (f.properties.pct === props.pct && !props.merged));
  setSelection(feature, 'area', feature && precinctName(feature.properties));
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
  if (isPhone()) fitTo(bounds(hexPolygon(q, r)), { maxZoom: 14.5, duration: 900 });
  setPin(null);
  refresh();
}
const RADIUS_M = 200;
/** An address or a corner: pin + 200 m circle, flown to closely enough to show locations. */
function selectPoint(lngLat, label, corner = false) {
  state.selected = { kind: 'point', lngLat, label, corner };
  setSelection(circlePolygon(lngLat, RADIUS_M, 72), 'circle', label);
  setPin(lngLat);
  flyToPoint(lngLat);
  refresh();
}
/** One complaint location (a dot on the zoomed-in map): every complaint NYPD placed at that point.
 *  A small ring marks it; no pin, because a complaint location is never shown as an address. */
const SPOT_EPS = 1e-7;
/** NYPD premise names in sentence case: "RESIDENCE - APT. HOUSE" -> "Residence, apt. house". */
const premiseLabel = (code) => {
  const raw = meta.premises[code];
  if (!raw) return 'Not recorded';
  const t = raw.toLowerCase().replace(/\s*-\s*/g, ', ').replace(/\//g, ' / ').replace(/\bnyc\b/g, 'NYC');
  return t[0].toUpperCase() + t.slice(1);
};
// Written as ranges, not abs(), so the engine can skip the parts of the file far from the point.
const spotSql = ([lon, lat]) => `lat BETWEEN ${lat - SPOT_EPS} AND ${lat + SPOT_EPS} AND lon BETWEEN ${lon - SPOT_EPS} AND ${lon + SPOT_EPS}`;
function selectSpot(lngLat) {
  state.selected = { kind: 'spot', lngLat };
  if (isPhone()) flyToPoint(lngLat, 16, 900);
  setSelection(circlePolygon(lngLat, 18, 36), 'ring');
  setPin(null);
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
  setSelection(feature, 'line', streetById(id)?.name);
  fitTo(bounds(feature), { maxZoom: 15.5, duration: 1600 });
  refresh();
}
function selectCity() {
  state.selected = { kind: 'city' };
  setSelection(null);
  refresh();
}
// Focus: a panel opened from the keyboard (search, the dek's total) takes focus on its heading;
// closing it gives focus back to what opened it. A click on the map moves no focus.
let opener = null;
let focusPanel = false;
function openedBy(el, keyboard = true) { opener = el; focusPanel = keyboard; }
function clearSelection() {
  const back = opener;
  opener = null;
  state.selected = null;
  setPanelView('details');
  $('#search').value = '';
  $('.search-clear').hidden = true;
  setSelection(null);
  setPin(null);
  refresh();
  if (back?.isConnected && back.offsetParent !== null) { back.dataset.quiet = '1'; back.focus(); }
}

function onPick(pick) {
  opener = null; focusPanel = false;
  if (pick.kind === 'precinct') return selectPrecinct(pick.unit);
  if (pick.kind === 'borough') return selectBorough(pick.code);
  if (pick.kind === 'none') return clearSelection();
  if (pick.kind === 'hex') return selectHex(pick.q, pick.r);
  if (pick.kind === 'point') return selectSpot(pick.lngLat);
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
const fmtIndex = (x) => (Number.isFinite(x) ? `${x < 10 ? x.toFixed(1) : Math.round(x)}×` : '–');   // – when nothing to compare (no offenses picked)
const blockLabel = (b) => (b >= 1_000_000
  ? `${Math.floor((b - 1_000_000) / 1000)}-00 to ${Math.floor((b - 1_000_000) / 1000)}-99`
  : `${b}–${b + 99}`);
const fmtLength = (m) => (m >= 1000 ? `${(m / 1000).toFixed(m >= 10000 ? 0 : 1)} km` : `${Math.round(m / 10) * 10} m`);

async function renderSelection(ticket) {
  const sel = state.selected;
  const base = baselineOf(state.period);
  const compare = base;
  const top = (rows) => {
    const best = rows.reduce((a, b) => (b.n > (a?.n ?? -1) ? b : a), null);
    return best ? meta.categories[best.cat].label : 'None';
  };
  const sum = (rows) => rows.reduce((t, r) => t + r.n, 0);

  if (sel.kind === 'nta') {
    const info = meta.ntas[sel.code];
    const [byCat, prev, all] = await Promise.all([
      query(`SELECT cat, sum(n)::INTEGER AS n FROM agg_nta WHERE nta = ${sel.code} AND ${where()} GROUP BY 1`),
      base ? query(`SELECT sum(n)::INTEGER AS n FROM agg_nta WHERE nta = ${sel.code} AND ${where(base.months)}`) : [{ n: 0 }],
      query(`SELECT nta, sum(n)::INTEGER AS n FROM agg_nta WHERE ${where()} GROUP BY 1`),
    ]);
    if (ticket !== pending) return;
    const total = sum(byCat);
    const counts = new Map(all.map((r) => [r.nta, r.n]));
    const cityRate = sum(all) / meta.ntas.reduce((t, x) => t + x.population, 0);
    const residential = info.type === 'residential' && info.population >= FEW_RESIDENTS;
    const rates = meta.ntas.filter((x) => x.type === 'residential' && x.population >= FEW_RESIDENTS)
      .map((x) => (counts.get(x.code) ?? 0) / x.population);
    const rate = total / Math.max(1, info.population);
    renderHeader(info.name, `Neighborhood in <button class="link" data-boro="${info.boro}">${meta.boroughs[info.boro]}</button>, ${info.population ? `${fmt(info.population)} residents` : 'no resident population'}`);
    const years = perYear(daysOf(monthsOf(state.period)));
    const per100k = (r) => fmt((r * 100000) / years);
    showSummary({ total, base: base && { ...base, n: prev[0]?.n ?? 0 },
      ratio: residential ? { value: fmtIndex(rate / cityRate), note: `${ordinal(percentileOf(rates, rate))} percentile, neighborhoods`,
        words: `${fmtIndex(rate / cityRate)} the city rate per resident`,
        help: `${per100k(rate)} complaints a year for every 100,000 residents here, against ${per100k(cityRate)} in the whole city. The percentile is the share of neighborhoods with 2,000 or more residents that have a lower rate.` }
        : { value: 'n/a', note: 'few or no residents' } });
    renderBars(byCat);
    $('.detail .note').textContent = `${RESIDENT_NOTE} Neighborhood counts include only complaints with a map location; rape and sex crimes are counted by precinct.`;
  } else if (sel.kind === 'borough') {
    // Boroughs use NYPD's precinct field, so they count every complaint, including those NYPD
    // places only at the station house (rape, sex crimes).
    const [byCat, prev, city] = await Promise.all([
      query(`SELECT cat, sum(n)::INTEGER AS n FROM agg_precinct WHERE boro = ${sel.code} AND ${where()} GROUP BY 1`),
      base ? query(`SELECT sum(n)::INTEGER AS n FROM agg_precinct WHERE boro = ${sel.code} AND ${where(base.months)}`) : [{ n: 0 }],
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
    showSummary({ total, base: base && { ...base, n: prev[0]?.n ?? 0 },
      ratio: cityRate ? { value: fmtIndex(rate / cityRate), note: `${ordinal(rank)} of 5 boroughs`, words: `${fmtIndex(rate / cityRate)} the city rate per resident`,
        help: `${fmt((rate * 100000) / years)} complaints a year for every 100,000 residents here, against ${fmt((cityRate * 100000) / years)} in the whole city. 1st is the highest rate of the five boroughs.` }
        : { value: 'n/a' } });
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
    const rates = [...units].filter(([k]) => popOf(k) >= FEW_RESIDENTS).map(([k, n]) => n / popOf(k));
    const ranked = population >= FEW_RESIDENTS;
    const years = perYear(daysOf(monthsOf(state.period)));
    renderHeader(precinctName(sel.props), `NYPD precinct${sel.props.merged ? 's' : ''} in ${meta.boroughs[boro[0]?.boro] ?? 'New York City'}, ${fmt(population)} residents`
      + (sel.props.merged ? '<br>Shown together: the 116th was created from the 105th and 113th in December 2024.' : ''));
    showSummary({ total, base: base && { ...base, n: prev[0]?.n ?? 0 },
      ratio: ranked ? { value: fmtIndex(rate / cityRate), note: `${ordinal(percentileOf(rates, rate))} percentile, ${units.size} precincts`,
        words: `${fmtIndex(rate / cityRate)} the city rate per resident`,
        help: `${fmt((rate * 100000) / years)} complaints a year for every 100,000 residents here, against ${fmt((cityRate * 100000) / years)} in the whole city. The percentile is the share of precincts with 2,000 or more residents that have a lower rate.` }
        : { value: 'n/a', note: 'few or no residents' } });
    renderBars(byCat);
    $('.detail .note').textContent = `${RESIDENT_NOTE} Precinct counts use NYPD's precinct field and include every complaint, also rape and sex crimes. Population: 2020 Census blocks inside the precinct.`;
  } else if (sel.kind === 'spot') {
    await renderSpot(sel, ticket, base, sum);
  } else if (sel.kind === 'point') {
    await renderPoint(sel, ticket, base, top, sum);
  } else if (sel.kind === 'street') {
    await renderStreet(sel, ticket, base, top, sum);
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
      ? `Hexagon of about eight blocks in <button class="link" data-nta="${nta.properties.code}">${nta.properties.name}</button>`
      : 'Hexagon of about eight blocks, 180 m per side');
    showSummary({ total, base: base && { ...base, n: prev[0]?.n ?? 0 }, label: 'Compared with typical',
      ratio: median ? { value: `${(total / median).toFixed(1)}×`, note: `${ordinal(percentileOf(values, total))} percentile, hexagons`,
        words: `${(total / median).toFixed(1)}× the median hexagon`, help: `A typical hexagon (the median of those with any complaints, same dates and offenses) has ${fmt(median)}. The percentile is the share of hexagons with fewer.` }
        : { value: 'n/a' } });
    renderBars(byCat);
    $('.detail .note').textContent = 'NYPD places each complaint at the nearest intersection or mid-block, so a hexagon counts the complaints snapped inside it. Rape and sex crimes are never placed on the map.';
  }
}

/** A single complaint location: its complaints, compared with every location in the city. */
async function renderSpot(sel, ticket, base, sum) {
  const at = spotSql(sel.lngLat);
  const start = monthsOf(state.period)[0];
  const [byCat, prev, streets, history, prem] = await Promise.all([
    query(`SELECT cat, sum(n)::INTEGER AS n FROM points WHERE ${at} AND ${where()} GROUP BY 1`),
    base ? query(`SELECT sum(n)::INTEGER AS n FROM points WHERE ${at} AND ${where(base.months)}`) : [{ n: 0 }],
    query(`SELECT street, block FROM loc_street WHERE ${at}`),
    query(`SELECT min(m)::INTEGER AS first, count(DISTINCT m) FILTER (WHERE m < ${start})::INTEGER AS before FROM points WHERE ${at}`),
    query(`SELECT prem, count(*)::INTEGER AS n FROM incidents WHERE lt = 0 AND ${at} AND ${where()} GROUP BY 1 ORDER BY 2 DESC LIMIT 1`),
    loadStreets(loadJson),
  ]);
  if (ticket !== pending) return;
  const total = sum(byCat);
  // Complaints per location across the city, sorted, once per dates and offenses (the city-wide
  // scan is the slow part of a location's panel; every location after the first is instant).
  const key = `locsums:${where()}`;
  if (!locSums.has(key)) {
    locSums.set(key, query(`SELECT sum(n)::INTEGER AS n FROM points WHERE ${where()} GROUP BY lat, lon ORDER BY 1`)
      .then((rows) => Int32Array.from(rows, (r) => r.n)));
  }
  const sorted = await locSums.get(key);
  const lowerBound = (x) => { let lo = 0, hi = sorted.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (sorted[mid] < x) lo = mid + 1; else hi = mid; } return lo; };
  const mid = sorted.length >> 1;
  const cityRow = { med: sorted.length ? (sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2) : 0,
    locs: sorted.length, below: lowerBound(total) };
  if (ticket !== pending) return;
  // Its name: the corner (two or more streets meet here) or the block of its street.
  const names = [...new Set(streets.map((r) => streetById(r.street)?.name).filter(Boolean))];
  const block = streets.find((r) => r.block >= 0);
  const title = names.length >= 2 ? `${names[0]} & ${names[1]}`
    : names.length === 1 ? (block ? `${blockLabel(block.block)} ${names[0]}` : names[0]) : 'Complaint location';
  if (!sel.label) {
    sel.label = title;
    setSelection(circlePolygon(sel.lngLat, 18, 36), 'ring', title);
  }
  const nta = featureAt(ntaGeo, sel.lngLat);
  renderHeader(title, `A location where NYPD placed complaints${names.length >= 2 ? ', at the corner' : ''}${nta ? ` in <button class="link" data-nta="${nta.properties.code}">${nta.properties.name}</button>` : ''}`);
  const med = cityRow?.med ?? 0;
  // A point with less than a year of history before the period was most likely created by a change in
  // how NYPD places complaints: no comparison with 2019 (it would read as an explosion). The lead
  // sentence says what kind of place it is instead.
  // (Only when there could have been history: a period that starts in 2016 has none to compare.)
  const isNew = start >= 12 && (history[0]?.before ?? 0) < 12;
  const firstYear = history[0]?.first != null ? 2016 + Math.floor(history[0].first / 12) : null;
  const topPrem = prem[0] && total ? { label: premiseLabel(prem[0].prem).toLowerCase(), share: Math.round((100 * prem[0].n) / total) } : null;
  const premWords = topPrem && topPrem.share >= 50 && !/^(street|not recorded)$/.test(topPrem.label) ? `${topPrem.share}% recorded at ${/^[aeiou]/.test(topPrem.label) ? 'an' : 'a'} ${topPrem.label}${/store|transit|station|office|bank|hospital|commercial/i.test(topPrem.label) ? ' (often reported by the business or station itself)' : ''}` : null;
  showSummary({ total, totalNote: 'at this point', base: isNew ? null : base && { ...base, n: prev[0]?.n ?? 0 }, label: 'Compared with typical',
    changeOverride: isNew ? { label: 'Earlier', value: firstYear ? `New since ${firstYear}` : 'New point', note: 'no earlier history at this point', words: '' } : null,
    leadParts: isNew ? [premWords ?? `a point first used in ${firstYear}`] : null,
    ratio: med > 0 && total > 0 ? { value: fmtIndex(total / med), note: `${ordinal(Math.min(99, Math.floor((100 * cityRow.below) / Math.max(1, cityRow.locs))))} percentile, locations`,
      words: `${fmtIndex(total / med)} the typical location`,
      help: `A typical location has ${fmt(med)} (the median of the ${fmt(cityRow.locs)} locations in the city with complaints, same dates and offenses). The percentile is the share of those locations with fewer.` }
      : { value: 'n/a' } });
  renderBars(byCat);
  $('.detail .note').textContent = 'NYPD rounds each complaint to the middle of the block or the nearest intersection, so one point gathers every complaint on that stretch of street or corner. Rape and sex crimes are never placed on the map.';
}

/** Address or corner: complaints within 200 m, compared with 200 m circles every 100 m over
 *  all of NYC (compare.json). */
async function renderPoint(sel, ticket, base, top, sum) {
  const compare = base;
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
  let index = { value: '—', note: fair.why, help: 'Compared with a typical 200 m circle in the city.' };
  if (!fair.why) {
    const P = cmp.point[fair.type][fair.series];
    const x = total / fair.years;
    const circles = fmt(cmp.grid_points);
    index = P[50] > 0
      ? { value: fmtIndex(x / P[50]), note: `${ordinal(shareBelow(P, x))} percentile, 200 m circles`, words: `${fmtIndex(x / P[50])} the typical 200 m circle in NYC`,
        help: `A typical 200 m circle in the city has ${fmt(P[50])} (the median of ${circles} circles centered every 100 m on land, same offense types and ${fair.series === 'avg' ? 'yearly average' : 'year'}). The percentile is the share of those circles with fewer.` }
      : { value: 'n/a', note: 'the typical circle has none' };
  }
  const nta = featureAt(ntaGeo, sel.lngLat);
  renderHeader(sel.label, `Within ${RADIUS_M}&nbsp;m of this ${sel.corner ? 'corner' : 'address'}${nta ? ` in <button class="link" data-nta="${nta.properties.code}">${nta.properties.name}</button>` : ''}`);
  showSummary({ total, totalNote: `within ${RADIUS_M}&nbsp;m`, base: base && { ...base, n: previous }, label: 'Compared with typical', ratio: index });
  renderBars(byCat);
  $('.detail .note').textContent = 'Counts complaints NYPD placed within 200 m (about 2 blocks); NYPD places them at the nearest intersection or mid-block, and never places rape and sex crimes on the map. Addresses are located from the City\'s street centerline house-number ranges.';
}

/** Whole street: complaints within 30 m of its centerline, as a rate per 100 m of street. */
async function renderStreet(sel, ticket, base, top, sum) {
  const compare = base;
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
  let pctlNote;
  if (short) pctlNote = 'under 300 m, not ranked';
  else if (fair.why) pctlNote = '';
  else pctlNote = `${ordinal(shareBelow(cmp.street[fair.type][fair.series], rate / fair.years))} percentile, NYC streets`;
  const index = cityRate > 0
    ? { value: fmtIndex(rate / cityRate), note: pctlNote || 'the street average per 100 m', words: `${fmtIndex(rate / cityRate)} the NYC street average per 100 m`,
      help: `NYC streets average ${rateText(cityRate)} per 100 m. The percentile is the share of streets 300 m or longer with a lower rate.` }
    : { value: 'n/a' };
  const ntas = s.nNtas > 3 ? `${s.nNtas} neighborhoods` : s.ntas.map((c) => meta.ntas[c]?.name).filter(Boolean).join(', ');
  renderHeader(s.name, `Street in ${meta.boroughs[s.boro]}, ${fmtLength(s.length)} long${ntas ? `, through ${ntas}` : ''}`);
  showSummary({ total, totalNote: `${rateText(rate)} per 100 m`, base: base && { ...base, n: prev[0]?.n ?? 0 }, ratio: index,
    notes: busiest[0]?.n ? [`Busiest block: numbers ${blockLabel(busiest[0].block)} (${fmt(busiest[0].n)}).`] : [] });
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
const locSums = new Map();
const cachedQuery = (key, sql) => { if (!cache.has(key)) cache.set(key, query(sql).then(toSeries)); return cache.get(key); };
const catList = (cats) => [...cats].join(',') || '-1';
const yearsOf = (months) => [...new Set(months.map((m) => 2016 + Math.floor(m / 12)))];

function chartColor() {
  const g = selectionGroup();
  const dark = document.documentElement.dataset.theme === 'dark';
  return dark ? RAMPS.dark[5] : RAMPS.light[4];    // one data color, whatever the offense filter (≥ 7:1)
}
/** Unselected columns: a lighter step of the same ramp, still ≥ 3:1 on the panel. */
function chartColorOff() {
  return document.documentElement.dataset.theme === 'dark' ? RAMPS.dark[3] : RAMPS.light[3];
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
          .map((r) => ({ key: r.nta, label: meta.ntas[r.nta].name, n: r.n, pop: meta.ntas[r.nta].population, residential: meta.ntas[r.nta].type === 'residential' })),
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
    case 'spot': {
      const at = spotSql(sel.lngLat);
      return {
        name: sel.label ?? 'Complaint location', nycByCat: nycMapped, blocks: null,
        spot: {
          premises: async (months, cats) => (await query(`SELECT prem, count(*)::INTEGER AS n FROM incidents
            WHERE lt = 0 AND ${at} AND ${monthSql(months)} AND cat IN (${catList(cats)}) GROUP BY 1 ORDER BY 2 DESC`))
            .map((r) => ({ label: premiseLabel(r.prem), n: r.n })),
          each: async (months, cats) => (await query(`SELECT d, hour, dow, cat, prem, att FROM incidents
            WHERE lt = 0 AND ${at} AND ${monthSql(months)} AND cat IN (${catList(cats)}) ORDER BY d, hour LIMIT 60`))
            .map((r) => ({ ...r, prem: r.prem >= 0 ? premiseLabel(r.prem) : '' })),
          days: (months, cats) => query(`SELECT d, count(*)::INTEGER AS n FROM incidents
            WHERE lt = 0 AND ${at} AND ${monthSql(months)} AND cat IN (${catList(cats)}) GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 5`),
        },
        byCat: () => cachedQuery(`spot:${sel.lngLat}`, `SELECT m, cat, sum(n)::INTEGER AS n FROM points WHERE ${at} GROUP BY 1, 2`),
        time: async (months, cats) => {
          const rows = await query(`SELECT dow, hour, count(*)::INTEGER AS n FROM incidents
            WHERE lt = 0 AND ${at} AND ${monthSql(months)} AND cat IN (${catList(cats)}) GROUP BY 1, 2`);
          const grid = Array.from({ length: 7 }, () => new Array(24).fill(0));
          for (const r of rows) if (r.dow >= 0 && r.hour >= 0) grid[r.dow][r.hour] += r.n;
          return { grid, years: null };
        },
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
  // One baseline everywhere (decision #77): the same as the panel's tiles, the same months of 2019
  // (or the period before, for periods that start before 2020). A longer period is compared as its
  // yearly average (prevScale).
  const base = baselineOf(state.period);
  const report = await buildReport({
    ...src, kind: state.selected.kind, period: state.period, months: monthsOf(state.period),
    prevMonths: base?.months ?? null, prevLabel: base ? base.label.replace(/^Change since /, 'vs ') : '', prevScale: base?.scale ?? 1,
    periodLabel: periodLabel(),
    cats: state.cats, categories: meta.categories, color: chartColor(), colorOff: chartColorOff(), highlightBlock, clearHighlight,
    groupColor: (cat) => GROUP_COLORS[meta.categories[cat]?.group ?? 'other'],
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

// ---------- loading: a 2 px bar under the dek moves through the stages of the first load
function progress(p) {
  $('.progress i').style.setProperty('--p', `${p}%`);
  document.body.dataset.loading = p < 100 ? 'true' : 'false';
}
let firstPaint = null;
function markFirstPaint() {
  if (firstPaint !== null) return;
  firstPaint = Math.round(performance.now());
  progress(100);
  console.info(`[nycmap] first data paint: ${firstPaint} ms after navigation start`);
  window.__firstPaint = firstPaint;
}

// Filters: the controls answer at once; if the map has not repainted 400 ms later, the old map
// dims to 60% so it doesn't pass for the new answer.
let staleTimer = 0;
function markStale() {
  clearTimeout(staleTimer);
  staleTimer = setTimeout(() => { document.body.dataset.stale = 'true'; }, 400);
}
function clearStale() {
  clearTimeout(staleTimer);
  delete document.body.dataset.stale;
}

/** Back to the defaults: every offense type, 2025. */
function resetFilters() {
  state.cats = new Set(meta.categories.map((c) => c.code));
  state.period = defaultPeriod();
  customOpen = false;
  renderPeriod();
  renderCategories();
  loadMonthly();
  refresh();
}

// ---------- refresh everything for the current filters
let pending = 0;
async function refresh() {
  const ticket = ++pending;
  if (document.body.dataset.ready) {
    markStale();
    $('#summary-filter').textContent = `in ${filterLabel()}.`;     // the words change at once, the number follows
  }
  // First visit: until the engine has downloaded, a new filter can't be answered yet; say so.
  if (!db.engineIsReady() && document.body.dataset.ready) $('#summary-sub').textContent = 'Loading the full data to apply this…';
  const base = baselineOf(state.period);
  const [hex, byLt, byCatAll, previous, byPct, byBoro] = await Promise.all([
    query(`SELECT q, r, sum(n)::INTEGER AS n FROM hex WHERE ${where()} GROUP BY 1, 2`),
    query(`SELECT lt, sum(n)::INTEGER AS n FROM agg_precinct WHERE ${where()} GROUP BY 1`),
    query(`SELECT cat, sum(n)::INTEGER AS n FROM agg_precinct WHERE ${monthSql(monthsOf(state.period))} GROUP BY 1`),
    base
      ? query(`SELECT sum(n)::INTEGER AS n FROM agg_precinct WHERE ${where(base.months)}`)
      : Promise.resolve([{ n: 0 }]),
    precinctGeo ? query(`SELECT pct, sum(n)::INTEGER AS n FROM agg_precinct WHERE ${where()} GROUP BY 1`) : [],
    boroughGeo ? query(`SELECT boro, sum(n)::INTEGER AS n FROM agg_precinct WHERE boro BETWEEN 1 AND 5 AND ${where()} GROUP BY 1`) : [],
  ]);
  if (ticket !== pending) return;      // a newer refresh started; drop this one
  catCounts = new Map(byCatAll.map((r) => [r.cat, r.n]));
  const byCat = byCatAll.filter((r) => state.cats.has(r.cat));
  renderCategories();
  setTint(selectionGroup());                      // before both layers, so they change color together
  const years = daysOf(monthsOf(state.period)) / 365.25;
  if (precinctGeo) {
    const pop = new Map(Object.entries(cmp?.precinct_population ?? {}).map(([k, v]) => [+k, v]));
    setPrecincts(new Map(byPct.map((r) => [r.pct, r.n])), precinctMerged(), { pop, years });
  }
  if (boroughGeo) setBoroughs(new Map(byBoro.map((r) => [r.boro, r.n])), { pop: new Map([1, 2, 3, 4, 5].map((b) => [b, boroughPopulation(b)])), years });
  renderLegend();                                   // the title names the dates and offenses

  const lt = Object.fromEntries(byLt.map((r) => [r.lt, r.n]));
  const total = (lt[0] ?? 0) + (lt[1] ?? 0) + (lt[2] ?? 0);
  setHexagons(hex, periodLabel());
  clearStale();
  markFirstPaint();
  const panel = $('.detail');
  if (state.selected?.kind === 'city') {
    renderHeader('New York City', `All five boroughs, ${fmt(meta.totals.population_2020)} residents`);
    renderCity({ total, precinctOnly: lt[1] ?? 0, previous: previous[0]?.n ?? 0, base, days: daysOf(monthsOf(state.period)) });
    renderBars(byCat);
    $('.detail .note').textContent = CITY_NOTE;
  } else if (state.selected) {
    await renderSelection(ticket);
  }
  if (ticket !== pending) return;
  await renderCharts(ticket);
  if (ticket !== pending) return;
  if (panel.hidden !== !state.selected) {
    panel.hidden = !state.selected;
    document.body.dataset.selected = String(!!state.selected);
    if (isPhone()) setSnap(state.selected ? 'half' : 'peek');          // details open at half height
  }
  if (state.selected && focusPanel) { focusPanel = false; $('.place').focus({ preventScroll: true }); }
  updateBadge();
  const noPrecinct = byPct.find((r) => r.pct < 0)?.n ?? 0;
  const noBorough = boroughGeo ? total - byBoro.reduce((t, r) => t + r.n, 0) : 0;
  renderSummary({ total, precinctOnly: lt[1] ?? 0, none: lt[2] ?? 0, noPrecinct, noBorough });
  renderNotice(state.view === 'precincts' ? { drawable: total, total } : { drawable: lt[0] ?? 0, total });
  document.body.dataset.ready = 'true';
  window.__refreshed = ticket;        // tests: the last refresh that finished
}

// When the selection has nothing to draw, say why instead of showing an empty map.
function renderNotice({ drawable, total }) {
  const el = $('.map-notice');
  if (drawable > 0) { el.hidden = true; return; }
  const withheld = [...state.cats].filter((c) => state.notMapped.has(c)).map((c) => meta.categories[c].label);
  if (total > 0 && withheld.length) {
    el.innerHTML = `<strong>${withheld.join(', ')}: not shown on the map</strong>
      <p>To protect victims, NYPD places these complaints at the precinct station house instead of where
      they happened. They are counted in the totals on the right, but never drawn.</p>`;
  } else if (total > 0) {
    el.innerHTML = '<strong>Nothing to draw for this selection</strong><p>These complaints have no location in the data. They are counted in the totals on the right.</p>';
  } else if (!state.cats.size) {                  // the cause is the filter, not the data
    el.innerHTML = `<strong>No offenses selected</strong>
      <p>Choose at least one offense type to see complaints.</p><button type="button" class="chip select-all">Select all</button>`;
    el.querySelector('.select-all').onclick = () => document.querySelector('[data-select="all"]').click();
  } else {
    el.innerHTML = `<strong>No complaints of this type in ${periodLabel()}</strong>
      <p>Choose more offense types or other dates.</p><button type="button" class="chip reset-filters">Reset filters</button>`;
    el.querySelector('.reset-filters').onclick = resetFilters;
  }
  el.hidden = false;
}

// ---------- Areas (Hot spots | Precincts | Boroughs) and Tilt, top right of the map
const areaOf = () => (state.view === 'hex' ? 'hex' : state.unit2d);
function setupAreas() {
  const buttons = [...document.querySelectorAll('.areas button')];
  const tilt = $('.tilt-toggle');
  const sync = () => {
    buttons.forEach((b) => { const on = b.dataset.area === areaOf(); b.setAttribute('aria-checked', String(on)); b.tabIndex = on ? 0 : -1; });
    tilt.hidden = state.view !== 'hex';
    tilt.setAttribute('aria-pressed', String(state.tilt));
    tilt.title = state.tilt ? 'Show the map flat' : 'Tilt the map to show columns';
  };
  const choose = async (area) => {
    if (area === areaOf()) return;
    const view = area === 'hex' ? 'hex' : 'precincts';
    if (area !== 'hex' && state.unit2d !== area) {
      state.unit2d = area;
      savePref('unit2d', area);
      setUnit2d(area);
    }
    savePref('view', view);
    if (view !== state.view) {
      state.view = view;
      document.body.dataset.view = view;
      sync();
      if (view === 'precincts') { await ensurePrecincts(); await refresh(); }   // fill before they fade in
      setView(view, { tilt: state.tilt });
      if (view === 'hex') refresh();
    } else { sync(); refresh(); }                    // the dek names the unit
    sync();
  };
  buttons.forEach((b) => (b.onclick = () => choose(b.dataset.area)));
  $('.areas').addEventListener('keydown', (e) => {   // radio group: arrows choose
    const d = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 }[e.key];
    if (!d) return;
    const i = buttons.findIndex((b) => b.dataset.area === areaOf());
    const next = buttons[(i + d + buttons.length) % buttons.length];
    choose(next.dataset.area); next.focus(); e.preventDefault();
  });
  tilt.onclick = () => {
    state.tilt = !state.tilt;
    savePref('tilt', state.tilt ? 'on' : 'off');
    setTilt(state.tilt);
    sync();
  };
  sync();
}

// ---------- theme: the system setting until the visitor picks one with the sun/moon button
function setupTheme() {
  const media = matchMedia('(prefers-color-scheme: dark)');
  const apply = (t) => {
    if (document.documentElement.dataset.theme === t) return;
    document.documentElement.dataset.theme = t;
    setTheme(t);
    syncButton();
    if (state.selected) refresh();                   // chart and bar colors follow the theme
  };
  const button = addMapButton({ className: 'theme-btn', onClick: () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    savePref('theme:v3', next);
    apply(next);
  } });
  function syncButton() {
    const label = document.documentElement.dataset.theme === 'dark' ? 'Use light map' : 'Use dark map';
    button.setAttribute('aria-label', label);
    button.title = label;
  }
  syncButton();
  media.addEventListener('change', () => { if (!pref('theme:v3', null) && !new URLSearchParams(location.search).has('theme')) apply(media.matches ? 'dark' : 'light'); });
}

// ---------- the left sheet: full (320 px) or a 56 px rail; the dek moves onto the map as a card
function setupSheet() {
  const toggle = $('.sheet-toggle');
  const dek = $('#dek');
  const set = (rail, { focus } = {}) => {
    document.body.dataset.sheet = rail ? 'rail' : 'full';
    toggle.setAttribute('aria-expanded', String(!rail));
    (rail ? $('.dek-card') : $('.dek-slot')).append(dek);
    $('.dek-card').hidden = !rail;
    savePref('sheet', rail ? 'rail' : 'full');
    if (focus) focus();
    requestAnimationFrame(() => renderPeriod());
  };
  toggle.onclick = () => { set(true); document.querySelector('[data-rail="search"]').focus(); };
  document.querySelector('[data-rail="search"]').onclick = () => set(false, { focus: () => $('#search').focus() });
  document.querySelector('[data-rail="filters"]').onclick = () => set(false, { focus: () => document.querySelector('#period-presets [aria-checked="true"]')?.focus() });
  set(pref('sheet', 'full') === 'rail');
  // "/" focuses the search box from anywhere but a text field.
  addEventListener('keydown', (e) => {
    if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.target.closest?.('input, select, textarea, [contenteditable]')) return;
    e.preventDefault();
    if (document.body.dataset.sheet === 'rail') set(false);
    $('#search').focus();
  });
}

// ---------- phones (< 768 px): the same pieces, rearranged into a floating search bar, a bottom
// sheet (peek, half, full) and a full-screen filters view (decision #73)
const PHONE_MQ = matchMedia('(max-width: 767px)');
const isPhone = () => PHONE_MQ.matches;
let sheetSnap = 'peek';
function setSnap(snap) {
  sheetSnap = snap;
  const sheet = $('.bsheet');
  sheet.dataset.snap = snap;
  sheet.style.removeProperty('--bs-h');
  document.body.dataset.snap = snap;
  const h = $('.bs-handle');
  h.setAttribute('aria-expanded', String(snap !== 'peek'));
  h.setAttribute('aria-label', snap === 'full' ? 'Show less' : 'Show more');
}
function placeForPhone() {
  const phone = isPhone();
  document.body.dataset.phone = String(phone);
  const search = $('.search'), dek = $('#dek'), areas = $('.areas'), detail = $('.detail');
  if (phone) {
    $('.phone-search-slot').append(search);
    $('.bs-peek').append(areas);
    // The dek leads the peek row: the one-sentence answer is visible without touching anything.
    $('.bs-peek').prepend(dek);
    $('.bs-peek').append($('.progress'));
    $('.bs-foot').before(detail);
    document.body.dataset.sheet = 'full';
    $('.dek-card').hidden = true;
  } else {
    $('.sheet-body .dek-slot').append(dek);
    $('.sheet-body .dek-slot').after($('.progress'));
    $('.progress').after(search);
    $('.chrome-tr').prepend(areas);
    $('.map-wrap').append(detail);
    document.body.dataset.sheet = pref('sheet', 'full') === 'rail' ? 'rail' : 'full';
    if (document.body.dataset.sheet === 'rail') { $('.dek-card').append(dek); $('.dek-card').hidden = false; }
  }
  setSnap(phone && state.selected ? 'half' : 'peek');
}
function setupPhone() {
  placeForPhone();
  PHONE_MQ.addEventListener('change', () => { placeForPhone(); renderPeriod(); });
  // The handle: tap to cycle peek -> half -> full -> peek; drag to any height, then snap.
  const sheet = $('.bsheet');
  const handle = $('.bs-handle');
  let drag = null;
  const start = (e) => {
    if (e.target.closest('.bs-peek button')) return;   // the Areas buttons stay buttons
    drag = { y: e.clientY, h: sheet.getBoundingClientRect().height, moved: false };
    sheet.classList.add('dragging');
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const move = (e) => {
    if (!drag) return;
    const dy = drag.y - e.clientY;
    if (Math.abs(dy) > 6) drag.moved = true;
    const h = Math.max(132, Math.min(innerHeight * 0.92, drag.h + dy));
    sheet.style.setProperty('--bs-h', `${h}px`);
  };
  const end = () => {
    if (!drag) return;
    sheet.classList.remove('dragging');
    const h = sheet.getBoundingClientRect().height;
    const wasTap = !drag.moved;
    drag = null;
    if (wasTap) return;
    handle.dataset.dragged = '1';
    setTimeout(() => delete handle.dataset.dragged, 0);
    const snaps = [['peek', 132], ['half', innerHeight * 0.5], ['full', innerHeight * 0.92]];
    setSnap(snaps.reduce((a, b) => (Math.abs(b[1] - h) < Math.abs(a[1] - h) ? b : a))[0]);
  };
  for (const el of [handle, $('.bs-peek')]) {
    el.addEventListener('pointerdown', start);
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
  }
  handle.addEventListener('click', () => {
    if (handle.dataset.dragged) return;
    setSnap({ peek: 'half', half: 'full', full: 'peek' }[sheetSnap]);
  });
  // Filters: full screen, "Show results" (or Esc, or ×) goes back to the map.
  const opener = $('.filters-open');
  const openFilters = () => {
    document.body.dataset.filters = 'open';
    $('#sheet').setAttribute('role', 'dialog');
    $('#sheet').setAttribute('aria-modal', 'true');
    $('#sheet').setAttribute('aria-labelledby', 'filters-title');
    $('.filters-close').focus();
  };
  const closeFilters = () => {
    delete document.body.dataset.filters;
    $('#sheet').removeAttribute('role');
    $('#sheet').removeAttribute('aria-modal');
    $('#sheet').removeAttribute('aria-labelledby');
    opener.focus();
  };
  opener.onclick = openFilters;
  $('.filters-close').onclick = closeFilters;
  $('.show-results').onclick = closeFilters;
  phoneFilters = { open: () => document.body.dataset.filters === 'open', close: closeFilters };
  // Theme toggle in the filters footer (the map button is hidden on phones)
  const themeBtn = $('.theme-phone');
  const syncTheme = () => { themeBtn.textContent = document.documentElement.dataset.theme === 'dark' ? 'Use light map' : 'Use dark map'; };
  themeBtn.onclick = () => { document.querySelector('.theme-btn')?.click(); syncTheme(); };
  syncTheme();
}
let phoneFilters = null;
/** Phones: the filter button's badge counts the filters changed from the defaults. */
function updateBadge() {
  const b = $('.filters-open .badge');
  if (!b || !meta) return;
  const d = defaultPeriod();
  const n = (state.cats.size !== meta.categories.length ? 1 : 0) + (labelOf(state.period) !== labelOf(d) ? 1 : 0);
  b.hidden = !n;
  b.textContent = String(n);
  $('.filters-open').setAttribute('aria-label', n ? `Filters, ${n} changed` : 'Filters');
}

// ---------- the key's "?": a short explanation, with a link to the about page
function setupKeyHelp() {
  const q = $('#legend-q');
  const box = $('#legend-explain');
  const show = (open) => { box.hidden = !open; q.setAttribute('aria-expanded', String(open)); };
  q.onclick = () => show(box.hidden);
  addEventListener('pointerdown', (e) => { if (!box.hidden && !e.target.closest('.legend')) show(false); });
  return { open: () => !box.hidden, close: () => { show(false); q.focus(); } };
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
  // Theme: set before first paint in index.html (the visitor's choice, else the system setting).
  const theme = document.documentElement.dataset.theme;
  state.view = params.get('view') ?? pref('view', 'hex');
  state.unit2d = pref('unit2d', 'precinct');       // what the 2D view shows: precincts or boroughs
  if (!['hex', 'precincts'].includes(state.view)) state.view = 'hex';
  if (!['precinct', 'borough'].includes(state.unit2d)) state.unit2d = 'precinct';
  state.tilt = pref('tilt', 'on') !== 'off';
  document.body.dataset.view = state.view;
  setupSheet();
  setupPhone();
  setupStrip();
  renderPeriod();

  // The engine (DuckDB, ~35 MB the first time) loads in the background while the map and the
  // controls come up; every query waits for it on its own.
  // If the engine can't start, say so: otherwise every filter would wait for it forever.
  initDb().catch((err) => {
    console.error('[nycmap] the data engine could not start:', err);
    clearStale();
    $('#summary-sub').textContent = 'Filters can\'t be applied right now. Reloading the page usually fixes it.';
  });
  progress(8);
  const boroughsP = loadJson('boroughs.geojson');             // the veil and borough outlines, first thing on the map
  const [metaText, g] = await Promise.all([loadText('meta.json'), loadJson('nta.geojson')]);
  progress(30);
  meta = JSON.parse(metaText);
  ntaGeo = g;
  if (!db.testEngine) await loadStartCache(metaText);   // first map without waiting for the engine
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
  $('#city-total').onclick = (e) => {
    if (state.selected?.kind === 'city') return clearSelection();
    openedBy(e.currentTarget, e.detail === 0);       // detail 0: Enter or Space
    selectCity();
  };
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
    openedBy($('#search'));
    if (it.type === 'point') return selectPoint(it.lngLat, it.label, it.kind === 'corner');
    if (it.type === 'street') return selectStreet(it.id);
    if (it.level === 'borough') return selectBorough(it.code);
    if (it.level === 'precinct') return selectPrecinctNumber(it.code);
    return selectNta(it.code, { move: true });
  }, () => { loadStreets(loadJson); loadCompare(); });
  // Esc closes the innermost thing open: the key's explanation, then the details panel (focus goes
  // back to what opened it).
  addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (keyHelp?.open()) { keyHelp.close(); return; }
    if (helpOpen) { closeHelp({ focus: true }); return; }
    if (phoneFilters?.open()) { phoneFilters.close(); return; }
    if (document.activeElement?.closest('.search') && !$('#search-results').hidden) return;   // search handles its own Esc
    if (state.selected) clearSelection();
  });
  state.cats = new Set(meta.categories.map((c) => c.code));
  renderCategories();
  setupCategoryActions();
  if (state.view === 'precincts') await ensurePrecincts();
  // Map labels are drawn to a canvas atlas once, so the fonts must be ready before the map starts.
  await Promise.all(['600 16px "Newsreader Variable"', '600 12px "Schibsted Grotesk Variable"'].map((f) => document.fonts.load(f).catch(() => null)));
  progress(45);
  const map = await createMap($('#map'), {
    view: state.view,
    tilt: state.tilt,
    theme,
    grid: meta.grid,
    categories: meta.categories,
    hooks: { onLegend: renderLegend, loadPoints, onPick },
  });
  boroughsP.then((geo) => setMask(geo));          // veil and outlines as soon as they arrive, before data
  const [cells, drawn] = await Promise.all([
    query('SELECT DISTINCT q, r FROM hex ORDER BY q, r'),
    query('SELECT cat, sum(n) FILTER (WHERE lt = 0)::INTEGER AS drawn FROM agg_precinct GROUP BY cat'),
  ]);
  state.notMapped = new Set(drawn.filter((d) => !d.drawn).map((d) => d.cat));
  setupTheme();
  setupAreas();
  keyHelp = setupKeyHelp();
  setupHelpMarks();
  loadMonthly();
  renderCategories();
  setUniverse(cells);
  progress(65);
  boroughsP.then((geo) => {
    boroughGeo ??= geo;
    setBoroughShapes(geo, meta.boroughs);           // the 2D view by borough
    if (state.unit2d === 'borough') setUnit2d('borough');
    refresh();
  });
  // The details panel ends above the zoom buttons and credits, whatever their size.
  const brControls = document.querySelector('.maplibregl-ctrl-bottom-right');
  const fitPanel = () => document.documentElement.style.setProperty('--controls-br', `${brControls.offsetHeight + 16}px`);
  new ResizeObserver(fitPanel).observe(brControls);
  fitPanel();
  // Zoom buttons and credits move left of the docked details sheet while it is open.
  const panelWidth = () => document.documentElement.style.setProperty('--panel-w', `${$('.detail').hidden ? 0 : $('.detail').offsetWidth}px`);
  new ResizeObserver(panelWidth).observe($('.detail'));
  new MutationObserver(panelWidth).observe($('.detail'), { attributes: true, attributeFilter: ['hidden'] });
  if (db.testEngine || params.has('hooks')) {     // test mode (or ?hooks with the real engine): hooks for headless tests
    window.__nycmap = map;
    window.__hexStats = hexStats;
    window.__pending = () => pending;
    window.__query = query;
    window.__setSpan = (a, b) => { customOpen = false; setSpan(a, b); };
    window.__select = { city: selectCity, precinct: (pct) => (precinctGeo ? selectPrecinct(precinctUnit(pct)) : selectPrecinctNumber(pct)), borough: selectBorough, nta: selectNta, hex: selectHex, point: selectPoint, spot: selectSpot, street: selectStreet, clear: clearSelection };
  }
  await refresh();
  // If the first map came from the start cache, ask again once the engine is ready (same numbers,
  // but now everything after this comes from the engine), then open the big remote tables.
  whenEngineReady().then(async () => {
    window.__engineReadyAt = Math.round(performance.now());
    console.info(`[nycmap] engine ready: ${window.__engineReadyAt} ms after navigation start`);
    if (db.usedStartCache) await refresh();
    warmRemote();
  });
}

main().catch((err) => {
  console.error(err);
  $('#city-total').textContent = 'The map couldn\'t load its data. Check your connection and reload the page.';
});
