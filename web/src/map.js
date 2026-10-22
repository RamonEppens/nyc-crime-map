// Map: MapLibre basemap + deck.gl overlay.
//   Zoomed out: 3D hexagon columns on the project's own 180 m pointy-top grid (ColumnLayer).
//   Zoomed in (12.5 -> 13.7): columns sink and fade while the complaint locations fade in.
//   Precinct view: flat 2D map, each NYPD precinct filled by its number of complaints.
import { Map, Marker, NavigationControl, AttributionControl, setWorkerUrl } from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import 'maplibre-gl/dist/maplibre-gl.css';
import { MapboxOverlay } from '@deck.gl/mapbox';
import { ColumnLayer, ScatterplotLayer, GeoJsonLayer, SolidPolygonLayer, PathLayer, TextLayer } from '@deck.gl/layers';
import { basemapStyle, PAPER } from './basemap.js';
import { RAMPS, PRECINCT_RAMPS, GROUP_COLORS, rgb, classify, quantileBreaks, niceBreaks, textOn, HEX_PROBS } from './colors.js';
import { fmt } from './format.js';
import { setGrid, hexCenter } from './geo.js';

setWorkerUrl(workerUrl);

// 35° tilt (45° hid too much behind the tallest columns); phones start flat.
const PHONE = matchMedia('(max-width: 767px)').matches;
const TILT = 35;
const VIEW = { center: [-73.965, 40.715], zoom: 11, pitch: PHONE ? 0 : TILT, bearing: -12 };   // Manhattan/Brooklyn
const VIEW_2D = { center: [-73.94, 40.70], zoom: 10.1, pitch: 0, bearing: 0 };     // all five boroughs
const VIEW_MS = 800;                // hexagons <-> precincts cross-fade and camera move
const PAN_LIMITS = [[-74.6, 40.35], [-73.3, 41.05]];
const MAX_HEIGHT_M = 2200;          // tallest column, meters (linear in n / max); color separates the core, height the peaks
const ZOOM_FADE = [12.5, 13.7];     // columns -> points transition
const POINTS_MARGIN = 0.35;         // load points for the view plus 35% on each side

let map;
let overlay;
let tilted = true;                  // Hot spots: tilted (columns) or flat
let attribEl = null;
const NO_HOVER = matchMedia('(hover: none)');      // touch: no tooltips (a tap selects)
let grid;
let theme;
let categories = [];
let hooks = {};
// Hexagons: a fixed "universe" (every hexagon that has ever had a complaint), loaded once in a
// stable order. Filters only change the counts, never the array length or order, so deck.gl can
// interpolate each column's height and color in place (attribute transitions work by index).
const universe = { cells: [], index: new globalThis.Map() };
const state = { hexes: [], maxN: 1, breaks: [], label: '', points: [], pointsBox: null, selection: null,
  view: 'hex', mix: 0, precinctBreaks: [], unit2d: 'precinct', unitMix: 0 };
// Precincts: features loaded once in a fixed order (79: 78 precincts + the merged 105/113/116 area
// used for periods before the 116th existed). Polygons and outlines are flattened once, so color
// changes interpolate in place like the hexagons; each filter only rewrites `units[i].n / shown`.
const precincts = { units: [], polygons: [], paths: [], version: 0 };
// Boroughs: the same 2D view one level up (5 areas). `unit2d` says which set the 2D view shows;
// `unitMix` cross-fades between them (0 = precincts, 1 = boroughs).
const boroughs = { units: [], polygons: [], paths: [], version: 0, breaks: [] };
const BOROUGH_LABELS = {                          // hand-placed: the visual middle of each borough
  1: [-73.966, 40.783], 2: [-73.876, 40.850], 3: [-73.945, 40.650], 4: [-73.815, 40.712], 5: [-74.145, 40.585],
};
const key = (q, r) => q * 10000 + r;
// Offense group whose color the hexagons and precincts take (null = the usual blue).
let tint = null;
// One density hue whatever the offense selection (group colors are for points and the offense list).
const hexRamp = () => RAMPS[theme];
const precinctRamp = () => PRECINCT_RAMPS[theme];
const easeOutCubic = (t) => 1 - (1 - t) ** 3;

export const pointRadius = (n) => Math.min(9, 1.6 + 0.55 * Math.sqrt(n));   // dot radius, px
const smoothstep = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

