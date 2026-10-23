// Pre-submission sweep: steps through selections × dates × offenses and checks every panel.
// node tests/sweep.mjs <plan> <worker> <workers> <out.json> [width] [theme]
//   plan: depth (18 selections × 7 periods × 6 offense sets, with charts)
//         breadth (every borough, precinct and neighborhood, 2025, all offenses, with charts)
// Needs `npm run dev` and `python tests/sql_server.py ../data/web 8765`.
import { chromium } from 'playwright';
import { writeFileSync, readFileSync } from 'node:fs';

const [plan = 'depth', worker = '0', workers = '1', out = 'sweep.json', width = '1440', theme = 'light'] = process.argv.slice(2);
const W = +width;
const phone = W < 768;
const base = `http://localhost:${process.env.PORT ?? 5173}/?db=${encodeURIComponent('http://localhost:8765')}&basemap=none&theme=${theme}`;

const PERIODS = {
  'Dec 2025': [119, 119], 'Jan 2016': [0, 0], '2025': [108, 119], '2019': [36, 47],
  'Jul 2019–Jun 2020': [42, 53], '2016–2025': [0, 119], 'Apr 2020': [51, 51],
};
const ALL = [...Array(18).keys()];
const CATS = {
  all: ALL, robbery: [2], persons: [0, 1, 2, 3, 4, 5, 6], 'sex only': [1], none: [], enforcement: [13, 14, 15, 16],
};
const DEPTH = [
  ['city', 'city()'], ['Manhattan', 'borough(1)'], ['Staten Island', 'borough(5)'],
  ['14th Precinct', 'precinct(14)'], ['105th Precinct', 'precinct(105)'], ['22nd Precinct (Central Park)', 'precinct(22)'],
  ['Greenpoint', 'nta(0)'], ['Lincoln Terrace Park', 'nta(28)'], ['Calvert Vaux Park (0 residents)', 'nta(45)'],
  ['busiest hexagon', 'hex(-15, 8)'],
  ['busiest point', 'spot([-73.9892807006836, 40.750423431396484])'],
  ['1-complaint point', 'spot([-74.25162506103516, 40.50253677368164])'],
  ['new point (2025)', 'spot([-73.99877166748047, 40.57625198364258])'],
  ['4 homicides point', 'spot([-73.97329711914062, 40.75812911987305])'],
  ['350 5th Avenue', "point([-73.98565, 40.74844], '350 5th Avenue')"],
  ['5th Ave & W 42nd St', "point([-73.98156, 40.75364], '5th Avenue & West 42nd Street', true)"],
  ['Broadway (Manhattan)', 'street(23)'], ['1st Place (89 m)', 'street(2)'],
];

async function breadthList() {
  const meta = await (await fetch('http://localhost:8765/meta.json').catch(() => null))?.json?.().catch(() => null);
  return meta;
}

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: W, height: phone ? 844 : 1000 }, isMobile: phone, hasTouch: phone, deviceScaleFactor: 1 });
page.setDefaultTimeout(90000);
let consoleErrors = [];
page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error' && !/favicon|sourcemap|net::ERR_ABORTED/i.test(m.text())) consoleErrors.push(m.text()); });
await page.goto(base);
await page.waitForSelector('body[data-ready="true"]', { timeout: 120000 });
await page.waitForFunction(() => window.__engineReadyAt, null, { timeout: 180000 });
await page.evaluate(() => document.fonts.ready);

let jobs = [];
if (plan === 'depth') {
  // Covering design: every period with all offenses, every offense set in 2025, plus four crossings.
  const combos = [...Object.keys(PERIODS).map((p) => [p, 'all']), ...Object.keys(CATS).filter((c) => c !== 'all').map((c) => ['2025', c]),
    ['Jan 2016', 'sex only'], ['2016–2025', 'none'], ['Apr 2020', 'robbery'], ['Dec 2025', 'enforcement']];
  for (const [name, call] of DEPTH) for (const [pl, cl] of combos) jobs.push({ name, call, pl, span: PERIODS[pl], cl, cats: CATS[cl], charts: true });
} else {
  const meta = JSON.parse(readFileSync(new URL('../../data/web/meta.json', import.meta.url)));
  const pcts = await page.evaluate(() => [...new Set([...document.querySelectorAll('*')].length && [])]);
  const list = [['city', 'city()']];
  for (const b of [1, 2, 3, 4, 5]) list.push([meta.boroughs[b], `borough(${b})`]);
  for (const p of [1, 5, 6, 7, 9, 10, 13, 14, 17, 18, 19, 20, 22, 23, 24, 25, 26, 28, 30, 32, 33, 34, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 52, 60, 61, 62, 63, 66, 67, 68, 69, 70, 71, 72, 73, 75, 76, 77, 78, 79, 81, 83, 84, 88, 90, 94, 100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111, 112, 113, 114, 115, 116, 120, 121, 122, 123]) list.push([`Precinct ${p}`, `precinct(${p})`]);
  for (const n of meta.ntas) list.push([n.name, `nta(${n.code})`]);
  for (const [name, call] of list) jobs.push({ name, call, pl: '2025', span: [108, 119], cl: 'all', cats: ALL, charts: true });
  void pcts;
}
if (process.env.ONLY) jobs = jobs.filter((j) => new RegExp(process.env.ONLY).test(j.name));
jobs = jobs.filter((_, i) => i % +workers === +worker);

