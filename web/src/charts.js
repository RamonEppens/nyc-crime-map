// Chart primitives: plain SVG, drawn at the container's width, so the same chart works in the
// narrow panel and in the expanded one. Rules (dataviz method): one y-axis only; thin marks
// (columns <= 24 px, 4 px rounded data end, square at the baseline; 2 px lines); hairline solid
// grid; text in text colors, never the series color; a hover tooltip on every mark.
import { fmt, fmtShort } from './format.js';

const NS = 'http://www.w3.org/2000/svg';
const el = (name, attrs = {}, text) => {
  const e = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null) e.setAttribute(k, v);
  if (text !== undefined) e.textContent = text;
  return e;
};

/** Clean axis maximum and ticks: 0, step, 2·step... with step 1/2/2.5/5 × 10^k. */
export function niceTicks(max, count = 4) {
  if (!(max > 0)) return { max: 1, ticks: [0, 1] };
  const raw = max / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((f) => f * mag).find((s) => s >= raw);
  const top = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = 0; v <= top + step / 2; v += step) ticks.push(+v.toFixed(10));
  return { max: top, ticks };
}

// One tooltip per chart container. It sits just above the plot and follows the pointer sideways,
// so it never covers the marks being read (it covers the one-line answer above the chart instead).
function tooltip(host) {
  let tip = host.querySelector(':scope > .chart-tip');
  if (!tip) {
    tip = document.createElement('div');
    tip.className = 'chart-tip';
    tip.hidden = true;
    host.appendChild(tip);
  }
  return {
    show(html, evt) {
      if (html !== this.current) { tip.innerHTML = html; this.current = html; }
      tip.hidden = false;
      const box = host.getBoundingClientRect();
      const x = evt.clientX - box.left;
      const w = tip.offsetWidth;
      tip.style.left = `${Math.min(Math.max(0, x - w / 2), box.width - w)}px`;
      tip.style.top = `${-tip.offsetHeight - 6}px`;
    },
    hide() { tip.hidden = true; this.current = null; },
    /** Add a line to the tooltip already showing (answers that arrive a moment later). */
    append(html) {
      if (tip.hidden) return;
      tip.insertAdjacentHTML('beforeend', html);
      this.current = tip.innerHTML;
      tip.style.top = `${-tip.offsetHeight - 6}px`;     // taller now: keep its bottom above the plot
    },
  };
}

/** Tooltip on a mark, and optional enter/leave callbacks (d.onEnter may return a promise of an
 *  extra tooltip line, e.g. the cross streets of a block). The mark gets a 'hover' class. */
function hover(target, d, tip, mark) {
  let inside = false;
  target.addEventListener('mouseenter', async (e) => {
    inside = true;
    tip.show(d.tip, e);
    mark?.classList.add('hover');
    const extra = await d.onEnter?.();
    if (inside && extra) tip.append(extra);
  });
  target.addEventListener('mousemove', (e) => { if (!inside) return; tip.show(tip.current ?? d.tip, e); });
  target.addEventListener('mouseleave', () => {
    inside = false;
    tip.hide();
    mark?.classList.remove('hover');
    d.onLeave?.();
  });
}

