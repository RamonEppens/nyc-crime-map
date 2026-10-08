// Basemap styles: CARTO dark-matter (dark theme) and positron (light theme), used as published.
const STYLES = {
  dark: 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json',
  light: 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json',
};

/** MapLibre style for a theme. `?basemap=none` gives a plain background (offline tests). */
export function basemapStyle(theme) {
  if (new URLSearchParams(location.search).get('basemap') === 'none') {
    return { version: 8, sources: {}, layers: [
      { id: 'background', type: 'background', paint: { 'background-color': theme === 'dark' ? '#0e0e0e' : '#fafaf8' } },
    ] };
  }
  return STYLES[theme];
}