// Waits until the panel (or charts) text stops changing.
async function settle(sel, quiet = 1200, max = 60000) {
  await page.evaluate(() => { window.__settle = {}; });
  await page.waitForTimeout(500);
  await page.waitForFunction(([s, q]) => {
    const el = document.querySelector(s);
    const t = el ? el.innerText : '';
    const now = performance.now();
    const w = (window.__settle ??= {});
    if (w[s]?.t !== t || /Loading/.test(t)) { w[s] = { t, at: now }; return false; }
    return now - w[s].at > q && document.body.dataset.loading !== 'true';
  }, [sel, quiet], { timeout: max, polling: 200 });
}

// All checks on what is on screen now.
const inspect = () => page.evaluate(() => {
  const issues = [];
  const vis = (el) => el && el.offsetParent !== null && getComputedStyle(el).visibility !== 'hidden';
  const box = (el) => el.getBoundingClientRect();
  const hit = (a, b, pad = 1) => a.width && b.width && a.left < b.right - pad && b.left < a.right - pad && a.top < b.bottom - pad && b.top < a.bottom - pad;
  const scope = ['.detail', '.legend', '#dek', '.sheet-body', '.bsheet'].map((s) => document.querySelector(s)).filter(vis);
  for (const el of scope) {
    const t = el.innerText;
    const m = t.match(/[^\n]{0,40}\b(NaN|undefined|Infinity|null|\[object \w+\])\b[^\n]{0,40}/);
    if (m) issues.push(`bad value: "${m[0].trim()}"`);
    const m2 = t.match(/[^\n]{0,30}(\(\s*\)|\s,\s|,,|\.\.(?!\.)|  )[^\n]{0,30}/);
    if (m2) issues.push(`odd punctuation/spacing: "${m2[0].trim()}"`);
    const m3 = t.match(/\b1 complaints\b|\b(a) ([aeiou]\w+)/i);
    if (m3 && !/a (one|unique|user|usual|uni)/i.test(m3[0])) issues.push(`grammar: "${m3[0]}"`);
  }
  const detail = document.querySelector('.detail');
  if (vis(detail)) {
    const body = detail.querySelector('.detail-body');
    const right = box(body).left + body.clientWidth;
    for (const el of detail.querySelectorAll('h2, h3, p, span, button, div.value, div.label, div.fnote, li, text')) {
      if (!vis(el) || el.closest('.tip, [role=tooltip], .charts-view[hidden]')) continue;
      const r = box(el);
      if (r.width && r.right > right + 1.5) { issues.push(`overflows panel by ${Math.round(r.right - right)} px: "${(el.textContent || '').trim().slice(0, 50)}"`); break; }
    }
    for (const v of detail.querySelectorAll('.figure .value, .figure .label')) {
      if (document.fonts.status === 'loaded' && v.scrollWidth > v.clientWidth + 2) issues.push(`tile text cut (${v.scrollWidth} > ${v.clientWidth} px): "${v.textContent.trim()}"`);
    }
    const parts = [...detail.querySelectorAll('.figure > *')].filter(vis);
    for (let i = 0; i < parts.length; i++) for (let j = i + 1; j < parts.length; j++) {
      if (parts[i].matches('.label') && parts[j].matches('.q')) continue;   // the label's right padding is the room for the "?"
      if (hit(box(parts[i]), box(parts[j]))) issues.push(`tile overlap: "${parts[i].textContent.trim().slice(0, 25)}" / "${parts[j].textContent.trim().slice(0, 25)}"`);
    }
    for (const svg of detail.querySelectorAll('svg')) {
      if (!vis(svg)) continue;
      const texts = [...svg.querySelectorAll('text')].filter((t) => t.textContent.trim()).map((t) => ({ t: t.textContent.trim(), r: box(t) }));
      const sr = box(svg);
      for (let i = 0; i < texts.length; i++) {
        if (texts[i].r.left < sr.left - 2 || texts[i].r.right > sr.right + 2) issues.push(`chart label clipped: "${texts[i].t}" in ${svg.closest('section,.chart,div')?.querySelector('h3')?.textContent ?? 'chart'}`);
        for (let j = i + 1; j < texts.length; j++) if (hit(texts[i].r, texts[j].r, 0.5)) {
          issues.push(`chart labels overlap: "${texts[i].t}" / "${texts[j].t}" in ${svg.parentElement?.closest('[data-module], section, div')?.querySelector('h3')?.textContent ?? 'chart'}`);
        }
      }
    }
    for (const a of detail.querySelectorAll('.charts-list .answer')) if (vis(a) && !a.textContent.trim()) issues.push(`empty chart answer under "${a.previousElementSibling?.textContent}"`);
  }
  const num = (s) => +String(s ?? '').replace(/[^\d]/g, '');
  const tile = document.querySelector('.figures .figure .value');
  return { issues: [...new Set(issues)], total: tile ? num(tile.textContent) : null, lead: document.querySelector('.detail .lead')?.textContent ?? '',
    title: document.querySelector('.detail .place')?.textContent ?? '', dek: document.querySelector('#dek')?.innerText ?? '' };
});

