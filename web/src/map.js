// Map: MapLibre basemap + deck.gl overlay.
//   Zoomed out: 3D hexagon columns on the project's own 180 m pointy-top grid (ColumnLayer).
//   Zoomed in (12.5 -> 13.7): columns sink and fade while the complaint locations fade in.
import { Map, NavigationControl, AttributionControl, setWorkerUrl } from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import 'maplibre-gl/dist/maplibre-gl.css';
import { MapboxOverlay } from '@deck.gl/mapbox';
import { ColumnLayer, ScatterplotLayer } from '@deck.gl/layers';
import { basemapStyle } from './basemap.js';
import { RAMPS, GROUP_COLORS, rgb, classify, quantileBreaks } from './colors.js';
import { fmt } from './format.js';

setWorkerUrl(workerUrl);

const VIEW = { center: [-73.965, 40.715], zoom: 11, pitch: 45, bearing: -12 };   // Manhattan/Brooklyn
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
const state = { hexes: [], maxN: 1, breaks: [], label: '', points: [], pointsBox: null };
const key = (q, r) => q * 10000 + r;
const easeOutCubic = (t) => 1 - (1 - t) ** 3;

const smoothstep = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Hexagon center (q, r) -> [lon, lat], with the grid parameters written by the pipeline. */
function hexCenter(q, r) {
  const cx = grid.side * Math.sqrt(3) * (q + r / 2);
  const cy = grid.side * 1.5 * r;
  return [grid.lon0 + cx / grid.kx, grid.lat0 + cy / grid.ky];
}

export async function createMap(container, opts) {
  ({ grid, theme, categories } = opts);
  hooks = opts.hooks;
  map = new Map({
    container,
    style: basemapStyle(theme),
    ...VIEW,
    maxBounds: PAN_LIMITS,
    maxPitch: 70,
    attributionControl: false,
  });
  map.addControl(new AttributionControl({ compact: true }), 'bottom-right');
  map.addControl(new NavigationControl({ visualizePitch: true }), 'bottom-right');

  overlay = new MapboxOverlay({ interleaved: false, layers: [], getTooltip: tooltip });
  map.addControl(overlay);

  map.on('zoom', render);                         // keeps the column/point transition smooth
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
  const hexes = universe.cells.map((c) => ({ lon: c.lon, lat: c.lat, n: 0 }));
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

/** For tests: size of the hexagon array, hexagons with data, and the array itself (identity). */
export function hexStats() {
  return { length: state.hexes.length, withData: state.hexes.filter((d) => d.n > 0).length,
    first: state.hexes[0] && [state.hexes[0].lon, state.hexes[0].lat], breaks: state.breaks };
}

/** Quantile breaks over the hexagons currently in view; the legend is updated to match. */
function updateBreaks() {
  const b = map.getBounds();
  const withData = state.hexes.filter((d) => d.n > 0);
  const inView = withData.filter((d) => b.contains([d.lon, d.lat])).map((d) => d.n);
  const breaks = quantileBreaks(inView.length >= 6 ? inView : withData.map((d) => d.n));
  for (let i = 1; i < breaks.length; i++) {        // strictly increasing, so every class is distinct
    if (breaks[i] <= breaks[i - 1]) breaks[i] = breaks[i - 1] + 1;
  }
  state.breaks = breaks;
  hooks.onLegend?.(RAMPS[theme], state.breaks);
}

function viewBox(margin) {
  const b = map.getBounds();
  const dx = (b.getEast() - b.getWest()) * margin;
  const dy = (b.getNorth() - b.getSouth()) * margin;
  return [b.getWest() - dx, b.getSouth() - dy, b.getEast() + dx, b.getNorth() + dy];
}

async function maybeLoadPoints() {
  if (map.getZoom() < ZOOM_FADE[0] || !hooks.loadPoints) return;
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
  const ramp = RAMPS[theme].map(rgb);
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
    elevationScale: (1 - m) ** 1.6,
    getFillColor: (d) => (d.n > 0 ? [...ramp[classify(d.n, state.breaks)], 235] : [0, 0, 0, 0]),
    opacity: 0.95 * (1 - m) ** 1.3,
    material: { ambient: 0.6, diffuse: 0.5, shininess: 20, specularColor: [30, 30, 30] },
    visible: m < 1,
    pickable: m < 0.5,
    autoHighlight: true,
    highlightColor: [255, 255, 255, 60],
    transitions: {
      getElevation: { duration: 700, easing: easeOutCubic },
      getFillColor: { duration: 450 },
    },
    updateTriggers: { getFillColor: `${state.breaks.join(',')}|${theme}`, getElevation: state.maxN },
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
    opacity: 0.9 * m,
    visible: m > 0,
    pickable: m >= 0.5,
    parameters: { depthCompare: 'always' },   // drawn over the sinking columns, never hidden by them
  });
  overlay.setProps({ layers: [columns, points] });
}

function tooltip({ object, layer }) {
  if (!object || !object.n) return null;
  if (layer.id === 'hex') {
    return { className: 'deck-tooltip', html: `<strong>${fmt(object.n)}</strong> complaints<br>${state.label}` };
  }
  return {
    className: 'deck-tooltip',
    html: `<strong>${fmt(object.n)}</strong> complaint${object.n === 1 ? '' : 's'} at this location<br>${state.label}`,
  };
}
