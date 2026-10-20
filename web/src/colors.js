// Data colors (editorial redesign, 2026-10-10). Six classes per ramp, generated in OKLCH with even
// lightness steps (docs/DECISIONS.md #64), so every step is as visible as the next.
// The default data color is "ink": a muted navy, the color of newsprint ink, not a stock UI blue.
// Green is not used for data at all; the interface accent is ink and the hover "highlighter" yellow.
//   light basemap (default): pale (few complaints) -> deep ink (many)
//   dark basemap: dark (few) -> pale (many), so "more" always means more contrast with the map
export const RAMPS = {
  light: ['#d5e3f2', '#a7b9cf', '#7b91ad', '#526a8c', '#2d456c', '#0b214c'],
  dark: ['#27364a', '#405369', '#5b728b', '#7692ad', '#93b3d1', '#b1d6f6'],
};

// Precincts (flat 2D fills): pale (few) -> deep (many) in BOTH themes, the way choropleths are read.
export const PRECINCT_RAMPS = {
  light: RAMPS.light,
  dark: RAMPS.light,
};

// When the offense selection falls inside ONE group, hexagons and precincts take that group's ramp
// (same classes and breaks); a mixed or full selection goes back to ink. Muted, printed hues:
// oxblood for crimes against persons, slate teal for property, ochre for enforcement, graphite.
export const GROUP_RAMPS = {
  person: {
    light: ['#f8d9d4', '#ddafa8', '#c18780', '#a45f59', '#873735', '#690313'],
    dark: ['#502825', '#703e39', '#93554d', '#b66d62', '#db8677', '#ffa08d'],
  },
  property: {
    light: ['#cfe7e6', '#a3c2c3', '#789fa0', '#4d7d80', '#205c61', '#003c44'],
    dark: ['#193c3d', '#2e5758', '#457475', '#5c9392', '#74b2b1', '#8ed3d0'],
  },
  enforcement: {
    light: ['#f6e7c3', '#d9c499', '#bea270', '#a48148', '#8a601c', '#714000'],
    dark: ['#4b361c', '#6b502b', '#8b6b3a', '#ac894a', '#cda85b', '#eec96c'],
  },
  other: {
    light: ['#e2e1de', '#bcbbb8', '#979693', '#74736f', '#53524e', '#34332e'],
    dark: ['#393834', '#53524f', '#706f6a', '#8d8c87', '#acaba5', '#cccac5'],
  },
};

// Points and the offense key are colored by group (4 colors are distinguishable; 18 would not be).
// Mid steps of the group ramps, readable on both the paper and the night map.
export const GROUP_COLORS = {
  person: '#b5544c',
  property: '#3f8a8c',
  enforcement: '#c08f2e',
  other: '#8a8984',
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