// Sum of the "By offense" bars (all of them) to compare with the Total tile.
const barsSum = () => page.evaluate(async () => {
  const more = document.querySelector('.detail .more');
  if (more && !more.hidden && /more|all/i.test(more.textContent)) { more.click(); await new Promise((r) => setTimeout(r, 300)); }
  const vals = [...document.querySelectorAll('.detail .bars .num')].map((e) => +e.textContent.replace(/[^\d]/g, ''));
  return vals.length ? vals.reduce((a, b) => a + b, 0) : null;
});

const results = [];
let lastCall = null;
for (const job of jobs) {
  consoleErrors = [];
  const t0 = Date.now();
  const rec = { sel: job.name, period: job.pl, offenses: job.cl, issues: [] };
  try {
    await page.evaluate(([span, cats]) => { window.__setSpan(span[0], span[1]); window.__setCats(cats); }, [job.span, job.cats]);
    if (lastCall !== job.call) {
      await page.evaluate((c) => {
        const back = document.querySelector('.charts-back'); if (back && back.offsetParent) back.click();
        return eval(`window.__select.${c}`);
      }, job.call);
      lastCall = job.call;
    } else {
      await page.evaluate(() => { const back = document.querySelector('.charts-back'); if (back && back.offsetParent) back.click(); });
    }
    await page.waitForFunction(() => window.__refreshed === window.__pending(), null, { timeout: 90000, polling: 200 });
    await settle('#dek');
    await settle('.detail');
    const d = await inspect();
    Object.assign(rec, { title: d.title, lead: d.lead, total: d.total, dek: d.dek });
    rec.issues.push(...d.issues);
    if (!d.title) rec.issues.push('panel did not open');
    const bs = await barsSum();
    rec.bars = bs;
    if (bs != null && d.total != null && bs !== d.total && /^\d/.test(d.lead) === false) {} // lead may be a sentence; compare numbers below
    if (bs != null && d.total != null && bs !== d.total) rec.issues.push(`By offense bars add up to ${bs}, Total says ${d.total}`);
    if (job.charts) {
      await page.evaluate(() => document.querySelector('.charts-open')?.click());
      await settle('.charts-list', 1500, 90000);
      const c = await inspect();
      rec.issues.push(...c.issues.map((x) => `[Over time] ${x}`));
      rec.charts = await page.evaluate(() => [...document.querySelectorAll('.charts-list h3')].map((h) => h.textContent));
      rec.hidden = await page.evaluate(() => document.querySelector('.charts-hidden')?.innerText ?? '');
    }
  } catch (e) {
    rec.issues.push(`timeout/error: ${e.message.split('\n')[0]}`);
    lastCall = null;
  }
  rec.issues.push(...consoleErrors.map((e) => `console: ${e.slice(0, 160)}`));
  rec.issues = [...new Set(rec.issues)];
  rec.ms = Date.now() - t0;
  results.push(rec);
  if (results.length % 10 === 0) writeFileSync(out, JSON.stringify(results, null, 1));
  process.stdout.write(`${results.length}/${jobs.length} ${rec.issues.length ? '✗' : '✓'} ${job.name} | ${job.pl} | ${job.cl}${rec.issues.length ? ` — ${rec.issues[0]}` : ''}\n`);
}
writeFileSync(out, JSON.stringify(results, null, 1));
await browser.close();
