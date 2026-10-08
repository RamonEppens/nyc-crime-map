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
  await page.goto(`${base}?db=${encodeURIComponent(sql)}&basemap=none&theme=${theme}&geosearch=${encodeURIComponent(sql)}`);
  await page.waitForSelector('body[data-ready="true"]', { timeout: 60000 });
  await settle(page);
  console.log(theme, '|', (await page.textContent('.brand .summary')).replace(/\s+/g, ' ').trim(), '|', await page.textContent('#summary-sub'));
  if (!(await page.isHidden('.detail'))) errors.push(`${theme}: the details panel should start closed`);
  await page.click('#city-total');                      // open the city panel (bars are checked below)
  await page.waitForTimeout(600);
  if ((await page.textContent('.detail h2')).trim() !== 'New York City') errors.push(`${theme}: total link should open the city panel`);

  const legend = await page.$$eval('.legend-ramp span', (els) => els.map((e) => getComputedStyle(e).backgroundColor));
  const legendHex = legend.map(hex);
  const ok = JSON.stringify(legendHex) === JSON.stringify(RAMPS[theme]);
  console.log(theme, 'legend matches ramp:', ok, '| labels:', (await page.textContent('.legend-labels')).replace(/\s+/g, ' ').trim());
  if (!ok) errors.push(`${theme}: legend ${legendHex} != ramp`);
  await page.screenshot({ path: `${out}/${theme}-z11.png` });

  // Filters: date modes, stepper, "only", None, All, hiding a block.
  const first = async () => (await page.textContent('#city-total')).replace(' complaints', '').trim();
  const total2025 = await first();
  await page.selectOption('#period-mode', 'month');
  await page.waitForTimeout(800);
  const dec2025 = await first();
  await page.click('.stepper button:first-child');
  await page.waitForTimeout(800);
  const nov2025 = await first();
  console.log(theme, 'year 2025:', total2025, '| Dec 2025:', dec2025, '| Nov 2025:', nov2025, '|', await page.textContent('#summary-filter'));
  if (dec2025 === total2025 || nov2025 === dec2025) errors.push(`${theme}: month filter did not change totals`);
  await page.selectOption('#period-mode', 'crossyear');
  await page.waitForTimeout(800);
  console.log(theme, 'every July:', await first(), '|', await page.textContent('#summary-filter'));
  await page.selectOption('#period-mode', 'year');
  await page.hover('.cat:has-text("Robbery")');
  await page.click('.cat:has-text("Robbery") .cat-only');
  await page.waitForTimeout(800);
  console.log(theme, 'only robbery 2025:', await first(), '|', await page.textContent('#summary-filter'));
  await page.screenshot({ path: `${out}/${theme}-only.png` });
  // One offense type (or one whole group) colors the map with its group's ramp; legend follows.
  const tinted = (await page.$$eval('.legend-ramp span', (els) => els.map((e) => getComputedStyle(e).backgroundColor))).map(hex);
  const wantRed = theme === 'dark' ? '#d46c66' : '#8a3330';
  console.log(theme, 'robbery only, legend top:', tinted.at(-1));
  if (tinted.at(-1) !== wantRed) errors.push(`${theme}: one person-crime type should tint the map red (${tinted.at(-1)})`);
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
  const sub = await page.textContent('#summary-filter');
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
  await page.waitForTimeout(500);
  const blue = (await page.$$eval('.legend-ramp span', (els) => els.map((e) => getComputedStyle(e).backgroundColor))).map(hex);
  if (JSON.stringify(blue) !== JSON.stringify(RAMPS[theme])) errors.push(`${theme}: All should bring back the blue ramp`);
  await page.click('[data-block="period"] .block-toggle');
  if (await page.isVisible('#period-body')) errors.push(`${theme}: Hide did not hide the date block`);
  await page.click('[data-block="period"] .block-toggle');
  // Selection: click a hexagon on the map, follow the link to its neighborhood, go back.
  await page.evaluate(() => window.__nycmap.jumpTo({ center: [-73.94, 40.80], zoom: 12, pitch: 0, bearing: 0 }));
  await settle(page);
  await page.mouse.click(720, 450);
  await page.waitForTimeout(1200);
  const hexTitle = (await page.textContent('.detail h2')).trim();
  const hexFigs = (await page.textContent('.figures')).replace(/\s+/g, ' ').trim();
  const ctx = (await page.textContent('.detail .context')).replace(/\s+/g, ' ').trim();
  console.log(theme, 'clicked:', hexTitle, '|', ctx, '|', hexFigs);
  if (hexTitle !== 'Hexagon') errors.push(`${theme}: map click did not select a hexagon (${hexTitle})`);
  await page.screenshot({ path: `${out}/${theme}-hex-selected.png` });
  await page.click('.detail .context [data-nta]');
  await page.waitForTimeout(1500);
  const ntaTitle = (await page.textContent('.detail h2')).trim();
  console.log(theme, 'neighborhood:', ntaTitle, '|', (await page.textContent('.detail .context')).trim(), '|',
    (await page.textContent('.figures')).replace(/\s+/g, ' ').trim(), '|', (await page.textContent('.figures-note')).trim());
  await page.screenshot({ path: `${out}/${theme}-nta-selected.png` });
  await page.click('.detail .close');
  await page.waitForTimeout(800);
  if (!(await page.isHidden('.detail'))) errors.push(`${theme}: close did not hide the panel`);
  // Search: an address (GeoSearch mock) opens the 200 m panel; a neighborhood name selects it.
  await page.fill('#search', '350 5th');
  await page.waitForSelector('#search-results li[data-i]', { timeout: 5000 });
  const opts = await page.$$eval('#search-results li[data-i]', (els) => els.map((e) => e.textContent.trim()));
  console.log(theme, 'search options:', opts.join(' / '));
  if (opts.length !== 1) errors.push(`${theme}: duplicate GeoSearch results were not merged (${opts.length})`);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(2500);
  await settle(page);
  const addrTitle = (await page.textContent('.detail h2')).trim();
  const addrFigs = (await page.textContent('.figures')).replace(/\s+/g, ' ').trim();
  console.log(theme, 'address:', addrTitle, '|', (await page.textContent('.detail .context')).replace(/\s+/g, ' ').trim(), '|', addrFigs,
    '|', (await page.textContent('.figures-note')).trim());
  if (addrTitle !== '350 5th Avenue') errors.push(`${theme}: address title ${addrTitle}`);
  if (!/within 200 m/i.test(addrFigs)) errors.push(`${theme}: address figures missing "within 200 m"`);
  await page.screenshot({ path: `${out}/${theme}-address.png` });
  await page.keyboard.press('Escape');
  await page.fill('#search', 'mott');
  await page.waitForSelector('#search-results li[data-i]', { timeout: 5000 });
  await page.click('#search-results li[data-i]:has-text("Mott")');
  await page.waitForTimeout(2000);
  const mott = (await page.textContent('.detail h2')).trim();
  console.log(theme, 'neighborhood search:', mott);
  if (!/Mott/.test(mott)) errors.push(`${theme}: neighborhood search selected ${mott}`);
  await page.click('.detail .close');
  await page.waitForTimeout(800);
  if (await page.inputValue('#search')) errors.push(`${theme}: back did not clear the search box`);
  // Suggestions: the empty box offers the five boroughs; one letter already suggests places.
  await page.click('#search');
  await page.waitForTimeout(200);
  const empty = await page.$$eval('#search-results .opt-label', (els) => els.map((e) => e.textContent));
  if (empty.join() !== 'Manhattan,Brooklyn,Queens,Bronx,Staten Island') errors.push(`${theme}: empty box suggestions ${empty}`);
  await page.fill('#search', 'b');
  await page.waitForTimeout(200);
  const oneLetter = await page.$$eval('#search-results li[data-i]', (els) => els.map((e) => e.innerText.replace(/\s+/g, ' ')));
  console.log(theme, '"b" suggests:', oneLetter.join(' / '));
  if (!oneLetter.length || !oneLetter[0].startsWith('Brooklyn')) errors.push(`${theme}: "b" should suggest Brooklyn first`);
  await page.fill('#search', 'brook');
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${out}/${theme}-suggestions.png` });
  await page.keyboard.press('Enter');
  await page.waitForTimeout(2500);
  await settle(page);
  const boro = (await page.textContent('.detail h2')).trim();
  console.log(theme, 'borough:', boro, '|', (await page.textContent('.detail .context')).trim(), '|',
    (await page.textContent('.figures')).replace(/\s+/g, ' ').trim(), '|', (await page.textContent('.figures-note')).trim());
  if (boro !== 'Brooklyn') errors.push(`${theme}: Enter did not pick Brooklyn (${boro})`);
  await page.screenshot({ path: `${out}/${theme}-borough.png` });
  await page.click('.detail .close');
  await page.waitForTimeout(800);
  await page.evaluate(() => window.__nycmap.jumpTo({ center: [-73.965, 40.715], zoom: 11, pitch: 45, bearing: -12 }));
  await settle(page);

  await page.selectOption('#period-mode', 'monthRange');
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${out}/${theme}-monthrange.png` });
  await page.selectOption('#period-mode', 'year');
  await page.waitForTimeout(800);

  // Precinct view: flat, legend per precinct, a click selects a precinct, 105/113/116 merged before 2025.
  await page.click('.view-switch [data-view="precincts"]');
  await page.waitForTimeout(2500);
  const flat = await page.evaluate(() => [window.__nycmap.getPitch(), window.__nycmap.getBearing()]);
  const pTitle = await page.textContent('#legend-title');
  console.log(theme, 'precinct view:', pTitle, '| pitch/bearing', flat.join('/'), '|', (await page.textContent('.legend-labels')).replace(/\s+/g, ' ').trim(),
    '|', (await page.textContent('#summary-sub')).trim());
  if (pTitle !== 'Complaints per precinct') errors.push(`${theme}: legend title ${pTitle}`);
  if (Math.abs(flat[0]) > 0.5 || Math.abs(flat[1]) > 0.5) errors.push(`${theme}: precinct view is not flat (${flat})`);
  await page.screenshot({ path: `${out}/${theme}-precincts.png` });
  await page.evaluate(() => window.__select.precinct(75));
  await page.waitForTimeout(1500);
  const p75 = (await page.textContent('.detail h2')).trim();
  console.log(theme, 'precinct:', p75, '|', (await page.textContent('.figures')).replace(/\s+/g, ' ').trim());
  if (p75 !== '75th Precinct') errors.push(`${theme}: precinct selection ${p75}`);
  await page.click('.detail .close');
  await page.waitForTimeout(500);
  await page.selectOption('#period-mode', 'month');
  await page.waitForTimeout(500);
  await page.click('.stepper button:last-child');           // stepping forward stays in the window
  await page.waitForTimeout(500);
  await page.selectOption('#period-mode', 'year');
  await page.click('.stepper button:first-child');           // 2024: before the 116th Precinct
  await page.waitForTimeout(1200);
  await page.evaluate(() => window.__select.precinct(116));
  await page.waitForTimeout(1500);
  const merged = (await page.textContent('.detail h2')).trim();
  console.log(theme, '2024, 116th ->', merged);
  if (merged !== '105th, 113th and 116th Precincts') errors.push(`${theme}: 2024 should merge 105/113/116 (${merged})`);
  await page.click('.detail .close');
  await page.click('.stepper button:last-child');
  await page.waitForTimeout(800);
  await page.click('.view-switch [data-view="hex"]');
  await page.waitForTimeout(2500);
  const tilt = await page.evaluate(() => window.__nycmap.getPitch());
  if (Math.abs(tilt - 45) > 0.5 || (await page.textContent('#legend-title')) !== 'Complaints per hexagon') errors.push(`${theme}: back to hexagons failed (pitch ${tilt})`);

  for (const [zoom, pitch, name] of [[12, 0, 'z12-top'], [13, 0, 'z13-top'], [13, 45, 'z13-tilt'], [14.2, 45, 'z14-points']]) {
    await page.evaluate(([z, p]) => window.__nycmap.jumpTo({ center: [-73.99, 40.735], zoom: z, pitch: p, bearing: -12 }), [zoom, pitch]);
    await settle(page);
    await page.screenshot({ path: `${out}/${theme}-${name}.png`, clip: { x: 360, y: 0, width: 720, height: 900 } });
  }
  await page.close();
}
await browser.close();
if (errors.length) { console.error(errors.join('\n')); process.exit(1); }
console.log('OK');
