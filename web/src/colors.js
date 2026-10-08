// Data colors. Green is reserved for the interface (brand); data uses single-hue blue ramps.
// Hexagon density: 6 sequential classes, quantile breaks over the hexagons in view.
//   dark basemap: dark (few complaints) -> light (many)
//   light basemap: light (few) -> dark (many)
export const RAMPS = {
  dark: ['#10263d', '#163654', '#1c466c', '#215785', '#26679d', '#2f78b3'],
  light: ['#cfe0f0', '#a8c8e6', '#7aa9d6', '#4a88c2', '#2470ad', '#154f80'],
};

// Precincts (flat 2D fills): same blue as the hexagons, so blue always means "more complaints",
// but spread wider in lightness, because flat polygons get no shading to separate the classes.
export const PRECINCT_RAMPS = {
  dark: ['#173049', '#1e4466', '#265b86', '#2f73a6', '#4a90c4', '#79b2de'],
  light: ['#dbe8f4', '#b1cde8', '#7fabd6', '#4a88c2', '#2468a5', '#123f69'],
};

// Points are colored by offense group (4 colors are distinguishable; 18 would not be).
export const GROUP_COLORS = {
  person: '#d46c66',
  property: '#6072ba',
  enforcement: '#eac66c',
  other: '#8a8a90',
};
export const GROUP_LABELS = {
  person: 'Crimes against persons',
  property: 'Property crimes',
  enforcement: 'Enforcement offenses',
  other: 'Other',
};

export function rgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Quantile breaks (1/k ... (k-1)/k) splitting values into `k` classes of roughly equal size. */
export function quantileBreaks(values, k = 6) {
  if (!values.length) return [];
  const sorted = Float64Array.from(values).sort();
  const breaks = [];
  for (let i = 1; i < k; i++) breaks.push(sorted[Math.floor((i / k) * (sorted.length - 1))]);
  return breaks;
}

/** Class index (0..k-1) of a value given ascending breaks: value <= breaks[0] is class 0. */
export function classify(value, breaks) {
  let i = 0;
  while (i < breaks.length && value > breaks[i]) i++;
  return i;
}
