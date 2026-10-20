// Basemap styles: CARTO positron (paper, the default) and dark-matter (night). The published style
// is loaded and only its background and water are recolored to the site's paper and ink tones;
// roads, labels and everything else stay CARTO's. If the style can't be patched, it's used as is.
const STYLES = {
  dark: 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json',
  light: 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json',
};
export const PAPER = { light: '#f4f5f2', dark: '#111417' };
const WATER = { light: '#d8e1e6', dark: '#0a0d10' };

/** MapLibre style for a theme. `?basemap=none` gives a plain background (offline tests). */
export async function basemapStyle(theme) {
  if (new URLSearchParams(location.search).get('basemap') === 'none') {
    return { version: 8, sources: {}, layers: [
      { id: 'background', type: 'background', paint: { 'background-color': PAPER[theme] } },
    ] };
  }
  try {
    const style = await (await fetch(STYLES[theme])).json();
    for (const layer of style.layers) {
      if (layer.type === 'background') layer.paint = { ...layer.paint, 'background-color': PAPER[theme] };
      else if (layer.type === 'fill' && /^water/.test(layer.id)) layer.paint = { ...layer.paint, 'fill-color': WATER[theme] };
    }
    return style;
  } catch {
    return STYLES[theme];
  }
}
