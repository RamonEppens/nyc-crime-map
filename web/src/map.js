// Map: MapLibre basemap + deck.gl overlay.
//   Zoomed out: 3D hexagon columns on the project's own 180 m pointy-top grid (ColumnLayer).
//   Zoomed in (12.5 -> 13.7): columns sink and fade while the complaint locations fade in.
//   Precinct view: flat 2D map, each NYPD precinct filled by its number of complaints.
import { Map, Marker, NavigationControl, AttributionControl, setWorkerUrl } from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import 'maplibre-gl/dist/maplibre-gl.css';
import { MapboxOverlay } from '@deck.gl/mapbox';
import { ColumnLayer, ScatterplotLayer, GeoJsonLayer, SolidPolygonLayer, PathLayer, TextLayer } from '@deck.gl/layers';
import { basemapStyle } from './basemap.js';
import { RAMPS, PRECINCT_RAMPS, GROUP_RAMPS, GROUP_COLORS, rgb, classify, quantileBreaks } from './colors.js';
import { fmt } from './format.js';
import { setGrid, hexCenter } from './geo.js';

setWorkerUrl(workerUrl);

const VIEW = { center: [-73.965, 40.715], zoom: 11, pitch: 45, bearing: -12 };   // Manhattan/Brooklyn
const VIEW_2D = { center: [-73.94, 40.70], zoom: 10.1, pitch: 0, bearing: 0 };     // all five boroughs
const VIEW_MS = 800;                // hexagons <-> precincts cross-fade and camera move
const PAN_LIMITS = [[-74.6, 40.35], [-73.3, 41.05]];
const MAX_HEIGHT_M = 2200;          // tallest column, meters (linear in n / max)
const ZOOM_FADE = [12.5, 13.7];     // columns -> points transition
const POINTS_MARGIN = 0.35;         // load points for the view plus 35% on each side

let map;
let overlay;
let grid;
let theme;
let categories = [];
let hooks = {};
// Hexagons: a fixed "universe" (every hexagon that has ever had a complaint), loaded once in a
// stable order. Filters only change the counts, never the array length or order, so deck.gl can
// interpolate each column's height and color in place (attribute transitions work by index).
const universe = { cells: [], index: new globalThis.Map() };
const state = { hexes: [], maxN: 1, breaks: [], label: '', points: [], pointsBox: null, selection: null,
  view: 'hex', mix: 0, precinctBreaks: [] };
// Precincts: features loaded once in a fixed order (79: 78 precincts + the merged 105/113/116 area
// used for periods before the 116th existed). Polygons and outlines are flattened once, so color
// changes interpolate in place like the hexagons; each filter only rewrites `units[i].n / shown`.
const precincts = { units: [], polygons: [], paths: [], version: 0 };
const key = (q, r) => q * 10000 + r;
// Offense group whose color the hexagons and precincts take (null = the usual blue).
let tint = null;
const hexRamp = () => (tint ? GROUP_RAMPS[tint][theme] : RAMPS[theme]);
const precinctRamp = () => (tint ? GROUP_RAMPS[tint].light : PRECINCT_RAMPS[theme]);
const easeOutCubic = (t) => 1 - (1 - t) ** 3;

const smoothstep = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

