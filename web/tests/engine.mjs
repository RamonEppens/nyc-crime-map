// The real in-browser engine (DuckDB-WASM), end to end: engine start, every kind of panel and the
// "Over time" charts, with timings and console errors. The other tests use a native DuckDB server
// (tests/sql_server.py), which reads files the browser engine can't; this one doesn't (decision #90).
//
//   npm run test:engine                        local: `npm run dev` must be running (data/web)
//   npm run test:engine -- <url>               any deployment, e.g. the live site:
//   npm run test:engine -- https://ramoneppens.github.io/nyc-crime-map/
//
// Exits with 1 if the engine doesn't start, a panel stays empty or the page logs an error.
import { chromium } from 'playwright';

const url = process.argv[2] ?? 'http://localhost:5173/';
const page0 = `${url}${url.includes('?') ? '&' : '?'}hooks&basemap=none&theme=light&nocache=${Date.now()}`;
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });   // fresh cache
const page = await context.newPage();
page.setDefaultTimeout(180000);
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => {
  const t = m.text();
  if ((m.type() === 'error' || /TProtocolException|Decompression|magic bytes|could not start/i.test(t)) && !/favicon|sourcemap/i.test(t)) errors.push(t.slice(0, 200));
});

const failures = [];
const t0 = Date.now();
await page.goto(page0);
await page.waitForFunction(() => window.__engineReadyAt || /Filters can't/.test(document.querySelector('#summary-sub')?.textContent ?? ''));
const ready = await page.evaluate(() => window.__engineReadyAt);
console.log(ready ? `engine ready      ${ready} ms after navigation` : 'engine FAILED to start');
if (!ready) failures.push('engine did not start');

const settle = () => page.waitForFunction(() => window.__refreshed === window.__pending(), null, { polling: 100 });
async function panel(label, call, expect = /\d/) {
  const s = Date.now();
  try {
    await page.evaluate(call);
    await settle();
    const { title, lead } = await page.evaluate(() => ({
      title: document.querySelector('.detail .place')?.textContent ?? '', lead: document.querySelector('.detail .lead')?.textContent ?? '' }));
    const ok = !!title && expect.test(lead);
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${label.padEnd(14)} ${String(Date.now() - s).padStart(6)} ms  ${title}: ${lead.slice(0, 70)}`);
    if (!ok) failures.push(`${label}: "${lead.slice(0, 80)}"`);
  } catch (e) { console.log(`FAIL ${label}: ${e.message.split('\n')[0]}`); failures.push(label); }
}
async function charts(label) {
  const s = Date.now();
  try {
    await page.evaluate(() => document.querySelector('.charts-open').click());
    await page.waitForFunction(() => document.querySelectorAll('.charts-list h3').length >= 2 && !document.querySelector('.charts-loading'), null, { polling: 100 });
    const titles = await page.evaluate(() => [...document.querySelectorAll('.charts-list h3')].map((h) => h.textContent));
    console.log(`ok   ${label.padEnd(14)} ${String(Date.now() - s).padStart(6)} ms  ${titles.join(', ')}`);
    await page.evaluate(() => document.querySelector('.charts-back').click());
  } catch (e) { console.log(`FAIL ${label}: ${e.message.split('\n')[0]}`); failures.push(label); }
}

if (ready) {
  await panel('city', () => window.__select.city());
  await panel('borough', () => window.__select.borough(2));
  await panel('neighborhood', () => window.__select.nta(10));
  await charts('  over time');
  await panel('precinct', () => window.__select.precinct(75));
  await panel('hexagon', () => window.__select.hex(-15, 8));
  await panel('location', () => window.__select.spot([-73.97329711914062, 40.75812911987305]));
  await charts('  over time');
  await panel('location 2', () => window.__select.spot([-73.99877166748047, 40.57625198364258]));
  await panel('address', () => window.__select.point([-73.98565, 40.74844], '350 5th Avenue'));
  await panel('street', () => window.__select.street(23));
  await charts('  over time');
  await panel('2019 dates', () => window.__setSpan(36, 47));
}
console.log(`total             ${Date.now() - t0} ms`);
if (errors.length) { console.log(`console errors:\n  ${[...new Set(errors)].join('\n  ')}`); failures.push('console errors'); }
console.log(failures.length ? `FAILED: ${failures.join('; ')}` : 'ALL OK');
await browser.close();
process.exit(failures.length ? 1 : 0);