export async function createMap(container, opts) {
  ({ grid, theme, categories } = opts);
  state.view = opts.view ?? 'hex';
  tilted = opts.tilt !== false && !PHONE;
  state.mix = state.view === 'precincts' ? 1 : 0;
  setGrid(grid);
  hooks = opts.hooks;
  map = new Map({
    container,
    style: await basemapStyle(theme),
    ...(state.view === 'precincts' ? VIEW_2D : { ...VIEW, pitch: tilted ? TILT : 0 }),
    maxBounds: PAN_LIMITS,
    maxPitch: 70,
    attributionControl: false,
  });
  map.addControl(new AttributionControl({ compact: true }), 'bottom-right');
  map.addControl(new NavigationControl({ visualizePitch: true }), 'bottom-right');
  attribEl = container.querySelector('.maplibregl-ctrl-attrib');

  overlay = new MapboxOverlay({ interleaved: false, layers: [], getTooltip: tooltip });
  map.addControl(overlay);

  for (const type of ['dragstart', 'wheel', 'rotatestart', 'pitchstart']) {
    map.on(type, (e) => { if (e.originalEvent) stopFollow(); });   // only the user's own moves
  }
  map.on('style.load', addMask);                  // every basemap swap drops custom layers
  map.on('zoom', render);                         // keeps the column/point transition smooth
  // Clicks: a hexagon column or a location dot selects that hexagon; elsewhere, the neighborhood.
  map.on('click', (e) => {
    const picked = overlay.pickObject({ x: e.point.x, y: e.point.y, radius: 3, layerIds: ['hex', 'points', 'precincts', 'boroughs'] });
    const lngLat = [e.lngLat.lng, e.lngLat.lat];
    if (picked?.layer.id === 'precincts') hooks.onPick?.({ kind: 'precinct', unit: precincts.units[picked.object.u].props });
    else if (picked?.layer.id === 'boroughs') hooks.onPick?.({ kind: 'borough', code: boroughs.units[picked.object.u].props.boro });
    else if (state.view === 'precincts') hooks.onPick?.({ kind: 'none' });
    else if (picked?.layer.id === 'hex' && picked.object.n > 0) hooks.onPick?.({ kind: 'hex', q: picked.object.q, r: picked.object.r });
    else if (picked?.layer.id === 'points') hooks.onPick?.({ kind: 'point', lngLat: [picked.object.lon, picked.object.lat] });
    else hooks.onPick?.({ kind: 'ground', lngLat });
  });
  map.getCanvas().style.cursor = '';
  if (state.view === 'precincts') lockFlat(true);
  map.on('moveend', () => {
    updateBreaks();
    render();
    maybeLoadPoints();
  });
  await new Promise((resolve) => (map.loaded() ? resolve() : map.once('load', resolve)));
  if (state.view === 'precincts') map.fitBounds([[-74.26, 40.495], [-73.70, 40.915]], { padding: padding({ panel: false }), duration: 0 });
  return map;
}

export async function setTheme(next) {
  theme = next;
  map.setStyle(await basemapStyle(theme), { diff: false });
  updateBreaks();
  render();
}

// ---------- outside New York City: the basemap is veiled with paper, so New Jersey, Westchester and
// Long Island stay as context but the five boroughs read first (their labels too).
let maskGeo = null;
/** The five boroughs (GeoJSON); builds the veil: a world rectangle with the boroughs as holes. */
export function setMask(boroughs) {
  const area = (ring) => ring.reduce((a, [x1, y1], i) => { const [x2, y2] = ring[(i + 1) % ring.length]; return a + (x1 * y2 - x2 * y1); }, 0);
  const outer = [[-80, 35], [-68, 35], [-68, 46], [-80, 46], [-80, 35]];
  const sign = Math.sign(area(outer));
  const holes = [];
  for (const f of boroughs.features) {
    const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
    for (const poly of polys) {
      const ring = poly[0];
      holes.push(Math.sign(area(ring)) === sign ? [...ring].reverse() : ring);
    }
  }
  maskGeo = { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [outer, ...holes] } };
  addMask();
}
function addMask() {
  if (!maskGeo || !map || !map.isStyleLoaded()) return;   // 'style.load' calls again
  if (map.getLayer('outside-nyc')) map.removeLayer('outside-nyc');
  if (map.getSource('outside-nyc')) map.removeSource('outside-nyc');
  map.addSource('outside-nyc', { type: 'geojson', data: maskGeo });
  map.addLayer({ id: 'outside-nyc', type: 'fill', source: 'outside-nyc',
    paint: { 'fill-color': PAPER[theme], 'fill-opacity': theme === 'dark' ? 0.62 : 0.66 } });
  // Borough outlines: there from the first frame, before any data (context while loading).
  if (map.getLayer('nyc-outline')) map.removeLayer('nyc-outline');
  map.addLayer({ id: 'nyc-outline', type: 'line', source: 'outside-nyc',
    paint: { 'line-color': `rgb(${TOKENS.muted[theme].join(',')})`, 'line-width': 0.75, 'line-opacity': 0.5 } });
}

/** Precinct boundaries (GeoJSON FeatureCollection). Call once. */
export function setPrecinctShapes(geo) {
  precincts.units = geo.features.map((f) => ({ props: f.properties, n: 0, shown: false }));
  precincts.polygons = [];
  precincts.paths = [];
  geo.features.forEach((f, u) => {
    const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
    for (const rings of polys) {
      precincts.polygons.push({ u, polygon: rings });
      for (const ring of rings) precincts.paths.push({ u, path: ring });
    }
  });
}

/** counts: Map pct -> n for the current filters; merged: draw 105/113/116 as one area. */
/** counts: Map pct -> n for the current filters; merged: draw 105/113/116 as one area;
 *  pop: Map pct -> residents (2020 Census); years: length of the period in years.
 *  Fill = complaints per 1,000 residents per year; precincts under 2,000 residents are not rated. */
export const FEW_RESIDENTS = 2000;
export function setPrecincts(counts, merged, { pop = new globalThis.Map(), years = 1 } = {}) {
  for (const unit of precincts.units) {
    const { pct, merged: parts } = unit.props;
    const members = parts ?? [pct];
    if (parts) unit.shown = merged;
    else unit.shown = !(merged && precincts.units.some((x) => x.props.merged?.includes(pct)));
    unit.n = members.reduce((t, p) => t + (counts.get(p) ?? 0), 0);
    unit.pop = members.reduce((t, p) => t + (pop.get(p) ?? 0), 0);
    unit.few = unit.pop < FEW_RESIDENTS;
    unit.rate = unit.few ? null : (unit.n / unit.pop) * 1000 / years;
  }
  precincts.version++;
  state.precinctBreaks = niceBreaks(precincts.units.filter((x) => x.shown && !x.few).map((x) => x.rate));
  if (state.view === 'precincts') updateBreaks();
  render();
}

