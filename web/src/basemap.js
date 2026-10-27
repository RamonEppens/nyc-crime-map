// Basemap styles: CARTO positron (paper, the default) and dark-matter (night). The published style
// is loaded and recolored (decision #93): blocks a step darker than the streets, so the street grid
// reads as light channels between them; parks and cemeteries in a muted grey-beige (no green: green is
// the logo's and the selection's); buildings faintly from zoom 15. Labels and everything else stay
// CARTO's. If the style can't be patched, it's used as is.
const STYLES = {
  dark: 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json',
  light: 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json',
};
// The site's paper (panels, the veil outside the city). The map's land is its own, darker tone.
export const PAPER = { light: '#f4f5f2', dark: '#111417' };
const LAND = { light: '#e5e6df', dark: '#15191c' };
const WATER = { light: '#cbd7df', dark: '#0a0d10' };
const PARK = { light: '#d8d5c3', dark: '#1e1e1a' };
const STREET = { light: '#ffffff', dark: null };                    // dark: CARTO's road colors, dimmed
const DARK_ROADS = 0.75;                     // night: roads keep 75% of their contrast with the land
const CASING = { light: '#d4d6cf', dark: null };
const BUILDING = { light: ['#d9dad3', '#e1e2db', '#d0d1ca'], dark: ['#1b1f22', '#1f2327', '#262a2e'] };

/** MapLibre style for a theme. `?basemap=none` gives a plain background (offline tests). */
export async function basemapStyle(theme) {
  if (new URLSearchParams(location.search).get('basemap') === 'none') {
    return { version: 8, sources: {}, layers: [
      { id: 'background', type: 'background', paint: { 'background-color': LAND[theme] } },
    ] };
  }
  try {
    const style = await (await fetch(STYLES[theme])).json();
    patch(style, theme);
    return style;
  } catch {
    return STYLES[theme];
  }
}

function patch(style, theme) {
  const layers = [];
  for (const layer of style.layers) {
    const id = layer.id;
    const paint = (p) => { layer.paint = { ...layer.paint, ...p }; };
    if (layer.type === 'background') paint({ 'background-color': LAND[theme] });
    else if (layer.type === 'fill' && /^water/.test(id)) paint({ 'fill-color': WATER[theme] });
    // Residential areas were a lighter wash over the land: blocks look patchy with it.
    else if (id === 'landuse_residential') paint({ 'fill-opacity': 0 });
    else if (id === 'landcover' || id === 'landuse' || /^park_/.test(id)) paint({ 'fill-color': PARK[theme], 'fill-opacity': 1 });
    else if (id === 'building') paint({ 'fill-color': BUILDING[theme][0] });
    else if (id === 'building-top') paint({ 'fill-color': BUILDING[theme][1], 'fill-outline-color': BUILDING[theme][2] });
    else if (layer.type === 'line' && /^(road|bridge|tunnel)_/.test(id) && !/path|rail/.test(id) && STREET[theme]) {
      if (/_fill/.test(id)) paint({ 'line-color': STREET[theme] });
      // Below zoom ~15.7 the small streets are drawn by their casing alone: keep it light there.
      else if (/_case/.test(id)) {
        paint({ 'line-color': /minor|service|sec/.test(id)
          ? ['interpolate', ['linear'], ['zoom'], 15.5, STREET[theme], 16, CASING[theme]] : CASING[theme] });
      }
    }
    else if (layer.type === 'line' && /^(road|bridge|tunnel)_/.test(id) && theme === 'dark' && layer.paint?.['line-color']) {
      paint({ 'line-color': toward(layer.paint['line-color'], LAND.dark, 1 - DARK_ROADS) });
    }
    layers.push(layer);
    // Every park class (the style draws only national parks and reserves; Central Park is a "park").
    if (id === 'landcover' && style.sources.carto && !style.layers.some((l) => l.id === 'park_all')) {
      layers.push({ id: 'park_all', type: 'fill', source: 'carto', 'source-layer': 'park',
        paint: { 'fill-color': PARK[theme], 'fill-opacity': 1 } });
    }
  }
  style.layers = layers;
}

/** A color (hex, rgb(a), or zoom stops of them) moved a share `t` of the way to `to` (hex). */
function toward(color, to, t) {
  if (color && typeof color === 'object' && Array.isArray(color.stops)) {
    return { ...color, stops: color.stops.map(([z, c]) => [z, toward(c, to, t)]) };
  }
  if (typeof color !== 'string') return color;
  const hex = color.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  const rgb = color.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i);
  let c, a = 1;
  if (hex) {
    const h = hex[1].length === 3 ? [...hex[1]].map((x) => x + x).join('') : hex[1];
    c = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  } else if (rgb) {
    c = rgb.slice(1, 4).map(Number);
    a = rgb[4] === undefined ? 1 : Number(rgb[4]);
  } else return color;
  const target = [1, 3, 5].map((i) => parseInt(to.slice(i, i + 2), 16));
  const m = c.map((v, i) => Math.round(v + (target[i] - v) * t));
  return `rgba(${m.join(', ')}, ${a})`;
}