export async function createMap(container, opts) {
  ({ grid, theme, categories } = opts);
  state.view = opts.view ?? 'hex';
  state.mix = state.view === 'precincts' ? 1 : 0;
  setGrid(grid);
  hooks = opts.hooks;
  map = new Map({
    container,
    style: basemapStyle(theme),
    ...(state.view === 'precincts' ? VIEW_2D : VIEW),
    maxBounds: PAN_LIMITS,
    maxPitch: 70,
    attributionControl: false,
  });
  map.addControl(new AttributionControl({ compact: true }), 'bottom-right');
  map.addControl(new NavigationControl({ visualizePitch: true }), 'bottom-right');

  overlay = new MapboxOverlay({ interleaved: false, layers: [], getTooltip: tooltip });
  map.addControl(overlay);

  for (const type of ['dragstart', 'wheel', 'rotatestart', 'pitchstart']) {
    map.on(type, (e) => { if (e.originalEvent) stopFollow(); });   // only the user's own moves
  }
  map.on('zoom', render);                         // keeps the column/point transition smooth
  // Clicks: a hexagon column or a location dot selects that hexagon; elsewhere, the neighborhood.
  map.on('click', (e) => {
    const picked = overlay.pickObject({ x: e.point.x, y: e.point.y, radius: 3, layerIds: ['hex', 'points', 'precincts'] });
    const lngLat = [e.lngLat.lng, e.lngLat.lat];
    if (picked?.layer.id === 'precincts') hooks.onPick?.({ kind: 'precinct', unit: precincts.units[picked.object.u].props });
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
  return map;
}

export function setTheme(next) {
  theme = next;
  map.setStyle(basemapStyle(theme), { diff: false });
  updateBreaks();
  render();
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
export function setPrecincts(counts, merged) {
  for (const unit of precincts.units) {
    const { pct, merged: parts } = unit.props;
    if (parts) {
      unit.shown = merged;
      unit.n = parts.reduce((t, p) => t + (counts.get(p) ?? 0), 0);
    } else {
      const inMerged = precincts.units.some((x) => x.props.merged?.includes(pct));
      unit.shown = !(merged && inMerged);
      unit.n = counts.get(pct) ?? 0;
    }
  }
  precincts.version++;
  const breaks = quantileBreaks(precincts.units.filter((x) => x.shown).map((x) => x.n));
  for (let i = 1; i < breaks.length; i++) if (breaks[i] <= breaks[i - 1]) breaks[i] = breaks[i - 1] + 1;
  state.precinctBreaks = breaks;
  if (state.view === 'precincts') hooks.onLegend?.(precinctRamp(), breaks, 'precinct');
  render();
}

/** Unit shown for a precinct number right now (the merged area when it applies), or null. */
export function precinctUnit(pct) {
  return precincts.units.find((x) => x.shown && (x.props.pct === pct || x.props.merged?.includes(pct)))?.props ?? null;
}

/** 'hex' (3D hexagons) or 'precincts' (flat, by NYPD precinct): cross-fade and move the camera. */
export function setView(view) {
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
    map.easeTo({ pitch: 0, bearing: 0, zoom: Math.min(map.getZoom(), 12), duration: VIEW_MS });
  } else {
    lockFlat(false);
    map.easeTo({ pitch: VIEW.pitch, bearing: VIEW.bearing, duration: VIEW_MS });
  }
  updateBreaks();
}

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
  state.label = label;
  updateBreaks();
  render();
  state.pointsBox = null;                        // filters changed: points must be reloaded
  maybeLoadPoints();
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
export function setSelection(feature, style = 'outline') {
  state.selection = feature;
  state.selectionStyle = style;
  state.highlight = null;
  stopFollow();
  render();
}

const isArea = (f) => /Polygon/.test(f?.geometry?.type ?? '');
const highlightRgb = (alpha) => [...(theme === 'dark' ? [255, 214, 102] : [230, 120, 20]), alpha];

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
    pin = new Marker({ element: el, anchor: 'bottom' });
  }
  pin.setLngLat(lngLat).addTo(map);
}

const PADDING = { top: 60, bottom: 60, left: 380, right: 440 };   // keeps clear of the column and the panel
/** Fly to a point (addresses, corners): close enough that the map shows complaint locations. */
export function flyToPoint(lngLat, zoom = 15.8, duration = 1800) {
  // An offset, not padding: MapLibre keeps a flyTo padding and adds it to the next fitBounds,
  // which then cannot fit and silently does nothing.
  map.flyTo({ center: lngLat, zoom, duration, offset: [(PADDING.left - PADDING.right) / 2, 0], essential: true });
}
/** Fit a box [[w, s], [e, n]] (streets, areas). */
export function fitTo(bounds, { maxZoom = 15, duration = 1600 } = {}) {
  map.fitBounds(bounds, { padding: PADDING, maxZoom, duration, pitch: map.getPitch(), bearing: map.getBearing() });
}