/** Borough boundaries (GeoJSON with properties.boro 1-5) and their names by code. Call once. */
export function setBoroughShapes(geo, names) {
  boroughs.units = geo.features.map((f) => ({
    props: { ...f.properties, name: names[f.properties.boro], label: BOROUGH_LABELS[f.properties.boro] }, n: 0, shown: true }));
  boroughs.polygons = [];
  boroughs.paths = [];
  geo.features.forEach((f, u) => {
    const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
    for (const rings of polys) {
      boroughs.polygons.push({ u, polygon: rings });
      for (const ring of rings) boroughs.paths.push({ u, path: ring });
    }
  });
}
/** counts: Map boro (1-5) -> n. Five areas get five classes: each borough its own shade, by rank. */
/** counts: Map boro -> n; pop: Map boro -> residents. Same rate and same city-wide breaks as the
 *  precincts (five areas in five classes would only be a ranking); the value is written on each. */
export function setBoroughs(counts, { pop = new globalThis.Map(), years = 1 } = {}) {
  for (const unit of boroughs.units) {
    unit.n = counts.get(unit.props.boro) ?? 0;
    unit.pop = pop.get(unit.props.boro) ?? 0;
    unit.rate = unit.pop ? (unit.n / unit.pop) * 1000 / years : null;
  }
  boroughs.version++;
  render();
}
/** 'precinct' or 'borough': which areas the 2D view shows (cross-fade). */
export function setUnit2d(unit) {
  if (unit === state.unit2d) return;
  state.unit2d = unit;
  const from = state.unitMix;
  const to = unit === 'borough' ? 1 : 0;
  const start = performance.now();
  const step = (now) => {
    const t = Math.min(1, (now - start) / 500);
    state.unitMix = from + (to - from) * (1 - (1 - t) ** 3);
    render();
    if (t < 1 && state.unit2d === unit) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
  updateBreaks();
}
export const unit2d = () => state.unit2d;

/** Unit shown for a precinct number right now (the merged area when it applies), or null. */
export function precinctUnit(pct) {
  return precincts.units.find((x) => x.shown && (x.props.pct === pct || x.props.merged?.includes(pct)))?.props ?? null;
}

/** 'hex' (3D hexagons) or 'precincts' (flat, by NYPD precinct): cross-fade and move the camera. */
export function setView(view, { tilt = tilted } = {}) {
  tilted = tilt;
  if (view === state.view) return;
  state.view = view;
  const from = state.mix;
  const to = view === 'precincts' ? 1 : 0;
  const start = performance.now();
  const step = (now) => {
    const t = Math.min(1, (now - start) / VIEW_MS);
    const e = t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2;     // ease in-out cubic
    state.mix = from + (to - from) * e;
    render();
    if (t < 1 && state.view === view) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
  if (view === 'precincts') {
    lockFlat(true);
    // All five boroughs on entry (Staten Island and the Bronx were cut off).
    map.fitBounds([[-74.26, 40.495], [-73.70, 40.915]], { padding: padding({ panel: false }), pitch: 0, bearing: 0, duration: motion(VIEW_MS) });
  } else {
    lockFlat(false);
    map.easeTo({ pitch: tilted && !PHONE ? TILT : 0, bearing: tilted ? VIEW.bearing : 0, duration: motion(VIEW_MS) });
  }
  updateBreaks();
}

/** Hot spots tilted (35°, columns) or flat (seen from above). */
export function setTilt(on) {
  tilted = on;
  if (state.view !== 'hex') return;
  map.easeTo({ pitch: on ? TILT : 0, duration: motion(700) });
}

/** A button in the bottom-right control stack, under zoom and compass and above the credits. */
export function addMapButton({ className, onClick }) {
  const box = document.createElement('div');
  box.className = 'maplibregl-ctrl maplibregl-ctrl-group';
  const button = document.createElement('button');
  button.type = 'button';
  button.className = className;
  button.innerHTML = '<span class="maplibregl-ctrl-icon" aria-hidden="true"></span>';
  button.onclick = onClick;
  box.append(button);
  map.addControl({ onAdd: () => box, onRemove: () => box.remove() }, 'bottom-right');
  if (attribEl) attribEl.before(box);
  return button;
}

const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
const motion = (ms) => (reduceMotion.matches ? 0 : ms);

/** The precinct view is a flat map: no tilting or rotating. */
function lockFlat(flat) {
  if (flat) { map.dragRotate.disable(); map.touchZoomRotate.disableRotation(); map.keyboard.disableRotation(); }
  else { map.dragRotate.enable(); map.touchZoomRotate.enableRotation(); map.keyboard.enableRotation(); }
}

/** cells: [{q, r}] for every hexagon in the data, sorted by (q, r). Call once. */
export function setUniverse(cells) {
  universe.cells = cells.map(({ q, r }) => {
    const [lon, lat] = hexCenter(q, r);
    return { q, r, lon, lat };
  });
  universe.index = new globalThis.Map(universe.cells.map((c, i) => [key(c.q, c.r), i]));
}

/** rows: [{q, r, n}] for the current filters. Builds a NEW array over the whole universe:
 *  hexagons without complaints stay in it with n = 0 (transparent, height 0). */
export function setHexagons(rows, label) {
  const hexes = universe.cells.map((c) => ({ q: c.q, r: c.r, lon: c.lon, lat: c.lat, n: 0 }));
  let max = 1;
  for (const { q, r, n } of rows) {
    const i = universe.index.get(key(q, r));
    if (i === undefined) continue;
    hexes[i].n = n;
    if (n > max) max = n;
  }
  state.hexes = hexes;
  state.maxN = max;
  if (!grown) growIn();
  state.label = label;
  // City-wide breaks, once per filter: a hexagon keeps its color when the map is panned.
  state.breaks = niceBreaks(hexes.map((d) => d.n), 6, HEX_PROBS);
  updateBreaks();
  render();
  state.pointsBox = null;                        // filters changed: points must be reloaded
  maybeLoadPoints();
}

// The first data grows in once (650 ms): columns rise from the ground. Later filters animate in
// place (attribute transitions); reduced motion gets the final state at once.
let grown = false;
let grow = 1;
function growIn() {
  grown = true;
  if (reduceMotion.matches) return;
  const start = performance.now();
  grow = 0;
  const step = (now) => {
    const t = Math.min(1, (now - start) / 650);
    grow = easeOutCubic(t);
    render();
    if (t < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

/** Offense group to color the map with ('person', 'property', ...) or null for blue. Takes effect
 *  on the next setHexagons / setPrecincts, so colors and counts change in the same transition. */
export function setTint(group) {
  tint = group;
}

/** Outline of the current selection (GeoJSON Feature) or null. */
/** What is selected, drawn in brand green over everything else (depthCompare: always):
 *  style 'outline' (hexagon), 'area' (outline + light fill), 'circle' (200 m radius, light fill),
 *  'line' (a whole street, 5 px with round ends). */
export function setSelection(feature, style = 'outline', label = null) {
  state.selection = feature;
  state.selectionStyle = style;
  state.selectionLabel = feature && label ? { text: label, position: labelPoint(feature, style) } : null;
  state.highlight = null;
  stopFollow();
  render();
}

// Where the name of the selection is written on the map: above a circle or hexagon, at the middle
// vertex of a street, at the visual middle (bounding-box center) of an area.
function labelPoint(feature, style) {
  const g = feature.geometry;
  if (g.type === 'MultiLineString') {
    const lines = g.coordinates;
    const longest = lines.reduce((a, b) => (b.length > a.length ? b : a), lines[0]);
    return longest[Math.floor(longest.length / 2)];
  }
  let w = 180, s = 90, e = -180, n = -90;
  const walk = (c) => (typeof c[0] === 'number' ? (w = Math.min(w, c[0]), e = Math.max(e, c[0]), s = Math.min(s, c[1]), n = Math.max(n, c[1])) : c.forEach(walk));
  walk(g.coordinates);
  return style === 'circle' || style === 'outline' || style === 'ring' ? [(w + e) / 2, n] : [(w + e) / 2, (s + n) / 2];
}
const isArea = (f) => /Polygon/.test(f?.geometry?.type ?? '');
const HIGHLIGHTER = [255, 205, 40];             // highlighter-pen yellow (#FFCD28)
// Neutral tokens (same values as styles.css), as RGB for deck.gl.
const TOKENS = {
  paper: { light: [244, 245, 242], dark: [17, 20, 23] },     // --paper (map land)
  ink: { light: [16, 23, 31], dark: [236, 238, 234] },       // --ink
  sheet2: { light: [239, 240, 236], dark: [41, 46, 51] },    // --sheet-2 / dark --sheet-3
  muted: { light: [88, 96, 105], dark: [160, 167, 174] },    // --muted
};
const tk = (name) => TOKENS[name][theme];

/** One block of the selected street, lit while the pointer is over it in a chart (null = none). */
export function setHighlight(feature) {
  state.highlight = feature;
  document.body.dataset.highlight = feature ? 'on' : '';
  render();
}

// Pin for an address or corner: a DOM marker, so it stays sharp and above the canvas.
let pin;
export function setPin(lngLat) {
  if (!lngLat) { pin?.remove(); pin = null; return; }
  if (!pin) {
    const el = document.createElement('div');
    el.className = 'map-pin';
    el.setAttribute('aria-hidden', 'true');
    el.innerHTML = '<svg viewBox="0 0 26 34"><path class="drop" d="M13 33C13 33 2 20.5 2 12.5a11 11 0 0 1 22 0C24 20.5 13 33 13 33z"/><circle class="eye" cx="13" cy="12.5" r="4"/></svg>';
    pin = new Marker({ element: el, anchor: 'bottom' });
  }
  pin.setLngLat(lngLat).addTo(map);
}

/** Camera padding that keeps clear of the left sheet and the details panel (both may change). */
function padding({ panel: assumePanel = true } = {}) {
  const sheet = document.querySelector('.bsheet');
  if (matchMedia('(max-width: 767px)').matches && sheet) {          // phones: keep clear of the bottom sheet
    // Details open at half height: keep the place in the map above the sheet.
    return { top: 80, bottom: innerHeight * 0.5 + 16, left: 24, right: 24 };
  }
  const left = (document.querySelector('.controls')?.getBoundingClientRect().right ?? 0) + 40;
  const panel = document.querySelector('.detail');
  // Selections open the panel, so fit as if it were there already (380 px), even on the first one.
  const right = (panel && !panel.hidden ? panel.offsetWidth : assumePanel ? 380 : 0) + 60;
  const w = map.getContainer().clientWidth;
  if (left + right > w - 120) return { top: 60, bottom: 60, left: 20, right: 20 };   // phones: the sheet is below
  return { top: 70, bottom: 70, left, right };
}
/** Fly to a point (addresses, corners): close enough that the map shows complaint locations. */
export function flyToPoint(lngLat, zoom = 15.8, duration = 1800) {
  // An offset, not padding: MapLibre keeps a flyTo padding and adds it to the next fitBounds,
  // which then cannot fit and silently does nothing.
  const p = padding();
  map.flyTo({ center: lngLat, zoom, duration: motion(Math.min(duration, 1500)), offset: [(p.left - p.right) / 2, (p.top - p.bottom) / 2], essential: true });
}
/** Fit a box [[w, s], [e, n]] (streets, areas). */
export function fitTo(bounds, { maxZoom = 15, duration = 1600 } = {}) {
  map.fitBounds(bounds, { padding: padding(), maxZoom, duration: motion(Math.min(duration, 1500)), pitch: map.getPitch(), bearing: map.getBearing() });
}

/** Move the camera to show a bounding box [[w, s], [e, n]] without changing pitch or bearing. */
export function showBounds(bounds) {
  map.fitBounds(bounds, { padding: padding(), maxZoom: 14,
    pitch: map.getPitch(), bearing: map.getBearing(), duration: motion(900) });
}

// ---------- follow camera: while the pointer moves along a chart, the map glides to each block it
// lights, like a camera following a car; when the pointer leaves the chart it glides back.
const FOLLOW_ZOOM = 15;           // about two kilometres across the free part of the map: the block plus its surroundings
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
let followHome = null;            // camera before following started; null = not following
let followTimer = 0;
let returnTimer = 0;

/** The free part of the map, between the left column and the details panel: its width, and the
 *  horizontal offset that centres a point in it. */
function freeArea() {
  const width = map.getContainer().clientWidth;
  const left = document.querySelector('.controls')?.getBoundingClientRect().right ?? 0;
  const panel = document.querySelector('.detail');
  const right = panel && !panel.hidden ? panel.getBoundingClientRect().left : width;
  return { width: Math.max(200, right - left), offset: [Math.round((left + right) / 2 - width / 2), 0] };
}

/** Glide to a box [[w, s], [e, n]] (the hovered block or neighborhood): the whole box in the free
 *  part of the map, but never closer than maxZoom. Rapid sweeps are coalesced so it doesn't stutter. */
export function followTo(box, { maxZoom = FOLLOW_ZOOM } = {}) {
  clearTimeout(returnTimer);
  if (!followHome) {
    followHome = { center: map.getCenter(), zoom: map.getZoom(), pitch: map.getPitch(), bearing: map.getBearing() };
  }
  clearTimeout(followTimer);
  followTimer = setTimeout(() => {
    const [[w, s], [e, n]] = box;
    const free = freeArea();
    const side = Math.max(40, (map.getContainer().clientWidth - free.width) / 2 + 40);   // zoom only; centring is the offset
    const fit = map.cameraForBounds(box, { padding: { top: 90, bottom: 90, left: side, right: side } });
    const zoom = Math.min(maxZoom, fit?.zoom ?? maxZoom);
    map.easeTo({
      center: [(w + e) / 2, (s + n) / 2], zoom, offset: free.offset,
      duration: reducedMotion.matches ? 0 : 650, essential: true,
    });
  }, 60);
}

/** The pointer left the block: unless it lands on another one soon, glide back to where we were. */
export function followEnd() {
  clearTimeout(followTimer);
  clearTimeout(returnTimer);
  if (!followHome) return;
  returnTimer = setTimeout(() => {
    const home = followHome;
    followHome = null;
    map.easeTo({ ...home, duration: reducedMotion.matches ? 0 : 900, essential: true });
  }, 500);
}

/** Forget the return trip (a new selection, or the user moved the map themselves). */
function stopFollow() {
  clearTimeout(followTimer);
  clearTimeout(returnTimer);
  followHome = null;
}

/** For tests: size of the hexagon array, hexagons with data, and the array itself (identity). */
export function hexStats() {
  return { length: state.hexes.length, withData: state.hexes.filter((d) => d.n > 0).length,
    first: state.hexes[0] && [state.hexes[0].lon, state.hexes[0].lat], breaks: state.breaks };
}

/** Quantile breaks over the hexagons currently in view; the legend is updated to match. */
/** Tell the key which classes the map is showing (they change only with the filters). */
function updateBreaks() {
  if (state.view === 'precincts') {
    hooks.onLegend?.({ ramp: precinctRamp(), breaks: state.precinctBreaks, unit: state.unit2d, rate: true,
      few: state.unit2d === 'precinct' && precincts.units.some((u) => u.shown && u.few) });
    return;
  }
  if (state.pointsKey) {
    hooks.onLegend?.({ points: true, groups: GROUP_COLORS, radius: pointRadius });
    return;
  }
  hooks.onLegend?.({ ramp: hexRamp(), breaks: state.breaks, unit: 'hexagon', rate: false });
}

function viewBox(margin) {
  const b = map.getBounds();
  const dx = (b.getEast() - b.getWest()) * margin;
  const dy = (b.getNorth() - b.getSouth()) * margin;
  return [b.getWest() - dx, b.getSouth() - dy, b.getEast() + dx, b.getNorth() + dy];
}

async function maybeLoadPoints() {
  if (state.view === 'precincts' || map.getZoom() < ZOOM_FADE[0] || !hooks.loadPoints) return;
  const box = viewBox(POINTS_MARGIN);
  const held = state.pointsBox;
  if (held && box[0] >= held[0] && box[1] >= held[1] && box[2] <= held[2] && box[3] <= held[3]) return;
  const wanted = viewBox(POINTS_MARGIN * 2);      // fetch a bit more than needed to pan freely
  state.pointsBox = wanted;
  const rows = await hooks.loadPoints(wanted);
  if (state.pointsBox !== wanted) return;         // a newer request replaced this one
  state.points = rows;
  render();
}

function render() {
  if (!overlay) return;
  const m = smoothstep(ZOOM_FADE[0], ZOOM_FADE[1], map.getZoom());
  const ramp = hexRamp().map(rgb);
  const k = 1 - state.mix;                          // 1 = hexagon view, 0 = precinct view
  // The key follows the encoding: dots once they are the more opaque layer (zoom ~13.1).
  const pointsKey = m >= 0.5 && k > 0.5;
  if (pointsKey !== !!state.pointsKey) { state.pointsKey = pointsKey; updateBreaks(); }
  const columns = new ColumnLayer({
    id: 'hex',
    data: state.hexes,
    getPosition: (d) => [d.lon, d.lat],
    diskResolution: 6,                 // hexagon
    angle: 90,                         // vertex up: matches the pointy-top grid
    radius: grid.side,                 // circumradius = grid side, so neighbors share edges
    coverage: 1,
    extruded: true,
    getElevation: (d) => (d.n / state.maxN) * MAX_HEIGHT_M,
    elevationScale: (1 - m) ** 1.6 * k * grow,
    getFillColor: (d) => (d.n > 0 ? [...ramp[classify(d.n, state.breaks)], 235] : [0, 0, 0, 0]),
    opacity: 0.95 * (1 - m) ** 1.3 * k * Math.min(1, grow * 1.6),
    material: { ambient: 0.6, diffuse: 0.5, shininess: 20, specularColor: [30, 30, 30] },
    visible: m < 1 && k > 0,
    pickable: m < 0.5 && k > 0.5,
    autoHighlight: true,
    highlightColor: [...TOKENS.paper.light, 70],
    transitions: {
      getElevation: { duration: 700, easing: easeOutCubic },
      getFillColor: { duration: 450 },
    },
    updateTriggers: { getFillColor: `${state.breaks.join(',')}|${theme}|${tint}`, getElevation: state.maxN },
  });
  const points = new ScatterplotLayer({
    id: 'points',
    data: state.points,
    getPosition: (d) => [d.lon, d.lat],
    radiusUnits: 'pixels',
    getRadius: (d) => pointRadius(d.n),            // area grows with the count
    getFillColor: (d) => rgb(GROUP_COLORS[categories[d.cat]?.group ?? 'other']),
    stroked: true,
    getLineColor: tk('paper'),                       // 1 px casing in the land color
    lineWidthUnits: 'pixels',
    getLineWidth: 1,
    opacity: 0.9 * m * k,
    visible: m > 0 && k > 0,
    pickable: m >= 0.5 && k > 0.5,
    parameters: { depthCompare: 'always' },   // drawn over the sinking columns, never hidden by them
  });
  // Selection: an ink line with a paper casing underneath, the way cartographers draw a route over
  // a busy map. Readable over pale and deep columns alike, and it never glows. Night inverts it.
  const style = state.selectionStyle;
  const ink = tk('ink');
  const casingRgb = tk('paper');
  const width = style === 'line' ? 3 : 2;
  const selData = state.selection ? [state.selection] : [];
  const casing = new GeoJsonLayer({
    id: 'selection-casing',
    data: selData,
    stroked: true,
    filled: false,
    getLineColor: [...casingRgb, 235],
    lineWidthUnits: 'pixels',
    getLineWidth: width + 4,
    lineCapRounded: true,
    lineJointRounded: true,
    parameters: { depthCompare: 'always' },
    updateTriggers: { getLineColor: theme, getLineWidth: style },
  });
  const outline = new GeoJsonLayer({
    id: 'selection',
    data: selData,
    stroked: true,
    filled: style === 'area',
    getFillColor: [...ink, style === 'circle' ? 22 : 14],
    getLineColor: [...ink, 255],
    lineWidthUnits: 'pixels',
    getLineWidth: width,
    lineCapRounded: true,
    lineJointRounded: true,
    parameters: { depthCompare: 'always' },
    updateTriggers: { getFillColor: [style, theme], getLineColor: theme, getLineWidth: style },
  });
  // Highlight (hovering a block or neighborhood in a chart): a highlighter-pen yellow with an ink
  // edge, on top of everything. Yellow is used nowhere else, so it always means "this one".
  const hl = state.highlight;
  const area = isArea(hl);
  const highlightEdge = hl && new GeoJsonLayer({
    id: 'highlight-edge',
    data: [hl],
    stroked: true,
    filled: false,
    getLineColor: [...ink, 230],
    lineWidthUnits: 'pixels',
    getLineWidth: area ? 5 : 11,
    lineCapRounded: true,
    lineJointRounded: true,
    parameters: { depthCompare: 'always' },
    updateTriggers: { getLineColor: theme, getLineWidth: hl },
  });
  const highlight = hl && new GeoJsonLayer({
    id: 'highlight',
    data: [hl],
    stroked: true,
    filled: area,
    getLineColor: [...HIGHLIGHTER, 255],
    getFillColor: [...HIGHLIGHTER, 70],
    lineWidthUnits: 'pixels',
    getLineWidth: area ? 3 : 8,
    lineWidthMinPixels: area ? 3 : 8,
    lineCapRounded: true,
    lineJointRounded: true,
    parameters: { depthCompare: 'always' },
    updateTriggers: { getLineWidth: hl },
  });
  // The selection's name, set on the map in the headline serif, with a thin paper halo (ink on the
  // light map, paper text with an ink halo on the dark one).
  const around = state.selectionStyle === 'circle' || state.selectionStyle === 'outline' || state.selectionStyle === 'ring';
  const label = state.selectionLabel ? haloText({
    id: 'selection-label', data: [state.selectionLabel], mix: 1, pale: () => theme === 'dark',
    triggers: `${theme}|${state.selectionLabel.text}|${state.selectionStyle}`, text: (d) => d.text, serif: true, size: 16,
    dy: around ? -12 : 0, baseline: around ? 'bottom' : 'center',
  }) : [];
  // An address or corner: no grey fill inside the 200 m circle (the dots keep their true colors);
  // the outside is veiled at 25% instead.
  const veil = state.selection && state.selectionStyle === 'circle' && state.selection.geometry.type === 'Polygon' && new SolidPolygonLayer({
    id: 'selection-veil',
    data: [{ polygon: [[[-74.6, 40.3], [-73.3, 40.3], [-73.3, 41.1], [-74.6, 41.1]], state.selection.geometry.coordinates[0]] }],
    getPolygon: (d) => d.polygon,
    getFillColor: [...tk('paper'), 64],
    parameters: { depthCompare: 'always' },
    updateTriggers: { getFillColor: theme },
  });
  overlay.setProps({ layers: [columns, points, ...precinctLayers(), veil, casing, outline, ...label, highlightEdge, highlight].filter(Boolean) });
}

function precinctLayers() {
  return [...precinctSet(state.mix * (1 - state.unitMix)), ...boroughSet(state.mix * state.unitMix)];
}

function precinctSet(mix) {
  if (mix <= 0 || !precincts.units.length) return [];
  const ramp = precinctRamp().map(rgb);
  const { units, version } = precincts;
  const triggers = `${version}|${state.precinctBreaks.join(',')}|${theme}`;
  const fewFill = [...tk('sheet2'), 235];
  const fills = new SolidPolygonLayer({
    id: 'precincts',
    data: precincts.polygons,
    getPolygon: (d) => d.polygon,
    getFillColor: (d) => {
      const u = units[d.u];
      if (!u.shown) return [0, 0, 0, 0];
      return u.few ? fewFill : [...ramp[classify(u.rate, state.precinctBreaks)], 225];
    },
    opacity: mix,
    pickable: mix > 0.5,
    autoHighlight: true,
    highlightColor: [...TOKENS.paper.light, 60],
    transitions: { getFillColor: { duration: 450 } },
    updateTriggers: { getFillColor: triggers },
  });
  const borders = new PathLayer({
    id: 'precinct-borders',
    data: precincts.paths,
    getPath: (d) => d.path,
    getColor: (d) => (units[d.u].shown ? [...tk('paper'), 255] : [0, 0, 0, 0]),
    widthUnits: 'pixels',
    getWidth: 1.2,
    opacity: mix,
    updateTriggers: { getColor: triggers },
  });
  // Few residents (parks, airports…): not rated; a diagonal hatch instead, drawn as lines clipped
  // to the area (computed once per filter: only a handful of precincts).
  const few = new PathLayer({
    id: 'precinct-few',
    data: hatchLines(),
    getPath: (d) => d,
    getColor: [...tk('muted'), theme === 'dark' ? 200 : 170],
    widthUnits: 'pixels',
    getWidth: 1.2,
    opacity: mix,
    updateTriggers: { getColor: theme },
  });
  // Numbers in ink or paper, whichever contrasts more with the fill, with a halo of the other
  // (two layers, because the halo color is per layer).
  const paperText = (d) => textOn(precinctRamp()[classify(d.rate, state.precinctBreaks)]) === 'paper';
  const numberLayer = (id, pale) => new TextLayer({
    id,
    data: units.filter((x) => x.shown && !x.few && paperText(x) === pale),
    getPosition: (d) => d.props.label,
    getText: (d) => String(d.props.merged ? d.props.merged.join('·') : d.props.pct),
    getSize: 12,
    fontFamily: '"Schibsted Grotesk Variable", system-ui, sans-serif',
    fontWeight: 600,
    characterSet: 'auto',
    fontSettings: { sdf: true, fontSize: 64, buffer: 8 },
    getColor: pale ? [...TOKENS.paper.light, 255] : [...TOKENS.ink.light, 255],
    outlineWidth: 2.5,
    outlineColor: pale ? [...TOKENS.ink.light, 190] : [...TOKENS.paper.light, 200],
    opacity: mix,
    visible: map.getZoom() >= 10.3,
    updateTriggers: { getText: version },
  });
  const labels = [numberLayer(`precinct-labels-ink-${triggers}`, false), numberLayer(`precinct-labels-paper-${triggers}`, true)];
  // Labels on the hatch get a halo in the land color, so they read over the lines.
  const fewLabels = new TextLayer({
    id: 'precinct-few-labels',
    data: units.filter((x) => x.shown && x.few),
    getPosition: (d) => d.props.label,
    getText: (d) => `${d.props.pct}\nFew residents`,
    getSize: 12,
    lineHeight: 1.2,
    fontFamily: '"Schibsted Grotesk Variable", system-ui, sans-serif',
    fontWeight: 600,
    characterSet: 'auto',
    fontSettings: { sdf: true, fontSize: 64, buffer: 8 },
    outlineWidth: 3,
    outlineColor: [...tk('paper'), 255],
    getColor: [...tk('ink'), 255],
    opacity: mix,
    visible: map.getZoom() >= 10.3,
    updateTriggers: { getText: version },
  });
  return [fills, few, borders, ...labels, fewLabels];
}

/** Diagonal lines (every ~120 m) clipped to the precincts with few residents. */
let hatchCache = { key: '', lines: [] };
function hatchLines() {
  const shown = precincts.polygons.filter((d) => precincts.units[d.u].shown && precincts.units[d.u].few);
  const key = `${precincts.version}|${shown.length}`;
  if (hatchCache.key === key) return hatchCache.lines;
  const k = Math.cos((40.7 * Math.PI) / 180);        // local meters: x = lon·k, y = lat
  const step = 120 / 111320;                         // line spacing, degrees of latitude
  const lines = [];
  for (const { polygon } of shown) {
    const rings = polygon.map((r) => r.map(([x, y]) => [x * k, y]));
    const xs = rings.flat().map((p) => p[0]), ys = rings.flat().map((p) => p[1]);
    const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    // Lines y = x + c (45°); c runs over the box.
    for (let c = y0 - x1; c <= y1 - x0; c += step) {
      const ts = [];
      for (const ring of rings) {
        for (let i = 0; i < ring.length - 1; i++) {
          const [ax, ay] = ring[i], [bx, by] = ring[i + 1];
          const fa = ay - ax - c, fb = by - bx - c;   // sign change = crossing
          if ((fa > 0) !== (fb > 0)) { const t = fa / (fa - fb); ts.push(ax + (bx - ax) * t); }
        }
      }
      ts.sort((p, q) => p - q);
      for (let i = 0; i + 1 < ts.length; i += 2) {
        lines.push([[ts[i] / k, ts[i] + c], [ts[i + 1] / k, ts[i + 1] + c]]);
      }
    }
  }
  hatchCache = { key, lines };
  return lines;
}

/** Crisp text with a thin halo: a bitmap atlas (no SDF blur) drawn eight times, 1.25 px around, in
 *  the halo tone, then once on top. `pale(d)`: paper text with an ink halo; otherwise the reverse. */
function haloText({ id, data, mix, pale, triggers, text, serif, size, dy = 0, anchor = 'middle', baseline = 'center' }) {
  const common = {
    data, getPosition: (d) => d.position ?? d.props.label, getText: text, getSize: size,
    fontFamily: serif ? '"Newsreader Variable", Georgia, serif' : '"Schibsted Grotesk Variable", system-ui, sans-serif',
    fontWeight: 600, characterSet: 'auto', fontSettings: { sdf: false, fontSize: 64, buffer: 4 },
    getTextAnchor: anchor, getAlignmentBaseline: baseline, opacity: mix, parameters: { depthCompare: 'always' },
    updateTriggers: { getText: triggers, getColor: triggers, getPixelOffset: triggers },
  };
  const r = 1.25;
  const rings = [[r, 0], [-r, 0], [0, r], [0, -r], [r, r], [-r, r], [r, -r], [-r, -r]].map(([x, y], i) => new TextLayer({
    ...common, id: `${id}-halo-${i}`, getPixelOffset: (d) => [x, y + (typeof dy === 'function' ? dy(d) : dy)],
    getColor: (d) => (pale(d) ? [...TOKENS.ink.light, 150] : [...TOKENS.paper.light, 200]),
  }));
  return [...rings, new TextLayer({
    ...common, id, getPixelOffset: (d) => [0, typeof dy === 'function' ? dy(d) : dy],
    getColor: (d) => (pale(d) ? [...TOKENS.paper.light, 255] : [...TOKENS.ink.light, 255]),
  })];
}

/** The five boroughs: same look as the precincts, with the name and the count written inside. */
function boroughSet(mix) {
  if (mix <= 0 || !boroughs.units.length) return [];
  const ramp = precinctRamp().map(rgb);
  const { units, version } = boroughs;
  const breaks = state.precinctBreaks;
  const triggers = `${version}|${breaks.join(',')}|${theme}`;
  const fills = new SolidPolygonLayer({
    id: 'boroughs',
    data: boroughs.polygons,
    getPolygon: (d) => d.polygon,
    getFillColor: (d) => (units[d.u].rate == null ? [0, 0, 0, 0] : [...ramp[classify(units[d.u].rate, breaks)], 225]),
    opacity: mix,
    pickable: mix > 0.5,
    autoHighlight: true,
    highlightColor: [...TOKENS.paper.light, 60],
    transitions: { getFillColor: { duration: 450 } },
    updateTriggers: { getFillColor: triggers },
  });
  // No outlines: the borough file is a union of many pieces whose shared edges would show as
  // stray lines; boroughs are told apart by their fills and the water between them.
  // Two lines, crisp (bitmap atlases; an SDF halo blurred the serif): the name in Newsreader 16 and
  // the rate in Schibsted 14 under it, in ink or paper by the fill, with a thin halo of the other.
  const pale = (d) => d.rate != null && textOn(precinctRamp()[classify(d.rate, breaks)]) === 'paper';
  const name = haloText({ id: 'borough-name', data: units, mix, pale, triggers: `${version}|${triggers}`,
    text: (d) => d.props.name, serif: true, size: 16, dy: -9 });
  const value = haloText({ id: 'borough-value', data: units, mix, pale, triggers: `${version}|${triggers}`,
    text: (d) => (d.rate == null ? '' : `${d.rate.toFixed(1)} per 1,000 residents`), serif: false, size: 14, dy: 9 });
  const halo = [...name, ...value];
  const labels = [];
  return [fills, ...halo, ...labels];
}

export const precinctName = (props) => (props.merged
  ? `${props.merged.slice(0, -1).map(ordinal).join(', ')} and ${ordinal(props.merged.at(-1))} Precincts`
  : `${ordinal(props.pct)} Precinct`);
function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] || s[v] || s[0]}`;
}

function tooltip({ object, layer }) {
  if (NO_HOVER.matches) return null;               // touch: one tap selects, no tooltip
  if (layer?.id === 'precincts' && object) {
    const unit = precincts.units[object.u];
    return { className: 'deck-tooltip',
      html: `<strong>${precinctName(unit.props)}</strong><br>${fmt(unit.n)} complaint${unit.n === 1 ? '' : 's'} in ${state.label}<br>${unit.few
        ? 'Few residents: not rated per resident' : `${unit.rate.toFixed(1)} per 1,000 residents a year`}<span class="tip-hint">Click for details</span>` };
  }
  if (layer?.id === 'boroughs' && object) {
    const unit = boroughs.units[object.u];
    return { className: 'deck-tooltip',
      html: `<strong>${unit.props.name}</strong><br>${fmt(unit.n)} complaint${unit.n === 1 ? '' : 's'} in ${state.label}<br>${unit.rate?.toFixed(1)} per 1,000 residents a year<span class="tip-hint">Click for details</span>` };
  }
  if (!object || !object.n) return null;
  if (layer.id === 'hex') {
    return { className: 'deck-tooltip', html: `<strong>${fmt(object.n)}</strong> complaints<br>${state.label}<span class="tip-hint">Click for details</span>` };
  }
  return {
    className: 'deck-tooltip',
    html: `<strong>${fmt(object.n)}</strong> complaint${object.n === 1 ? '' : 's'} recorded at this location in ${state.label}<span class="tip-hint">Locations are rounded by the NYPD</span>`,
  };
}
