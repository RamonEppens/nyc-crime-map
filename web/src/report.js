// "View charts": how the selected place changed over time. The same six questions for every kind
// of selection; each module decides by itself whether it applies (and says why not), at what time
// resolution, and with what color, from three things: the dates picked, the offense types picked
// and how many complaints there are. The first module, "Over the years", is always shown.
import { columns, lines, heatmap, smallBars, dumbbells, rankBars } from './charts.js';
import { fmt, fmtChange } from './format.js';

const FIRST_YEAR = 2016;
const YEARS = Array.from({ length: 10 }, (_, i) => FIRST_YEAR + i);
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const yearOf = (m) => FIRST_YEAR + Math.floor(m / 12);
const pct = (a, b) => (b ? ((a - b) / b) * 100 : null);
// A change as a percentage, or as "a → b" when either count is under 20 (percentages on small
// numbers swing wildly; same rule as the panel).
const change = (a, b) => {
  if (a < 20 || b < 20) return `${fmt(b)} → ${fmt(a)}`;
  const c = pct(a, b);
  return c == null ? 'n/a' : fmtChange(c);
};
const sum = (xs) => xs.reduce((a, b) => a + b, 0);
// Compact before → now tooltip: name on the first line, both periods on the second.
const pairTip = (label, beforeLabel, before, nowLabel, now) =>
  `<strong>${label}</strong><br><span class="tip-muted">${beforeLabel}</span> ${fmt(before)} → <span class="tip-muted">${nowLabel}</span> ${fmt(now)}`;
const hourLabel = (h) => (h === 0 ? '12 am' : h === 12 ? '12 pm' : h < 12 ? `${h} am` : `${h - 12} pm`);

/**
 * ctx: {
 *   kind: 'city'|'borough'|'precinct'|'nta'|'hex'|'street'|'point', name,
 *   period, months: [m...] (selected), prevMonths: [m...] | null, prevLabel, periodLabel,
 *   cats: Set, categories, color,
 *   byCat(): Promise<Map<cat, Float64Array(120)>>   this place, every offense type, every month
 *   nycByCat(): Promise<Map<...>>                   the matching NYC baseline
 *   time(months, cats): Promise<{grid: 7x24, years: [y...] | null}>
 *   blocks(months, cats): Promise<[{label, key, street, block, n}]> | null (not available for this kind)
 *   highlightBlock(street, block): lights the block on the map; resolves to extra tooltip html
 *   clearHighlight()
 *   areas(months, cats): Promise<[{key, label, n}]> | undefined   neighborhoods of a borough
 *   highlightArea(key), selectArea(key), selectBlock(street, block)
 * }
 * Returns { sections: [{id, title, answer, note, draw(host)}], hidden: [{title, why}] }
 */
