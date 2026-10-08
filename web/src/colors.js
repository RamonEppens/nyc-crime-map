// Data colors. Green is reserved for the interface (brand); data uses single-hue blue ramps.
// Hexagon density: 6 sequential classes, quantile breaks over the hexagons in view.
//   dark basemap: dark (few complaints) -> light (many)
//   light basemap: light (few) -> dark (many)
export const RAMPS = {
  dark: ['#10263d', '#163654', '#1c466c', '#215785', '#26679d', '#2f78b3'],
  light: ['#cfe0f0', '#a8c8e6', '#7aa9d6', '#4a88c2', '#2470ad', '#154f80'],
};

// Precincts (flat 2D fills): pale (few complaints) -> deep blue (many) in BOTH themes, the way
// choropleths are read ("darker = more"). On the dark basemap the deepest class stays saturated
// enough to stand apart from the background.
export const PRECINCT_RAMPS = {
  dark: ['#d3e3f2', '#a6c6e5', '#77a5d3', '#4c85c0', '#2f68aa', '#1c4e8e'],
  light: ['#dbe8f4', '#b1cde8', '#7fabd6', '#4a88c2', '#2468a5', '#123f69'],
};

// When the offense selection falls inside ONE group, the hexagons and precincts take that group's
// color (same 6 classes, same quantile breaks); a mixed or full selection goes back to blue.
//   dark: hexagons on the dark basemap, dark (few) -> group color (many)
//   light: hexagons on the light basemap, and precincts in both themes, pale (few) -> deep (many)
// Hand-tuned, not mixed with black: yellow and red turn muddy (olive, brown) when simply darkened.
export const GROUP_RAMPS = {
  person: {
    dark: ['#3a1d1c', '#552826', '#713431', '#8f413c', '#b05550', '#d46c66'],
    light: ['#f6dcda', '#efb9b5', '#e3928c', '#d46c66', '#b44c47', '#8a3330'],
  },
  property: {
    dark: ['#1c2038', '#262d52', '#323c6d', '#3f4c8a', '#5162a6', '#6f82c8'],
    light: ['#e0e4f4', '#c0c8e8', '#9aa6d8', '#7584c6', '#5566ab', '#3c4a8a'],
  },
  enforcement: {
    dark: ['#33291a', '#4d3d20', '#6b5427', '#8c6e30', '#b8933f', '#eac66c'],
    light: ['#faf1d6', '#f3e1a8', '#e8c96f', '#d2a940', '#a98224', '#7a5c15'],
  },
  other: {
    dark: ['#222224', '#303033', '#424246', '#58585d', '#76767c', '#9a9aa0'],
    light: ['#ececee', '#d6d6da', '#b8b8bd', '#96969c', '#727278', '#505055'],
  },
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
