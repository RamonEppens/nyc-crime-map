// Headless checks against the Python SQL server, with a plain basemap (no network needed):
//   - the app loads and the totals render, in both themes;
//   - the legend shows exactly the ramp the map uses, with breaks for the hexagons in view;
//   - screenshots at zoom 11, 12, 13 (columns) and 14 (points), top-down and tilted, for the
//     gap check (neighboring hexagons must share edges, no hairlines).
// Usage: node tests/smoke.mjs [baseUrl] [sqlUrl] [outDir]
import { chromium } from 'playwright';

const base = process.argv[2] ?? 'http://localhost:5173/';
const sql = process.argv[3] ?? 'http://localhost:8765';
const out = process.argv[4] ?? 'tests/screens';
const RAMPS = {
  dark: ['#10263d', '#163654', '#1c466c', '#215785', '#26679d', '#2f78b3'],
  light: ['#cfe0f0', '#a8c8e6', '#7aa9d6', '#4a88c2', '#2470ad', '#154f80'],
};
const hex = (rgbStr) => '#' + rgbStr.match(/\d+/g).slice(0, 3).map((v) => (+v).toString(16).padStart(2, '0')).join('');

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const errors = [];
const settle = (page) => page.evaluate(() => new Promise((res) => {
  const m = window.__nycmap;
  if (!m.isMoving()) setTimeout(res, 1500); else m.once('moveend', () => setTimeout(res, 1500));
}));

for (const theme of ['dark', 'light']) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', (e) => errors.push(`${theme}: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && errors.push(`${theme} console: ${m.text()}`));
  await page.goto(`${base}?db=${encodeURIComponent(sql)}&basemap=none&theme=${theme}`);
  await page.waitForSelector('body[data-ready="true"]', { timeout: 60000 });
  await settle(page);
  console.log(theme, '|', (await page.textContent('.status')).trim());

  const legend = await page.$$eval('.legend-ramp span', (els) => els.map((e) => getComputedStyle(e).backgroundColor));
  const legendHex = legend.map(hex);
  const ok = JSON.stringify(legendHex) === JSON.stringify(RAMPS[theme]);
  console.log(theme, 'legend matches ramp:', ok, '| labels:', (await page.textContent('.legend-labels')).replace(/\s+/g, ' ').trim());
  if (!ok) errors.push(`${theme}: legend ${legendHex} != ramp`);
  await page.screenshot({ path: `${out}/${theme}-z11.png` });

  // Filters: date modes, stepper, "only", None, All, hiding a block.
  const first = async () => (await page.textContent('.figure .value')).trim();
  const total2025 = await first();
  await page.selectOption('#period-mode', 'month');
  await page.waitForTimeout(800);
  const dec2025 = await first();
  await page.click('.stepper button:first-child');
  await page.waitForTimeout(800);
  const nov2025 = await first();
  console.log(theme, 'year 2025:', total2025, '| Dec 2025:', dec2025, '| Nov 2025:', nov2025, '|', await page.textContent('.detail .sub'));
  if (dec2025 === total2025 || nov2025 === dec2025) errors.push(`${theme}: month filter did not change totals`);
  await page.selectOption('#period-mode', 'crossyear');
  await page.waitForTimeout(800);
  console.log(theme, 'every July:', await first(), '|', await page.textContent('.detail .sub'));
  await page.selectOption('#period-mode', 'year');
  await page.hover('.cat:has-text("Robbery")');
  await page.click('.cat:has-text("Robbery") .cat-only');
  await page.waitForTimeout(800);
  console.log(theme, 'only robbery 2025:', await first(), '|', await page.textContent('.detail .sub'));
  await page.screenshot({ path: `${out}/${theme}-only.png` });
  // Stable hexagon array: same length and order whatever the filter (needed for transitions).
  const before = await page.evaluate(() => window.__hexStats());
  await page.click('[data-select="all"]');
  await page.waitForTimeout(800);
  const after = await page.evaluate(() => window.__hexStats());
  console.log(theme, 'hex array: robbery', before.length, '/', before.withData, 'with data | all', after.length, '/', after.withData, '| breaks', after.breaks.join(','));
  if (before.length !== after.length || JSON.stringify(before.first) !== JSON.stringify(after.first)) errors.push(`${theme}: hexagon array changed length or order`);
  if (after.breaks.some((b, i) => i && b <= after.breaks[i - 1])) errors.push(`${theme}: breaks not strictly increasing`);

  // Rapid clicks: only the last selection may win.
  for (const name of ['Burglary', 'Drugs', 'Robbery', 'Weapons', 'Homicide']) {
    await page.hover(`.cat:has-text("${name}")`);
    await page.click(`.cat:has-text("${name}") .cat-only`);
  }
  await page.waitForTimeout(1200);
  const sub = await page.textContent('.detail .sub');
  const bars = await page.textContent('.bars');
  console.log(theme, 'after rapid clicks:', sub, '|', bars.replace(/\s+/g, ' ').trim());
  if (!bars.includes('Homicide')) errors.push(`${theme}: rapid clicks did not end on the last selection`);

  // Rape & sex crimes only: nothing to draw, the notice must explain why.
  await page.hover('.cat:has-text("Rape")');
  await page.click('.cat:has-text("Rape") .cat-only');
  await page.waitForTimeout(1000);
  const notice = await page.isVisible('.map-notice') ? (await page.textContent('.map-notice')).replace(/\s+/g, ' ').trim() : '';
  console.log(theme, 'rape only:', await first(), '| notice:', notice.slice(0, 90));
  if (!notice.includes('not shown on the map')) errors.push(`${theme}: no notice for rape & sex crimes`);
  await page.screenshot({ path: `${out}/${theme}-rape.png` });
  await page.click('[data-select="all"]');
  await page.waitForTimeout(800);
  if (await page.isVisible('.map-notice')) errors.push(`${theme}: notice should hide when there is data`);

  await page.click('[data-select="none"]');
  await page.waitForTimeout(800);
  if ((await first()) !== '0') errors.push(`${theme}: None should give 0`);
  await page.click('[data-select="all"]');
  await page.waitForTimeout(800);
  if ((await first()) !== total2025) errors.push(`${theme}: All should restore ${total2025}`);
  await page.click('[data-block="legend"] .block-toggle');
  if (await page.isVisible('#legend-body')) errors.push(`${theme}: Hide did not hide the legend`);
  await page.click('[data-block="legend"] .block-toggle');
  await page.selectOption('#period-mode', 'monthRange');
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${out}/${theme}-monthrange.png` });
  await page.selectOption('#period-mode', 'year');
  await page.waitForTimeout(800);

  for (const [zoom, pitch, name] of [[12, 0, 'z12-top'], [13, 0, 'z13-top'], [13, 45, 'z13-tilt'], [14.2, 45, 'z14-points']]) {
    await page.evaluate(([z, p]) => window.__nycmap.jumpTo({ center: [-73.99, 40.735], zoom: z, pitch: p, bearing: -12 }), [zoom, pitch]);
    await settle(page);
    await page.screenshot({ path: `${out}/${theme}-${name}.png`, clip: { x: 304, y: 0, width: 776, height: 900 } });
  }
  await page.close();
}
await browser.close();
if (errors.length) { console.error(errors.join('\n')); process.exit(1); }
console.log('OK');