/** Move the camera to show a bounding box [[w, s], [e, n]] without changing pitch or bearing. */
export function showBounds(bounds) {
  map.fitBounds(bounds, { padding: PADDING, maxZoom: 14,
    pitch: map.getPitch(), bearing: map.getBearing(), duration: 900 });
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
function updateBreaks() {
  if (state.view === 'precincts') {                // precinct classes do not depend on the viewport
    hooks.onLegend?.(precinctRamp(), state.precinctBreaks, 'precinct');
    return;
  }
  const b = map.getBounds();
  const withData = state.hexes.filter((d) => d.n > 0);
  const inView = withData.filter((d) => b.contains([d.lon, d.lat])).map((d) => d.n);
  const breaks = quantileBreaks(inView.length >= 6 ? inView : withData.map((d) => d.n));
  for (let i = 1; i < breaks.length; i++) {        // strictly increasing, so every class is distinct
    if (breaks[i] <= breaks[i - 1]) breaks[i] = breaks[i - 1] + 1;
  }
  state.breaks = breaks;
  hooks.onLegend?.(hexRamp(), state.breaks, 'hexagon');
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
    elevationScale: (1 - m) ** 1.6 * k,
    getFillColor: (d) => (d.n > 0 ? [...ramp[classify(d.n, state.breaks)], 235] : [0, 0, 0, 0]),
    opacity: 0.95 * (1 - m) ** 1.3 * k,
    material: { ambient: 0.6, diffuse: 0.5, shininess: 20, specularColor: [30, 30, 30] },
    visible: m < 1 && k > 0,
    pickable: m < 0.5 && k > 0.5,
    autoHighlight: true,
    highlightColor: [255, 255, 255, 60],
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
    getRadius: (d) => Math.min(9, 1.6 + 0.55 * Math.sqrt(d.n)),   // area grows with the count
    getFillColor: (d) => rgb(GROUP_COLORS[categories[d.cat]?.group ?? 'other']),
    stroked: true,
    getLineColor: theme === 'dark' ? [14, 14, 14] : [255, 255, 255],
    lineWidthUnits: 'pixels',
    getLineWidth: 1,
    opacity: 0.9 * m * k,
    visible: m > 0 && k > 0,
    pickable: m >= 0.5 && k > 0.5,
    parameters: { depthCompare: 'always' },   // drawn over the sinking columns, never hidden by them
  });
  // Selection: fluorescent green (the brand hue pushed to neon) with a soft glow underneath, so a
  // street or a circle stands out over columns, dots and either basemap. A slightly deeper neon on
  // the light basemap keeps it visible on white.
  const style = state.selectionStyle;
  const neon = theme === 'dark' ? [57, 255, 136] : [0, 214, 104];
  const width = style === 'line' ? 3 : 1.75;
  const selData = state.selection ? [state.selection] : [];
  const glow = new GeoJsonLayer({
    id: 'selection-glow',
    data: selData,
    stroked: true,
    filled: false,
    getLineColor: [...neon, theme === 'dark' ? 50 : 42],
    lineWidthUnits: 'pixels',
    getLineWidth: width + 5,
    lineCapRounded: true,
    lineJointRounded: true,
    parameters: { depthCompare: 'always' },
    updateTriggers: { getLineColor: theme, getLineWidth: style },
  });
  const outline = new GeoJsonLayer({
    id: 'selection',
    data: selData,
    stroked: true,
    filled: style === 'area' || style === 'circle',
    getFillColor: [...neon, style === 'circle' ? 40 : 26],
    getLineColor: [...neon, 255],
    lineWidthUnits: 'pixels',
    getLineWidth: width,
    lineCapRounded: true,
    lineJointRounded: true,
    parameters: { depthCompare: 'always' },
    updateTriggers: { getFillColor: [style, theme], getLineColor: theme, getLineWidth: style },
  });
  // Highlight: one block of the street, in the warm complement of the blue data (yellow at night,
  // orange by day, where yellow has no contrast), 9 px, on top of everything.
  const highlight = state.highlight && new GeoJsonLayer({
    id: 'highlight',
    data: [state.highlight],
    // A block is a thick 9 px stroke; a neighborhood is a 4 px outline with a faint fill of the
    // same warm color, so the area reads as a shape without hiding the columns inside it.
    stroked: true,
    filled: isArea(state.highlight),
    getLineColor: highlightRgb(255),
    getFillColor: highlightRgb(46),
    lineWidthUnits: 'pixels',
    getLineWidth: isArea(state.highlight) ? 4 : 9,
    lineWidthMinPixels: isArea(state.highlight) ? 4 : 9,
    lineCapRounded: true,
    lineJointRounded: true,
    parameters: { depthCompare: 'always' },
    updateTriggers: { getLineColor: theme, getFillColor: theme, getLineWidth: state.highlight },
  });
  overlay.setProps({ layers: [columns, points, ...precinctLayers(), glow, outline, highlight].filter(Boolean) });
}

