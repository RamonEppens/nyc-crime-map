const nf = new Intl.NumberFormat('en-US');
const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });

export const fmt = (n) => nf.format(Math.round(n));
export const fmtCompact = (n) => (n < 10000 ? nf.format(Math.round(n)) : compact.format(n));
/** Short labels for the legend: 4,545 -> 4.5K (fits six columns). */
export const fmtShort = (n) => (n < 1000 ? nf.format(Math.round(n)) : compact.format(n));
export function fmtChange(pct) {
  if (!Number.isFinite(pct)) return '';
  const sign = pct > 0 ? '+' : pct < 0 ? '−' : '';
  return `${sign}${Math.abs(pct).toFixed(1)}%`;
}
