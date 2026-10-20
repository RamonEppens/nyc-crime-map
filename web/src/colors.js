// Data colors (decision #69). This file and the neutral tokens in styles.css are the complete
// palette; pipeline/scripts/color_check.py checks every value (contrast, color-blind distance).
//
// Density ramp: plum (OKLCH hue 330, even lightness steps). Plum reads as neither water (blue),
// parks (green) nor alarm (red), and shares no hue with the interface ink.
//   light map: pale (few complaints) -> deep (many); dark map: dark (few) -> pale (many)
export const RAMPS = {
  light: ['#f3ddf0', '#dcb1d7', '#c287bc', '#a15e9c', '#7c3b77', '#532150'],
  dark: ['#512f4f', '#7a4475', '#a15e9c', '#c57fbf', '#e3a6dd', '#facef4'],
};

// Precinct and borough fills: the light ramp in both themes (filled areas cover the basemap, so
// "darker = more" stays readable at night too).
export const PRECINCT_RAMPS = { light: RAMPS.light, dark: RAMPS.light };

// Offense groups: points and the offense list only (never the density layers). Checked for
// >= 3:1 on both basemaps where possible and >= 11 CAM02-UCS under deutan, protan and tritan.
export const GROUP_COLORS = {
  person: '#b45248',
  property: '#046f87',
  enforcement: '#a97416',
  other: '#868686',
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

/** Quantile breaks rounded to friendly numbers (…, 1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10, …), strictly
 *  increasing, so the key reads "11–20" instead of "13–21" while the classes stay roughly equal. */
export function niceBreaks(values, k = 6) {
  const raw = quantileBreaks(values.filter((v) => v > 0), k);
  const STEPS = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8];
  const nice = (x) => {
    if (!(x > 0)) return 1;
    const mag = 10 ** Math.floor(Math.log10(x));
    let best = mag, bestD = Infinity;
    for (const m of [...STEPS, 10]) {
      const v = m * mag;
      const d = Math.abs(Math.log(v / x));
      if (d < bestD) { best = v; bestD = d; }
    }
    return +best.toPrecision(3);
  };
  const next = (x) => {                            // the friendly number just above x
    const mag = 10 ** Math.floor(Math.log10(x));
    for (const m of [...STEPS, 10]) if (+(m * mag).toPrecision(3) > x) return +(m * mag).toPrecision(3);
    return x * 1.5;
  };
  const out = [];
  for (const b of raw) {
    let v = nice(b);
    if (out.length && v <= out.at(-1)) v = next(out.at(-1));
    out.push(v);
  }
  return out;
}

/** Class index (0..k-1) of a value given ascending breaks: value <= breaks[0] is class 0. */
export function classify(value, breaks) {
  let i = 0;
  while (i < breaks.length && value > breaks[i]) i++;
  return i;
}