function precinctLayers() {
  const mix = state.mix;
  if (mix <= 0 || !precincts.units.length) return [];
  const ramp = precinctRamp().map(rgb);
  const { units, version } = precincts;
  const triggers = `${version}|${state.precinctBreaks.join(',')}|${theme}|${tint}`;
  const fills = new SolidPolygonLayer({
    id: 'precincts',
    data: precincts.polygons,
    getPolygon: (d) => d.polygon,
    getFillColor: (d) => (units[d.u].shown ? [...ramp[classify(units[d.u].n, state.precinctBreaks)], 225] : [0, 0, 0, 0]),
    opacity: mix,
    pickable: mix > 0.5,
    autoHighlight: true,
    highlightColor: [255, 255, 255, 50],
    transitions: { getFillColor: { duration: 450 } },
    updateTriggers: { getFillColor: triggers },
  });
  const borders = new PathLayer({
    id: 'precinct-borders',
    data: precincts.paths,
    getPath: (d) => d.path,
    getColor: (d) => (units[d.u].shown ? (theme === 'dark' ? [12, 12, 12, 255] : [255, 255, 255, 255]) : [0, 0, 0, 0]),
    widthUnits: 'pixels',
    getWidth: 1.2,
    opacity: mix,
    updateTriggers: { getColor: triggers },
  });
  const labels = new TextLayer({
    id: 'precinct-labels',
    data: units.filter((x) => x.shown),
    getPosition: (d) => d.props.label,
    getText: (d) => (d.props.merged ? d.props.merged.join('·') : String(d.props.pct)),
    getSize: 11,
    fontFamily: '"Public Sans", system-ui, sans-serif',
    fontWeight: 600,
    characterSet: '0123456789·',
    fontSettings: { sdf: true },
    outlineWidth: 2,
    outlineColor: theme === 'dark' ? [12, 12, 12, 220] : [255, 255, 255, 220],
    getColor: theme === 'dark' ? [235, 235, 235, 255] : [20, 30, 42, 255],
    opacity: mix,
    visible: map.getZoom() >= 10.3,
    updateTriggers: { getText: version },
  });
  return [fills, borders, labels];
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
  if (layer?.id === 'precincts' && object) {
    const unit = precincts.units[object.u];
    return { className: 'deck-tooltip',
      html: `<strong>${precinctName(unit.props)}</strong><br>${fmt(unit.n)} complaint${unit.n === 1 ? '' : 's'} in ${state.label}<span class="tip-hint">Click for details</span>` };
  }
  if (!object || !object.n) return null;
  if (layer.id === 'hex') {
    return { className: 'deck-tooltip', html: `<strong>${fmt(object.n)}</strong> complaints<br>${state.label}<span class="tip-hint">Click for details</span>` };
  }
  return {
    className: 'deck-tooltip',
    html: `<strong>${fmt(object.n)}</strong> complaint${object.n === 1 ? '' : 's'} at this location<br>${state.label}`,
  };
}
