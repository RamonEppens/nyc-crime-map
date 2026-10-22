// "View charts": how the selected place changed over time. The same six questions for every kind
// of selection; each module decides by itself whether it applies (and says why not), at what time
// resolution, and with what color, from three things: the dates picked, the offense types picked
// and how many complaints there are. The first module, "Over the years", is always shown.
import { columns, lines, heatmap, smallBars, dumbbells, rankBars, timeline } from './charts.js';
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
  // A single complaint location: comparing one point with the whole city (scaled lines, shares) says
  // little, so its charts drop NYC and ask point-sized questions instead (decision #76).
  const isSpot = ctx.kind === 'spot';
  const noNyc = isCity || isSpot;
  // A single year or month (or one month across years) is a snapshot: the place-lists (busiest
  // blocks, neighborhoods) show a plain ranking. Ranges ask about change: before → now.
  const ranking = mode === 'year' || mode === 'month' || !ctx.prevMonths;             // the city is its own baseline: no "vs NYC" there
  const sections = [];
  const hidden = [];
  // Comparisons with the baseline: a period longer than a year is compared as its yearly average.
  const sc = ctx.prevScale ?? 1;
  const nowLabel = sc === 1 ? ctx.periodLabel : `${ctx.periodLabel}, a year`;
  const scaled = (v) => Math.round(v * sc);
  const tasks = [];

  // 1. Over the years (always). One baseline, 2019 (decision #77): for a place, an index chart,
  // 2019 = 100 for both the place (columns) and NYC (a grey line), so the line never reads as a
  // count. The city and a single location show plain counts (nothing to index against).
  {
    const moy = mode === 'month' ? ctx.period.month % 12 : mode === 'crossyear' ? ctx.period.crossMonth : null;
    const perYear = (arr) => YEARS.map((y, i) => (moy == null ? sum(Array.from({ length: 12 }, (_, k) => arr[i * 12 + k])) : arr[i * 12 + moy]));
    const py = perYear(P);
    const ny = perYear(N);
    const avgP = sum(py) / py.length;
    const on = (y) => (mode === 'crossyear' ? true : selYears.includes(y));
    const unit = moy == null ? '' : ` in ${MONTH_NAMES[moy]}`;
    const iy = (y) => y - FIRST_YEAR;
    const B = iy(2019);
    const indexed = !noNyc && py[B] > 0 && ny[B] > 0;
    const idx = (arr, i) => (100 * arr[i]) / arr[B];
    const first = selYears[0];
    const last = selYears.at(-1);
    // The selected years against 2019 (a range as its yearly average), here and in NYC.
    const avgOf = (arr) => sum(selYears.map((y) => arr[iy(y)])) / selYears.length;
    const ref = (arr) => (first > 2019 || (first === last && first !== 2019) ? arr[B] : null);
    let answer;
    const nowP = avgOf(py), nowN = avgOf(ny);
    const label = first === last ? `${last}${unit}` : `${first} to ${last}${unit}, a year on average`;
    const usedAfter2019 = isSpot && py.findIndex((v) => v > 0) > B;    // a point created later: no 2019 comparison
    if (mode !== 'crossyear' && ref(py) != null && !usedAfter2019) {
      answer = `${label}: ${fmt(nowP)} complaints, ${change(nowP, py[B])} vs 2019`
        + (noNyc ? '.' : ` (NYC ${change(nowN, ny[B])}).`);
    } else {
      const a = mode === 'crossyear' ? FIRST_YEAR : first;
      const b = mode === 'crossyear' ? YEARS.at(-1) : last;
      answer = a === b ? `${a}${unit}: ${fmt(py[iy(a)])} complaints.`
        : `${a} to ${b}${unit}: ${change(py[iy(b)], py[iy(a)])}${noNyc ? '' : ` here, ${change(ny[iy(b)], ny[iy(a)])} in NYC`}.`;
    }
    // A point that only appears in later years: say so (NYPD's placement changes; earlier complaints
    // on this stretch may sit at a nearby point), instead of an "up from 0" that reads as a surge.
    const firstUsed = py.findIndex((v) => v > 0);
    if (isSpot && firstUsed > 0) answer += ` No complaints were placed at this point before ${YEARS[firstUsed]}; earlier ones from this stretch may sit at a nearby point.`;
    sections.push({
      id: 'years',
      title: moy == null ? 'Over the years' : `${MONTH_NAMES[moy]}, year by year`,
      answer,
      legend: indexed ? [['col', 'This place'], ['cmp', 'NYC']] : [],
      note: [indexed ? 'Index: each year’s complaints as a share of 2019 (2019 = 100), here and in NYC, so the two can be compared whatever their size.' : '',
        avgP < 12 ? 'Few complaints per year here, so year-to-year changes are mostly chance.' : ''].filter(Boolean).join(' '),
      draw: (host) => columns(host, {
        color: ctx.color, colorOff: ctx.colorOff, axisNote: indexed ? '2019 = 100' : '',
        data: YEARS.map((y, i) => ({
          label: `'${String(y).slice(2)}`, value: indexed ? idx(py, i) : py[i], on: on(y),
          tip: `<strong>${y}${unit}</strong><br>${fmt(py[i])} complaints${isCity ? '' : ' here'}${indexed ? ` (index ${Math.round(idx(py, i))})` : ''}`
            + (indexed ? `<br>NYC: ${fmt(ny[i])} (index ${Math.round(idx(ny, i))})` : ''),
        })),
        line: indexed ? YEARS.map((_, i) => ({ value: idx(ny, i) })) : null,
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
    if (isSpot) {
      hidden.push({ title: 'When in the year', why: 'one location has too few complaints for a seasonal shape; see month by month' });
    } else if (mode !== 'yearRange' || years.length < 2) {
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
        answer: `${label} was ${sp[0]?.toFixed(1)}% of complaints${noNyc ? '' : ' here'} in 2016 and ${sp.at(-1)?.toFixed(1)}% in 2025`
          + (noNyc ? '.' : ` (NYC: ${sn[0]?.toFixed(1)}% → ${sn.at(-1)?.toFixed(1)}%).`),
        legend: noNyc ? [] : [['main', 'This place'], ['cmp', 'NYC']],
        draw: (host) => lines(host, {
          series: noNyc ? [{ values: sp, cls: 'main' }] : [{ values: sn, cls: 'cmp' }, { values: sp, cls: 'main' }],
          labels: YEARS.map((y) => `'${String(y).slice(2)}`), color: ctx.color,
          tips: YEARS.map((y, i) => `<strong>${y}</strong><br>${sp[i]?.toFixed(1) ?? '–'}% here<br>NYC: ${sn[i]?.toFixed(1) ?? '–'}%`),
        }),
      };
    }
    if (!ctx.prevMonths) {
      hidden.push({ title: 'What changed', why: 'no earlier period to compare (the data starts in 2016)' });
      return null;
    }
    if (isSpot && sum(ctx.prevMonths.map((m) => P[m])) === 0) {
      hidden.push({ title: 'What changed', why: `no complaints were placed at this point ${ctx.prevLabel.replace(/^vs /, 'in ')}` });
      return null;
    }
    const rows = [...ctx.cats].map((c) => {
      const a = place.get(c) ?? new Float64Array(120);
      const now = scaled(sum(months.map((m) => a[m])));
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
      note: `The eight most common offense types here, ordered by the change in number of complaints${sc === 1 ? '' : ' (this period as a yearly average)'}.`,
      draw: (host) => dumbbells(host, {
        color: ctx.color, beforeLabel: ctx.prevLabel.replace(/^vs /, ''), nowLabel,
        rows: top.map((r) => ({ ...r, tip: pairTip(r.label, ctx.prevLabel.replace(/^vs /, ''), r.before, nowLabel, r.now) })),
      }),
    };
  })());

  // Single location with few complaints: the complaints themselves (decision #79). With so few, a
  // pattern chart would say nothing, but when and what each one was does: the same night, or spread
  // over the year?
  if (isSpot && ctx.spot && total > 0 && total <= 50) {
    tasks.push((async () => {
      const rows = await ctx.spot.each(months, ctx.cats);
      if (!rows.length) return null;
      const dayOf = (m) => Math.round((Date.UTC(2016 + Math.floor(m / 12), m % 12, 1) - Date.UTC(2016, 0, 1)) / 864e5);
      const span = [dayOf(months[0]), dayOf(months.at(-1) + 1) - 1];
      const date = (d, opts) => new Date(Date.UTC(2016, 0, 1 + d)).toLocaleDateString('en-US', { timeZone: 'UTC', ...opts });
      const full = (d) => date(d, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
      const when = (r) => (r.hour >= 0 && r.dow >= 0 ? `happened a ${DAYS[r.dow]} around ${hourLabel(r.hour)}` : 'time not recorded');
      const name = (r) => `${ctx.categories[r.cat]?.label ?? 'Other'}${r.att ? ' (attempted)' : ''}`;
      // Ticks: months for a year or less, years for longer periods.
      const ticks = [];
      if (months.length <= 13) for (const m of months) ticks.push({ d: dayOf(m), label: MONTHS[m % 12][0] });
      else for (const m of months) if (m % 12 === 0) ticks.push({ d: dayOf(m), label: `'${String(yearOf(m)).slice(2)}` });
      const sameDay = new Set(rows.map((r) => r.d)).size;
      const spread = sameDay === 1 ? `All ${rows.length} were reported on the same day, ${full(rows[0].d)}.`
        : `${rows.length} complaints on ${sameDay} different days, from ${full(rows[0].d)} to ${full(rows.at(-1).d)}.`;
      return {
        id: 'each', title: 'Each complaint',
        answer: spread,
        note: 'By report date; the day and hour are when it happened, as reported (unknown times are often recorded as midnight or noon). Locations are rounded by the NYPD, so complaints here may come from anywhere along this stretch of street or corner.',
        draw: (host) => {
          timeline(host, { days: span, ticks, items: rows.map((r) => ({ d: r.d, color: ctx.groupColor(r.cat),
            tip: `<strong>${name(r)}</strong><br>Reported ${full(r.d)}<br><span class="tip-muted">${when(r)}</span>` })) });
          host.querySelector(':scope > .each-list')?.remove();     // redraws (resize) replace the list
          const list = document.createElement('ol');
          list.className = 'each-list';
          list.innerHTML = rows.map((r) => `<li><i style="background:${ctx.groupColor(r.cat)}" aria-hidden="true"></i>
            <span class="each-what">${name(r)}</span><span class="each-when">Reported ${full(r.d)} · ${when(r)}${r.prem ? ` · ${r.prem}` : ''}</span></li>`).join('');
          host.append(list);
        },
      };
    })());
  }

  // Single location: what kind of place it is, and whether its complaints arrive in batches.
  if (isSpot && ctx.spot) {
    tasks.push((async () => {
      const rows = await ctx.spot.premises(months, ctx.cats);
      const n = sum(rows.map((r) => r.n));
      if (n < 10) { hidden.push({ title: 'What kind of place', why: `only ${fmt(n)} complaints` }); return null; }
      const top = rows.slice(0, 6);
      const share = (v) => `${Math.round((100 * v) / n)}%`;
      return {
        id: 'premise', title: 'What kind of place',
        answer: `Reported as ${top[0].label.toLowerCase()} (${share(top[0].n)})${top[1] ? `, then ${top[1].label.toLowerCase()} (${share(top[1].n)})` : ''}.`,
        note: 'The premise type the officer recorded for each complaint. A store, a station or an office here often means complaints filed by the business, not on the street.',
        draw: (host) => rankBars(host, { color: ctx.color, rows: top.map((r) => ({ name: r.label, detail: share(r.n), value: r.n,
          tip: `<strong>${r.label}</strong><br>${fmt(r.n)} complaints, ${share(r.n)}` })) }),
      };
    })());
    tasks.push((async () => {
      const days = await ctx.spot.days(months, ctx.cats);
      const n = total;                                 // every complaint at this point in the period
      if (n < 20) { hidden.push({ title: 'Busiest days', why: `only ${fmt(n)} complaints` }); return null; }
      const top = days.slice(0, 5);
      const fmtDay = (d) => new Date(Date.UTC(2016, 0, 1 + d)).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
      const topShare = (100 * sum(top.map((r) => r.n))) / n;
      const batch = top[0].n >= 5 && (100 * top[0].n) / n >= 5;
      return {
        id: 'days', title: 'Busiest days',
        answer: `${fmtDay(top[0].d)}: ${fmt(top[0].n)} complaints (${Math.round((100 * top[0].n) / n)}% of this period). The five busiest days hold ${Math.round(topShare)}%.`
          + (batch ? ' Many complaints on one day usually means a batch filed together, not a spike in incidents.' : ' Complaints are spread out over time.'),
        note: 'By report date; shares are of all complaints at this point in the period.',
        draw: (host) => rankBars(host, { color: ctx.color, rows: top.map((r) => ({ name: fmtDay(r.d), value: r.n,
          tip: `<strong>${fmtDay(r.d)}</strong><br>${fmt(r.n)} complaints` })) }),
      };
    })());
  }

  // 6. Where exactly
  tasks.push((async () => {
    if (!ctx.blocks) {
      hidden.push({ title: 'Where exactly', why: ctx.kind === 'spot' ? 'this is a single location' : ctx.kind === 'point' ? 'the map shows each complaint location around this point' : 'pick a borough, neighborhood, precinct or street' });
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
      label: b.label, now: scaled(b.n), before: prev.get(b.key) ?? 0, ...nav(b),
      tip: pairTip(b.label, ctx.prevLabel?.replace(/^vs /, '') ?? 'Before', prev.get(b.key) ?? 0, nowLabel, scaled(b.n)),
    }));
    return {
      id: 'where', title: 'Busiest blocks',
      answer: `Top block: ${rows[0].label} (${fmt(rows[0].now)}).`,
      note: 'Hundred-blocks of house numbers, both sides together; an intersection counts for each street that meets there.',
      draw: (host) => dumbbells(host, {
        color: ctx.color, beforeLabel: ctx.prevLabel?.replace(/^vs /, '') ?? 'before', nowLabel, rows,
      }),
    };
  })());

  // 7. Neighborhoods (boroughs only), by complaints per 1,000 residents a year (counts mostly measure
  // size); neighborhoods with fewer than 2,000 residents (parks, airports) are listed apart, unrated.
  tasks.push((async () => {
    if (!ctx.areas) return null;
    const [now, before] = await Promise.all([ctx.areas(months, ctx.cats), ctx.prevMonths ? ctx.areas(ctx.prevMonths, ctx.cats) : []]);
    const prev = new Map(before.map((a) => [a.key, a.n]));
    const yrsNow = months.length / 12;
    const yrsBefore = (ctx.prevMonths?.length ?? 12) / 12;
    const rate = (n, pop, yrs) => (1000 * n) / pop / yrs;
    const rows = now.map((a) => ({ ...a, before: prev.get(a.key) ?? 0 })).filter((a) => a.n + a.before > 0);
    const rated = rows.filter((a) => a.pop >= 2000)
      .map((a) => ({ ...a, now: rate(a.n, a.pop, yrsNow), was: rate(a.before, a.pop, yrsBefore) }))
      .sort((a, b) => b.now - a.now);
    const unrated = rows.filter((a) => !(a.pop >= 2000));
    if (!rated.length) {
      hidden.push({ title: 'Neighborhoods', why: 'no mapped complaints in this selection' });
      return null;
    }
    const prevL = ctx.prevLabel?.replace(/^vs /, '') ?? '';
    const r1 = (v) => (v >= 100 ? fmt(v) : v.toFixed(1));
    const nav = (a) => ({ onEnter: () => ctx.highlightArea?.(a.key), onLeave: ctx.clearHighlight, onClick: () => ctx.selectArea?.(a.key) });
    const withMore = (first, drawRows) => function draw(host) {
      const showAll = host.dataset.all === '1';
      host.querySelector(':scope > .chart-more')?.remove();
      drawRows(host, showAll ? rated : rated.slice(0, first));
      if (rated.length > first) {
        const btn = document.createElement('button');
        btn.className = 'chart-more';
        btn.textContent = showAll ? 'Show fewer' : `Show all ${rated.length} neighborhoods`;
        btn.onclick = () => { host.dataset.all = showAll ? '' : '1'; draw(host); };
        host.append(btn);
      }
    };
    const unratedNote = unrated.length ? ` Not rated (fewer than 2,000 residents): ${unrated.map((a) => a.label).join(', ')}.` : '';
    if (ranking || !ctx.prevMonths) {
      return {
        id: 'areas', title: 'Neighborhoods',
        answer: `Highest rate: ${rated[0].label} (${r1(rated[0].now)} per 1,000 residents a year), then ${rated.slice(1, 3).map((a) => `${a.label} (${r1(a.now)})`).join(' and ')}.`,
        note: `Mapped complaints per 1,000 residents a year (2020 Census), with the count beside each name. Places where few people live but many visit come out high. Hover to see one on the map; click to open it.${unratedNote}`,
        draw: withMore(10, (host, list) => rankBars(host, {
          color: ctx.color,
          rows: list.map((a) => ({
            name: a.label, detail: `${fmt(a.n)} complaints`, value: a.now, valueLabel: r1(a.now), ...nav(a),
            tip: `<strong>${a.label}</strong><br>${r1(a.now)} per 1,000 residents a year<br>${fmt(a.n)} complaints${ctx.prevMonths ? ` <span class="tip-muted">(${prevL}: ${fmt(a.before)})</span>` : ''}`,
          })),
        })),
      };
    }
    const big = rated.filter((a) => a.n >= 100 && a.before >= 100);
    const up = big.reduce((a, r) => (!a || r.now / r.was > a.now / a.was ? r : a), null);
    const down = big.reduce((a, r) => (!a || r.now / r.was < a.now / a.was ? r : a), null);
    return {
      id: 'areas', title: 'Neighborhoods',
      answer: (up?.now > up?.was || down?.now < down?.was)
        ? [up?.now > up?.was && `Biggest rise: ${up.label} (${fmtChange(pct(up.now, up.was))})`,
          down?.now < down?.was && `biggest drop: ${down.label} (${fmtChange(pct(down.now, down.was))})`]
          .filter(Boolean).join('; ').replace(/^b/, 'B') + `, ${ctx.prevLabel.replace(/^vs /, 'compared with ')}.`
        : `Highest rate: ${rated[0].label} (${r1(rated[0].now)} per 1,000 residents a year).`,
      note: `Complaints per 1,000 residents a year, highest first, ${prevL} → now. Rise and drop among neighborhoods with at least 100 complaints in both periods. Click a row to open it.${unratedNote}`,
      draw: withMore(12, (host, list) => dumbbells(host, {
        color: ctx.color, beforeLabel: prevL, nowLabel: ctx.periodLabel,
        rows: list.map((a) => ({ label: a.label, before: Math.round(a.was), now: Math.round(a.now), ...nav(a),
          tip: `<strong>${a.label}</strong><br>${prevL}: ${r1(a.was)} → ${ctx.periodLabel}: ${r1(a.now)} per 1,000 a year<br><span class="tip-muted">${fmt(a.before)} → ${fmt(a.n)} complaints</span>` })),
      })),
    };
  })());

  for (const s of await Promise.all(tasks)) if (s) sections.push(s);
  const order = ['each', 'years', 'months', 'season', 'time', 'premise', 'days', 'mix', 'areas', 'where'];
  sections.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  return { sections, hidden };
}