/** Rounded-top column path: square at the baseline, 4 px (or less) radius at the data end. */
function columnPath(x, y, w, h) {
  if (h <= 0) return '';
  const r = Math.min(4, w / 2, h);
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

function frame(host, height) {
  host.querySelector(':scope > svg')?.remove();
  const width = Math.max(240, host.clientWidth);
  const svg = el('svg', { width, height, viewBox: `0 0 ${width} ${height}`, role: 'img', class: 'chart-svg' });
  host.prepend(svg);
  return { svg, width, tip: tooltip(host) };
}

function yAxis(svg, { left, right, top, bottom, width, height, ticks, max, format = fmtShort }) {
  const g = el('g', { class: 'axis' });
  for (const t of ticks) {
    const y = top + (height - top - bottom) * (1 - t / max);
    g.append(el('line', { x1: left, x2: width - right, y1: y, y2: y, class: t === 0 ? 'baseline' : 'grid' }));
    g.append(el('text', { x: left - 6, y: y + 3.5, 'text-anchor': 'end', class: 'tick' }, format(t)));
  }
  svg.append(g);
}

/**
 * Columns, one per category, with emphasis on some (selected) and an optional comparison line
 * drawn on the SAME axis (e.g. NYC indexed to this place's average).
 * data: [{label, value, on, tip}], line: [{value}] | null
 */
export function columns(host, { data, line = null, lineLabel = '', color, height = 170, every = 1 }) {
  const { svg, width, tip } = frame(host, height);
  const m = { left: 40, right: 8, top: 10, bottom: 22 };
  const top = Math.max(...data.map((d) => d.value), ...(line ?? []).map((d) => d.value ?? 0));
  const { max, ticks } = niceTicks(top);
  yAxis(svg, { ...m, width, height, ticks, max });
  const band = (width - m.left - m.right) / data.length;
  const bw = Math.min(24, band * 0.62);
  const y = (v) => m.top + (height - m.top - m.bottom) * (1 - v / max);
  data.forEach((d, i) => {
    const x = m.left + band * i + (band - bw) / 2;
    const p = el('path', { d: columnPath(x, y(d.value), bw, y(0) - y(d.value)), fill: color, class: d.on ? 'col on' : 'col off' });
    svg.append(p);
    if (i % every === 0 || i === data.length - 1) {
      svg.append(el('text', { x: x + bw / 2, y: height - 6, 'text-anchor': 'middle', class: d.on ? 'tick strong' : 'tick' }, d.label));
    }
    const hit = el('rect', { x: m.left + band * i, y: m.top, width: band, height: height - m.top - m.bottom, class: 'hit' });
    hover(hit, d, tip, p);
    svg.append(hit);
  });
  if (line) {
    const pts = line.map((d, i) => (d.value == null ? null : [m.left + band * i + band / 2, y(d.value)]));
    const dAttr = pts.filter(Boolean).map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join('');
    svg.insertBefore(el('path', { d: dAttr, class: 'cmp-line' }), svg.querySelector('.hit'));
    const last = pts.filter(Boolean).at(-1);
    if (last) svg.insertBefore(el('circle', { cx: last[0], cy: last[1], r: 3.5, class: 'cmp-dot' }), svg.querySelector('.hit'));
  }
  return svg;
}

/**
 * Lines over an index (months): main series in the accent color, optional comparison in gray.
 * series: [{values: [number|null], cls: 'main'|'cmp'|'avg', label}], labels: x labels per index
 */
export function lines(host, { series, labels, tips, color, height = 170, tickEvery = 1 }) {
  const { svg, width, tip } = frame(host, height);
  const m = { left: 40, right: 10, top: 10, bottom: 22 };
  const n = labels.length;
  const all = series.flatMap((s) => s.values.filter((v) => v != null));
  const { max, ticks } = niceTicks(Math.max(1, ...all));
  yAxis(svg, { ...m, width, height, ticks, max });
  const x = (i) => m.left + (n === 1 ? (width - m.left - m.right) / 2 : ((width - m.left - m.right) * i) / (n - 1));
  const y = (v) => m.top + (height - m.top - m.bottom) * (1 - v / max);
  for (const s of series) {
    let d = '';
    let pen = false;
    s.values.forEach((v, i) => {
      if (v == null) { pen = false; return; }
      d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
      pen = true;
    });
    svg.append(el('path', { d, class: `ln ${s.cls}`, stroke: s.cls === 'cmp' ? null : color }));
  }
  labels.forEach((l, i) => {
    if (l && (i % tickEvery === 0)) svg.append(el('text', { x: x(i), y: height - 6, 'text-anchor': 'middle', class: 'tick' }, l));
  });
  // crosshair + tooltip
  const cross = el('line', { y1: m.top, y2: height - m.bottom, class: 'cross', visibility: 'hidden' });
  svg.append(cross);
  const dots = series.map((s) => {
    const c = el('circle', { r: 4, class: `dot ${s.cls}`, fill: s.cls === 'cmp' ? null : color, visibility: 'hidden' });
    svg.append(c);
    return c;
  });
  const hit = el('rect', { x: m.left, y: m.top, width: width - m.left - m.right, height: height - m.top - m.bottom, class: 'hit' });
  hit.addEventListener('mousemove', (e) => {
    const box = svg.getBoundingClientRect();
    const px = e.clientX - box.left;
    const i = Math.max(0, Math.min(n - 1, Math.round(((px - m.left) / (width - m.left - m.right)) * (n - 1))));
    cross.setAttribute('x1', x(i)); cross.setAttribute('x2', x(i)); cross.setAttribute('visibility', 'visible');
    series.forEach((s, k) => {
      const v = s.values[i];
      if (v == null) { dots[k].setAttribute('visibility', 'hidden'); return; }
      dots[k].setAttribute('cx', x(i)); dots[k].setAttribute('cy', y(v)); dots[k].setAttribute('visibility', 'visible');
    });
    tip.show(tips[i], e);
  });
  hit.addEventListener('mouseleave', () => {
    tip.hide();
    cross.setAttribute('visibility', 'hidden');
    dots.forEach((d) => d.setAttribute('visibility', 'hidden'));
  });
  svg.append(hit);
  return svg;
}

/** Day (rows, Mon..Sun) x hour (columns 0..23) grid; cell darkness = share of the busiest cell. */
export function heatmap(host, { grid, color, height = 176 }) {
  const { svg, width, tip } = frame(host, height);
  const m = { left: 34, right: 4, top: 4, bottom: 20 };
  const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const cw = (width - m.left - m.right) / 24;
  const ch = (height - m.top - m.bottom) / 7;
  const max = Math.max(1, ...grid.flat());
  const total = grid.flat().reduce((a, b) => a + b, 0) || 1;
  days.forEach((dname, d) => {
    svg.append(el('text', { x: m.left - 6, y: m.top + ch * d + ch / 2 + 3.5, 'text-anchor': 'end', class: 'tick' }, dname));
    for (let h = 0; h < 24; h++) {
      const v = grid[d][h];
      const r = el('rect', {
        x: m.left + cw * h + 1, y: m.top + ch * d + 1, width: Math.max(1, cw - 2), height: Math.max(1, ch - 2), rx: 2,
        fill: color, 'fill-opacity': (0.06 + 0.94 * (v / max)).toFixed(3), class: 'cell',
      });
      r.addEventListener('mousemove', (e) => tip.show(
        `<strong>${dname} ${String(h).padStart(2, '0')}:00–${String(h).padStart(2, '0')}:59</strong><br>${fmt(v)} complaints · ${((100 * v) / total).toFixed(1)}%`, e));
      r.addEventListener('mouseleave', () => tip.hide());
      svg.append(r);
    }
  });
  for (const h of [0, 6, 12, 18, 23]) {
    svg.append(el('text', { x: m.left + cw * h + cw / 2, y: height - 5, 'text-anchor': 'middle', class: 'tick' },
      h === 0 ? '12a' : h === 12 ? '12p' : h === 23 ? '11p' : h < 12 ? `${h}a` : `${h - 12}p`));
  }
  return svg;
}

/** Small bars with labels below (hours or weekdays) when there is too little data for a grid. */
export function smallBars(host, { values, labels, tips, color, height = 120, labelEvery = 1 }) {
  return columns(host, {
    data: values.map((v, i) => ({ label: i % labelEvery === 0 ? labels[i] : '', value: v, on: true, tip: tips[i] })),
    color, height,
  });
}

/**
 * Before -> now rows (dumbbell): a gray dot for the earlier period, an accent dot for now,
 * a line between, the change on the right. rows: [{label, before, now, tip}]
 */
export function dumbbells(host, { rows, color, beforeLabel, nowLabel }) {
  const rowH = 26;
  const height = rows.length * rowH + 26;
  const { svg, width, tip } = frame(host, height);
  const narrow = width < 420;
  const m = { left: narrow ? 120 : 170, right: 64, top: 18, bottom: 8 };
  const max = Math.max(1, ...rows.flatMap((r) => [r.before, r.now]));
  const { max: top } = niceTicks(max, 3);
  const x = (v) => m.left + (width - m.left - m.right) * (v / top);
  svg.append(el('text', { x: m.left, y: 11, class: 'tick' }, `○ ${beforeLabel}   ● ${nowLabel}`));
  rows.forEach((r, i) => {
    const y = m.top + rowH * i + rowH / 2;
    svg.append(el('line', { x1: m.left, x2: width - m.right, y1: y, y2: y, class: 'grid' }));
    const label = r.label.length > (narrow ? 17 : 26) ? `${r.label.slice(0, narrow ? 16 : 25)}…` : r.label;
    svg.append(el('text', { x: m.left - 8, y: y + 4, 'text-anchor': 'end', class: 'row-label' }, label));
    svg.append(el('line', { x1: x(r.before), x2: x(r.now), y1: y, y2: y, stroke: color, class: 'db-line' }));
    svg.append(el('circle', { cx: x(r.before), cy: y, r: 4.5, class: 'db-before' }));
    svg.append(el('circle', { cx: x(r.now), cy: y, r: 4.5, fill: color, class: 'db-now' }));
    const ch = r.before ? ((r.now - r.before) / r.before) * 100 : null;
    const txt = r.before < 20 || r.now < 20 ? `${fmt(r.before)}→${fmt(r.now)}` : `${ch > 0 ? '+' : ch < 0 ? '−' : ''}${Math.abs(ch).toFixed(0)}%`;
    svg.append(el('text', { x: width - 4, y: y + 4, 'text-anchor': 'end', class: 'row-value' }, txt));
    const hit = el('rect', { x: 0, y: y - rowH / 2, width, height: rowH, class: r.onClick ? 'hit clickable' : 'hit' });
    hover(hit, r, tip, r.onEnter ? hit : null);
    if (r.onClick) hit.addEventListener('click', r.onClick);
    svg.append(hit);
  });
  return svg;
}

/** Ranked horizontal bars, two lines per row: rank, name and a muted detail on top; the bar and its
 *  value below (so long names never get cut in the narrow panel). Rows: {name, detail?, value, tip,
 *  onEnter?, onLeave?, onClick?}, already sorted. */
export function rankBars(host, { rows, color }) {
  const rowH = 40;
  const height = rows.length * rowH + 4;
  const { svg, width, tip } = frame(host, height);
  const m = { left: 26, right: 56 };
  const max = Math.max(1, ...rows.map((r) => r.value));
  const x = (v) => (width - m.left - m.right) * (v / max);
  rows.forEach((r, i) => {
    const y0 = rowH * i;
    svg.append(el('text', { x: m.left - 8, y: y0 + 15, 'text-anchor': 'end', class: 'tick' }, String(i + 1)));
    const label = el('text', { x: m.left, y: y0 + 15, class: 'row-label' });
    label.append(el('tspan', {}, r.name));
    if (r.detail) label.append(el('tspan', { class: 'row-detail', dx: 6 }, r.detail));
    svg.append(label);
    const bw = Math.max(2, x(r.value));
    svg.append(el('path', { d: barPath(m.left, y0 + 22, bw, 11), fill: color, class: 'rank-bar' }));
    svg.append(el('text', { x: m.left + bw + 6, y: y0 + 31.5, class: 'bar-value' }, fmt(r.value)));
    const hit = el('rect', { x: 0, y: y0, width, height: rowH, class: r.onClick ? 'hit clickable' : 'hit' });
    hover(hit, r, tip, hit);
    if (r.onClick) hit.addEventListener('click', r.onClick);
    svg.append(hit);
  });
  return svg;
}

/** Horizontal bar: square at the baseline (left), 4 px rounded data end (right). */
function barPath(x, y, w, h) {
  const r = Math.min(4, h / 2, w);
  return `M${x},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h - r}Q${x + w},${y + h} ${x + w - r},${y + h}H${x}Z`;
}