export async function buildReport(ctx) {
  const [place, nyc] = await Promise.all([ctx.byCat(), ctx.nycByCat()]);
  const sel = (map, cats = ctx.cats) => {
    const out = new Float64Array(120);
    for (const c of cats) { const a = map.get(c); if (a) for (let i = 0; i < 120; i++) out[i] += a[i]; }
    return out;
  };
  const allCats = new Set(ctx.categories.map((c) => c.code));
  const P = sel(place);
  const N = sel(nyc);
  const months = [...ctx.months].sort((a, b) => a - b);
  const selYears = [...new Set(months.map(yearOf))];
  const total = sum(months.map((m) => P[m]));
  const mode = ctx.period.mode;
  const isCity = ctx.kind === 'city';
  // A single year or month (or one month across years) is a snapshot: the place-lists (busiest
  // blocks, neighborhoods) show a plain ranking. Ranges ask about change: before → now.
  const ranking = mode === 'year' || mode === 'month' || !ctx.prevMonths;             // the city is its own baseline: no "vs NYC" there
  const sections = [];
  const hidden = [];
  const tasks = [];

  // 1. Over the years (always)
  {
    const moy = mode === 'month' ? ctx.period.month % 12 : mode === 'crossyear' ? ctx.period.crossMonth : null;
    const perYear = (arr) => YEARS.map((y, i) => (moy == null ? sum(Array.from({ length: 12 }, (_, k) => arr[i * 12 + k])) : arr[i * 12 + moy]));
    const py = perYear(P);
    const ny = perYear(N);
    const avgP = sum(py) / py.length;
    const avgN = sum(ny) / ny.length || 1;
    const scaled = ny.map((v) => (v * avgP) / avgN);
    const on = (y) => (mode === 'crossyear' ? true : selYears.includes(y));
    const unit = moy == null ? '' : ` in ${MONTH_NAMES[moy]}`;
    const first = selYears[0];
    const last = selYears.at(-1);
    const iy = (y) => y - FIRST_YEAR;
    let answer;
    if (mode === 'crossyear' || (first !== last)) {
      const a = mode === 'crossyear' ? FIRST_YEAR : first;
      const b = mode === 'crossyear' ? YEARS.at(-1) : last;
      answer = isCity ? `${a} to ${b}${unit}: ${change(py[iy(b)], py[iy(a)])}.`
        : `${a} to ${b}${unit}: ${change(py[iy(b)], py[iy(a)])} here, ${change(ny[iy(b)], ny[iy(a)])} in NYC.`;
    } else if (last > FIRST_YEAR) {
      answer = `${last}${unit}: ${fmt(py[iy(last)])} complaints, ${change(py[iy(last)], py[iy(last) - 1])} vs ${last - 1}`
        + (isCity ? '.' : ` (NYC ${change(ny[iy(last)], ny[iy(last) - 1])}).`);
    } else {
      answer = `${last}${unit}: ${fmt(py[iy(last)])} complaints; the data starts in 2016.`;
    }
    answer += ` Since 2016: ${change(py.at(-1), py[0])}${isCity ? '' : ` (NYC ${change(ny.at(-1), ny[0])})`}.`;
    sections.push({
      id: 'years',
      title: moy == null ? 'Over the years' : `${MONTH_NAMES[moy]}, year by year`,
      answer,
      legend: isCity ? [] : [['col', 'This place'], ['cmp', 'NYC, scaled to this place’s average']],
      note: avgP < 12 ? 'Few complaints per year here, so year-to-year changes are mostly chance.' : '',
      draw: (host) => columns(host, {
        color: ctx.color,
        data: YEARS.map((y, i) => ({
          label: `'${String(y).slice(2)}`, value: py[i], on: on(y),
          tip: `<strong>${y}${unit}</strong><br>${fmt(py[i])} complaints${isCity ? '' : ' here'}${i ? ` (${change(py[i], py[i - 1])})` : ''}`
            + (isCity ? '' : `<br>NYC: ${fmt(ny[i])}${i ? ` (${change(ny[i], ny[i - 1])})` : ''}`),
        })),
        line: isCity ? null : scaled.map((v) => ({ value: v })),
      }),
    });
  }

  // 2. Month by month
  if (!['year', 'yearRange', 'monthRange'].includes(mode)) {
    hidden.push({ title: 'Month by month', why: 'pick a year or a range to see it month by month' });
  } else if (total < 30) {
    hidden.push({ title: 'Month by month', why: `only ${fmt(total)} complaints, too few for a monthly line` });
  } else {
    const short = months.length <= 24;
    const labels = months.map((m) => (short ? (m % 12 === 0 || months.length <= 13 ? MONTHS[m % 12] : MONTHS[m % 12]) : m % 12 === 0 ? String(yearOf(m)) : ''));
    const cur = months.map((m) => P[m]);
    const series = [{ values: cur, cls: short ? 'main' : 'thin' }];
    let answer;
    const peak = months.reduce((a, m) => (P[m] > P[a] ? m : a), months[0]);
    if (short) {
      const prev = months.map((m) => (m >= 12 ? P[m - 12] : null));
      if (prev.some((v) => v != null)) series.unshift({ values: prev, cls: 'cmp' });
      const prevTotal = sum(prev.filter((v) => v != null));
      answer = `Busiest month: ${MONTH_NAMES[peak % 12]} ${yearOf(peak)} (${fmt(P[peak])}).`
        + (prev.every((v) => v != null) ? ` Same months a year earlier: ${fmt(prevTotal)} (${change(total, prevTotal)} now).` : '');
    } else {
      const avg = months.map((m, i) => (i >= 11 ? sum(months.slice(i - 11, i + 1).map((k) => P[k])) / 12 : null));
      series.push({ values: avg, cls: 'avg' });
      const a0 = avg.find((v) => v != null);
      const a1 = avg.at(-1);
      answer = `12-month average: ${fmt(a0)} a month at the start, ${fmt(a1)} at the end (${change(a1, a0)}). Busiest month: ${MONTH_NAMES[peak % 12]} ${yearOf(peak)}.`;
    }
    const tips = months.map((m, i) => `<strong>${MONTH_NAMES[m % 12]} ${yearOf(m)}</strong><br>${fmt(P[m])} complaints`
      + (short && m >= 12 ? `<br>${MONTH_NAMES[m % 12]} ${yearOf(m) - 1}: ${fmt(P[m - 12])}` : '')
      + (!short && series[1]?.values[i] != null ? `<br>12-month average: ${fmt(series[1].values[i])}` : ''));
    sections.push({
      id: 'months', title: 'Month by month', answer,
      legend: short ? [['main', 'Selected months'], ['cmp', 'A year earlier']] : [['thin', 'Each month'], ['avg', '12-month average']],
      draw: (host) => lines(host, { series, labels, tips, color: ctx.color, tickEvery: short ? (months.length > 12 ? 3 : 2) : 1 }),
    });
  }

  // 3. When in the year: the seasonal shape over two or more whole years, vs NYC's
  {
    const years = mode === 'yearRange' ? selYears : [];
    if (mode !== 'yearRange' || years.length < 2) {
      hidden.push({ title: 'When in the year', why: 'needs a range of two or more whole years' });
    } else if (total < 120) {
      hidden.push({ title: 'When in the year', why: `only ${fmt(total)} complaints, too few for a seasonal pattern` });
    } else {
      const share = (arr) => {
        const byM = Array.from({ length: 12 }, (_, k) => sum(years.map((y) => arr[(y - FIRST_YEAR) * 12 + k])));
        const t = sum(byM) || 1;
        return byM.map((v) => (100 * v) / t);
      };
      const sp = share(P);
      const sn = share(N);
      const top = sp.indexOf(Math.max(...sp));
      const low = sp.indexOf(Math.min(...sp));
      sections.push({
        id: 'season', title: 'When in the year',
        answer: `Busiest: ${MONTH_NAMES[top]} (${sp[top].toFixed(1)}% of the year); quietest: ${MONTH_NAMES[low]} (${sp[low].toFixed(1)}%).`
          + (isCity ? '' : ` NYC peaks in ${MONTH_NAMES[sn.indexOf(Math.max(...sn))]}.`),
        legend: isCity ? [] : [['col', 'This place'], ['cmp', 'NYC']],
        note: `Share of each year's complaints by month, ${years[0]} to ${years.at(-1)} together. A flat shape would be 8.3% a month.`,
        draw: (host) => columns(host, {
          color: ctx.color, height: 150,
          data: sp.map((v, k) => ({ label: MONTHS[k][0], value: v, on: true, tip: `<strong>${MONTH_NAMES[k]}</strong><br>${v.toFixed(1)}% of the year${isCity ? '' : ` here<br>NYC: ${sn[k].toFixed(1)}%`}` })),
          line: isCity ? null : sn.map((v) => ({ value: v })),
        }),
      });
    }
  }

  // 4. Day and hour (time of occurrence)
  tasks.push((async () => {
    const t = await ctx.time(months, ctx.cats);
    const flat = t.grid.flat();
    const n = sum(flat);
    if (n < 100) {
      hidden.push({ title: 'Day and hour', why: `only ${fmt(n)} complaints with a time, too few for a pattern` });
      return null;
    }
    let bd = 0; let bh = 0;
    t.grid.forEach((row, d) => row.forEach((v, h) => { if (v > t.grid[bd][bh]) { bd = d; bh = h; } }));
    const nights = sum(t.grid.flatMap((row) => row.filter((_, h) => h >= 22 || h < 6)));
    const weekend = sum(t.grid[5]) + sum(t.grid[6]);
    const yearsNote = t.years ? ` Uses whole report years ${t.years[0]}${t.years.length > 1 ? `–${t.years.at(-1)}` : ''}.` : '';
    const sec = {
      id: 'time', title: 'Day and hour',
      answer: `Busiest: ${DAYS[bd]}s around ${hourLabel(bh)}. Nights (10 pm–6 am): ${((100 * nights) / n).toFixed(0)}% of complaints; weekends: ${((100 * weekend) / n).toFixed(0)}% (two of seven days is 29%).`,
      note: `When the incident happened, as reported. Unknown times are often recorded as midnight or noon, so those hours run slightly high.${yearsNote}`,
    };
    if (n >= 500) {
      sec.draw = (host) => heatmap(host, { grid: t.grid, color: ctx.color });
    } else {
      const byHour = Array.from({ length: 24 }, (_, h) => sum(t.grid.map((row) => row[h])));
      sec.draw = (host) => smallBars(host, {
        values: byHour, labels: byHour.map((_, h) => hourLabel(h).replace(' ', '')), labelEvery: 6, color: ctx.color,
        tips: byHour.map((v, h) => `<strong>${hourLabel(h)}</strong><br>${fmt(v)} complaints`),
      });
    }
    return sec;
  })());

  // 5. What changed: offense types now vs the period before (or one type's share over the years)
  tasks.push((async () => {
    if (ctx.cats.size === 1) {
      const [c] = [...ctx.cats];
      const all = sel(place, allCats);
      const allN = sel(nyc, allCats);
      const share = (num, den) => YEARS.map((_, i) => {
        const a = sum(Array.from({ length: 12 }, (_, k) => num[i * 12 + k]));
        const b = sum(Array.from({ length: 12 }, (_, k) => den[i * 12 + k]));
        return b ? (100 * a) / b : null;
      });
      const sp = share(place.get(c) ?? new Float64Array(120), all);
      const sn = share(nyc.get(c) ?? new Float64Array(120), allN);
      if (sum(all) < 50) {
        hidden.push({ title: 'What changed', why: 'too few complaints here to follow one type’s share' });
        return null;
      }
      const label = ctx.categories[c].label;
      return {
        id: 'mix', title: `${label}: share of all complaints`,
        answer: `${label} was ${sp[0]?.toFixed(1)}% of complaints${isCity ? '' : ' here'} in 2016 and ${sp.at(-1)?.toFixed(1)}% in 2025`
          + (isCity ? '.' : ` (NYC: ${sn[0]?.toFixed(1)}% → ${sn.at(-1)?.toFixed(1)}%).`),
        legend: isCity ? [] : [['main', 'This place'], ['cmp', 'NYC']],
        draw: (host) => lines(host, {
          series: isCity ? [{ values: sp, cls: 'main' }] : [{ values: sn, cls: 'cmp' }, { values: sp, cls: 'main' }],
          labels: YEARS.map((y) => `'${String(y).slice(2)}`), color: ctx.color,
          tips: YEARS.map((y, i) => `<strong>${y}</strong><br>${sp[i]?.toFixed(1) ?? '–'}% here<br>NYC: ${sn[i]?.toFixed(1) ?? '–'}%`),
        }),
      };
    }
    if (!ctx.prevMonths) {
      hidden.push({ title: 'What changed', why: 'no earlier period to compare (the data starts in 2016)' });
      return null;
    }
    const rows = [...ctx.cats].map((c) => {
      const a = place.get(c) ?? new Float64Array(120);
      const now = sum(months.map((m) => a[m]));
      const before = sum(ctx.prevMonths.map((m) => a[m]));
      return { c, label: ctx.categories[c].label, now, before };
    }).filter((r) => r.now + r.before > 0);
    if (sum(rows.map((r) => r.now + r.before)) < 40) {
      hidden.push({ title: 'What changed', why: 'too few complaints to compare offense types' });
      return null;
    }
    const top = rows.sort((a, b) => b.now + b.before - (a.now + a.before)).slice(0, 8)
      .sort((a, b) => Math.abs(b.now - b.before) - Math.abs(a.now - a.before));
    const up = rows.reduce((a, r) => (r.now - r.before > (a ? a.now - a.before : 0) ? r : a), null);
    const down = rows.reduce((a, r) => (r.now - r.before < (a ? a.now - a.before : 0) ? r : a), null);
    return {
      id: 'mix', title: 'What changed',
      answer: [up && `Biggest rise: ${up.label} (+${fmt(up.now - up.before)})`, down && `biggest drop: ${down.label} (−${fmt(down.before - down.now)})`]
        .filter(Boolean).join('; ') + `, ${ctx.prevLabel.replace(/^vs /, 'compared with ')}.`,
      note: 'The eight most common offense types here, ordered by how much they changed.',
      draw: (host) => dumbbells(host, {
        color: ctx.color, beforeLabel: ctx.prevLabel.replace(/^vs /, ''), nowLabel: ctx.periodLabel,
        rows: top.map((r) => ({ ...r, tip: pairTip(r.label, ctx.prevLabel.replace(/^vs /, ''), r.before, ctx.periodLabel, r.now) })),
      }),
    };
  })());

  // 6. Where exactly
  tasks.push((async () => {
    if (!ctx.blocks) {
      hidden.push({ title: 'Where exactly', why: ctx.kind === 'point' ? 'the map shows each complaint location around this point' : 'pick a borough, neighborhood, precinct or street' });
      return null;
    }
    const [now] = await Promise.all([ctx.blocks(months, ctx.cats)]);
    const before = ctx.prevMonths ? await ctx.blocks(ctx.prevMonths, ctx.cats, now) : [];
    if (!now.length) {
      hidden.push({ title: 'Where exactly', why: 'no complaints with a block in this selection' });
      return null;
    }
    const prev = new Map(before.map((b) => [b.key, b.n]));
    if (ctx.kind === 'street') {
      const ordered = [...now].sort((a, b) => a.order - b.order);
      const topN = [...now].sort((a, b) => b.n - a.n).slice(0, 3);
      const topKeys = new Set(topN.map((b) => b.key));
      return {
        id: 'where', title: 'Along the street',
        answer: `Busiest blocks: ${topN.map((b) => `${b.label} (${fmt(b.n)})`).join(', ')}.`,
        note: 'Complaints per hundred-block of house numbers, in street order; both sides together.',
        draw: (host) => columns(host, {
          color: ctx.color, height: 150, every: Math.max(1, Math.ceil(ordered.length / 6)),
          data: ordered.map((b) => ({
            label: b.short, value: b.n, on: topKeys.has(b.key),
            onEnter: () => ctx.highlightBlock?.(b.street, b.block), onLeave: ctx.clearHighlight,
            tip: `<strong>${b.label}</strong>: ${fmt(b.n)} complaints${ctx.prevMonths ? ` <span class="tip-muted">(${ctx.prevLabel.replace(/^vs /, '')}: ${fmt(prev.get(b.key) ?? 0)})</span>` : ''}`,
          })),
        }),
      };
    }
    const nav = (b) => ({ onEnter: () => ctx.highlightBlock?.(b.street, b.block), onLeave: ctx.clearHighlight, onClick: () => ctx.selectBlock?.(b.street, b.block) });
    if (ranking) {
      const top = now.slice(0, 10);
      const prevL = ctx.prevLabel?.replace(/^vs /, '');
      return {
        id: 'where', title: 'Busiest blocks',
        answer: `Top block: ${top[0].label} (${fmt(top[0].n)}).`,
        note: 'The ten hundred-blocks with the most complaints in this period, both sides of the street together; an intersection counts for each street that meets there. Hover to see one on the map; click to go there.',
        draw: (host) => rankBars(host, {
          color: ctx.color,
          rows: top.map((b) => ({
            name: b.name ?? b.label, detail: b.range, value: b.n, ...nav(b),
            tip: `<strong>${b.label}</strong>: ${fmt(b.n)} complaints${ctx.prevMonths ? ` <span class="tip-muted">(${prevL}: ${fmt(prev.get(b.key) ?? 0)})</span>` : ''}`,
          })),
        }),
      };
    }
    const rows = now.slice(0, 8).map((b) => ({
      label: b.label, now: b.n, before: prev.get(b.key) ?? 0, ...nav(b),
      tip: pairTip(b.label, ctx.prevLabel?.replace(/^vs /, '') ?? 'Before', prev.get(b.key) ?? 0, ctx.periodLabel, b.n),
    }));
    return {
      id: 'where', title: 'Busiest blocks',
      answer: `Top block: ${rows[0].label} (${fmt(rows[0].now)}).`,
      note: 'Hundred-blocks of house numbers, both sides together; an intersection counts for each street that meets there.',
      draw: (host) => dumbbells(host, {
        color: ctx.color, beforeLabel: ctx.prevLabel?.replace(/^vs /, '') ?? 'before', nowLabel: ctx.periodLabel, rows,
      }),
    };
  })());

  // 7. Neighborhoods (boroughs only): every neighborhood of the borough; a ranking for a snapshot,
  // before → now for a range.
  tasks.push((async () => {
    if (!ctx.areas) return null;
    const [now, before] = await Promise.all([ctx.areas(months, ctx.cats), ctx.prevMonths ? ctx.areas(ctx.prevMonths, ctx.cats) : []]);
    const prev = new Map(before.map((a) => [a.key, a.n]));
    const all = now.map((a) => ({ ...a, now: a.n, before: prev.get(a.key) ?? 0 }))
      .filter((a) => a.now + a.before > 0).sort((a, b) => b.now - a.now);
    if (!all.length) {
      hidden.push({ title: 'Neighborhoods', why: 'no mapped complaints in this selection' });
      return null;
    }
    const prevL = ctx.prevLabel?.replace(/^vs /, '') ?? '';
    const nav = (a) => ({ onEnter: () => ctx.highlightArea?.(a.key), onLeave: ctx.clearHighlight, onClick: () => ctx.selectArea?.(a.key) });
    // "Show all" under the first rows; the chart is redrawn in place.
    const withMore = (first, drawRows) => function draw(host) {
      const showAll = host.dataset.all === '1';
      host.querySelector(':scope > .chart-more')?.remove();
      drawRows(host, showAll ? all : all.slice(0, first));
      if (all.length > first) {
        const btn = document.createElement('button');
        btn.className = 'chart-more';
        btn.textContent = showAll ? 'Show fewer' : `Show all ${all.length} neighborhoods`;
        btn.onclick = () => { host.dataset.all = showAll ? '' : '1'; draw(host); };
        host.append(btn);
      }
    };
    if (ranking) {
      return {
        id: 'areas', title: 'Neighborhoods',
        answer: `Most complaints: ${all[0].label} (${fmt(all[0].now)}), then ${all.slice(1, 3).map((a) => `${a.label} (${fmt(a.now)})`).join(' and ')}.`,
        note: "Mapped complaints inside each neighborhood in this period. Counts grow with size and population; per-resident figures are in each neighborhood's panel. Hover to see one on the map; click to open it.",
        draw: withMore(10, (host, rows) => rankBars(host, {
          color: ctx.color,
          rows: rows.map((a) => ({
            name: a.label, value: a.now, ...nav(a),
            tip: `<strong>${a.label}</strong>: ${fmt(a.now)} complaints${ctx.prevMonths ? ` <span class="tip-muted">(${prevL}: ${fmt(a.before)})</span>` : ''}`,
          })),
        })),
      };
    }
    // Rise and drop in percent, among residential neighborhoods big enough for a percentage to mean something.
    const big = all.filter((a) => a.residential !== false && a.now >= 100 && a.before >= 100);
    const up = big.reduce((a, r) => (!a || r.now / r.before > a.now / a.before ? r : a), null);
    const down = big.reduce((a, r) => (!a || r.now / r.before < a.now / a.before ? r : a), null);
    return {
      id: 'areas', title: 'Neighborhoods',
      answer: (up?.now > up?.before || down?.now < down?.before)
        ? [up?.now > up?.before && `Biggest rise: ${up.label} (${fmtChange(pct(up.now, up.before))})`,
          down?.now < down?.before && `biggest drop: ${down.label} (${fmtChange(pct(down.now, down.before))})`]
          .filter(Boolean).join('; ').replace(/^b/, 'B') + `, ${ctx.prevLabel.replace(/^vs /, 'compared with ')}.`
        : `Most complaints: ${all[0].label} (${fmt(all[0].now)}).`,
      note: "Mapped complaints inside each neighborhood, busiest first; counts grow with size and population (per-resident figures are in each neighborhood's panel). Rise and drop among residential neighborhoods (not parks or airports) with at least 100 complaints in both periods. Click a row to open it.",
      draw: withMore(12, (host, rows) => dumbbells(host, {
        color: ctx.color, beforeLabel: prevL, nowLabel: ctx.periodLabel,
        rows: rows.map((a) => ({ ...a, ...nav(a), tip: pairTip(a.label, prevL, a.before, ctx.periodLabel, a.now) })),
      })),
    };
  })());

  for (const s of await Promise.all(tasks)) if (s) sections.push(s);
  const order = ['years', 'months', 'season', 'time', 'mix', 'areas', 'where'];
  sections.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  return { sections, hidden };
}
