// Time filter. Every mode resolves to a set of month indices m (0 = Jan 2016 ... 119 = Dec 2025),
// which is how the data files store time. Modes:
//   year        one calendar year
//   month       one month of one year
//   crossyear   the same month in every year (e.g. every July, 2016 to 2025): seasonality
//   yearRange   a range of whole years
//   monthRange  a range of months (may cross a year boundary)
export const FIRST_YEAR = 2016;
export const LAST_YEAR = 2025;
export const N_MONTHS = (LAST_YEAR - FIRST_YEAR + 1) * 12;
export const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];
export const MODES = [
  ['year', 'Single year'],
  ['month', 'Single month'],
  ['crossyear', 'Same month, every year'],
  ['yearRange', 'Year range'],
  ['monthRange', 'Month range'],
];

const mIndex = (year, month) => (year - FIRST_YEAR) * 12 + month;
const yearOf = (m) => FIRST_YEAR + Math.floor(m / 12);
const monthOf = (m) => m % 12;
const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
const short = (m) => `${MONTH_NAMES[monthOf(m)].slice(0, 3)} ${yearOf(m)}`;

export function defaultPeriod() {
  return {
    mode: 'year',
    year: LAST_YEAR,
    month: mIndex(LAST_YEAR, 11),
    crossMonth: 6,
    fromYear: LAST_YEAR - 4, toYear: LAST_YEAR,
    fromMonth: mIndex(LAST_YEAR - 1, 0), toMonth: mIndex(LAST_YEAR, 11),
  };
}

/** Month indices covered by a period. */
export function monthsOf(p) {
  switch (p.mode) {
    case 'year': return range(mIndex(p.year, 0), mIndex(p.year, 11));
    case 'month': return [p.month];
    case 'crossyear': return range(FIRST_YEAR, LAST_YEAR).map((y) => mIndex(y, p.crossMonth));
    case 'yearRange': return range(mIndex(Math.min(p.fromYear, p.toYear), 0), mIndex(Math.max(p.fromYear, p.toYear), 11));
    case 'monthRange': return range(Math.min(p.fromMonth, p.toMonth), Math.max(p.fromMonth, p.toMonth));
    default: return range(0, N_MONTHS - 1);
  }
}

/** SQL condition on the month column for a list of month indices. */
export function monthSql(months) {
  if (!months.length) return 'FALSE';
  const contiguous = months[months.length - 1] - months[0] === months.length - 1;
  return contiguous ? `m BETWEEN ${months[0]} AND ${months[months.length - 1]}` : `m IN (${months.join(',')})`;
}

export function labelOf(p) {
  const ms = monthsOf(p);
  switch (p.mode) {
    case 'year': return String(p.year);
    case 'month': return `${MONTH_NAMES[monthOf(p.month)]} ${yearOf(p.month)}`;
    case 'crossyear': return `Every ${MONTH_NAMES[p.crossMonth]}, ${FIRST_YEAR} to ${LAST_YEAR}`;
    case 'yearRange': return ms.length === 12 ? String(yearOf(ms[0])) : `${yearOf(ms[0])} to ${yearOf(ms[ms.length - 1])}`;
    case 'monthRange': return ms.length === 1 ? short(ms[0]) : `${short(ms[0])} to ${short(ms[ms.length - 1])}`;
    default: return '';
  }
}

/** Days covered (for "per day" figures). */
export function daysOf(months) {
  return months.reduce((sum, m) => sum + new Date(yearOf(m), monthOf(m) + 1, 0).getDate(), 0);
}

/**
 * Comparison period of the same length, or null when there is none inside the data:
 * a year or month is compared with the same period one year earlier (seasonality-safe);
 * a range with the range right before it; "every July" has no comparison.
 */
export function comparisonOf(p) {
  const ms = monthsOf(p);
  if (p.mode === 'crossyear') return null;
  const shift = p.mode === 'year' || p.mode === 'month' ? 12 : ms.length;
  const prev = ms.map((m) => m - shift);
  if (prev[0] < 0) return null;
  let label;
  if (p.mode === 'year') label = `vs ${p.year - 1}`;
  else if (p.mode === 'month') label = `vs ${short(prev[0])}`;
  else label = ms.length % 12 === 0 && monthOf(prev[0]) === 0
    ? `vs ${yearOf(prev[0])}${prev.length > 12 ? ` to ${yearOf(prev[prev.length - 1])}` : ''}`
    : `vs ${short(prev[0])} to ${short(prev[prev.length - 1])}`;
  return { months: prev, label };
}

export { mIndex, yearOf, monthOf };
