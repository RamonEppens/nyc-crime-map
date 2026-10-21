// Accessibility checks (decision #74): axe-core (WCAG 2.0/2.1 A and AA, 2.2 AA target size), our own
// target-size audit (24 px with a pointer, 44 px on touch), focus rings, and the keyboard path
// "/" -> address -> Enter -> panel -> Esc. Desktop (1440 × 900) in both themes, phone (390 × 844) light.
// Needs the dev server and the test SQL server (same as tests/smoke.mjs).
// Usage: node tests/a11y.mjs [baseUrl] [sqlUrl]
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const base = process.argv[2] ?? 'http://localhost:5173/';
const sql = process.argv[3] ?? 'http://localhost:8765';
const axeSource = readFileSync(fileURLToPath(new URL('../node_modules/axe-core/axe.min.js', import.meta.url)), 'utf8');
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const errors = [];

/** Visible interactive elements smaller than min × min (CSS px), with what they are. */
const smallTargets = (page, min) => page.evaluate((min) => {
  const sel = 'button, a[href], input, select, [role="slider"], [role="tab"], [role="radio"], [role="checkbox"], [tabindex="0"]';
  const out = [];
  for (const el of document.querySelectorAll(sel)) {
    const r = el.getBoundingClientRect();
    const st = getComputedStyle(el);
    if (!r.width || !r.height || st.visibility === 'hidden' || st.opacity === '0' || el.closest('[hidden], .maplibregl-ctrl-attrib-inner')) continue;
    if (el.closest('#search-results') || el.matches('.maplibregl-ctrl-attrib-button')) continue;   // list rows and the credits toggle are checked separately
    // Links inside a sentence are exempt in WCAG 2.5.8 (the "inline" exception).
    const para = el.parentElement.closest('p');
    if (para && para.textContent.trim().length > el.textContent.trim().length + 10) continue;   // a link inside a sentence
    if (r.width < min - 0.5 || r.height < min - 0.5) {
      out.push(`${el.tagName.toLowerCase()}${el.className && typeof el.className === 'string' ? '.' + el.className.split(' ').join('.') : ''} "${(el.getAttribute('aria-label') ?? el.textContent).trim().slice(0, 30)}" ${Math.round(r.width)}×${Math.round(r.height)}`);
    }
  }
  return out;
}, min);

const runAxe = async (page, label) => {
  await page.addScriptTag({ content: axeSource });
  const res = await page.evaluate(async () => {
    const r = await window.axe.run(document, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] },
      exclude: [['#map canvas']],
    });
    return r.violations.map((v) => `${v.id} (${v.impact}): ${v.nodes.length} × ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`);
  });
  console.log(label, 'axe:', res.length ? res.join('\n   ') : 'no violations');
  for (const v of res) errors.push(`${label}: axe ${v}`);
};

for (const [w, h, theme] of [[1440, 900, 'light'], [1440, 900, 'dark'], [390, 844, 'light']]) {
  const phone = w < 768;
  const label = `${theme} ${w}`;
  const page = await browser.newPage({ viewport: { width: w, height: h }, isMobile: phone, hasTouch: phone });
  page.on('pageerror', (e) => errors.push(`${label}: ${e.message}`));
  await page.goto(`${base}?db=${encodeURIComponent(sql)}&basemap=none&theme=${theme}`);
  await page.waitForSelector('body[data-ready="true"]', { timeout: 90000 });
  await page.waitForTimeout(1500);

  // 1. axe, nothing selected, then with a place open and the offense groups unfolded
  await runAxe(page, `${label} start`);
  const small = await smallTargets(page, phone ? 44 : 24);
  console.log(label, 'small targets:', small.length ? small.join('; ') : 'none');
  for (const s of small) errors.push(`${label}: target under ${phone ? 44 : 24} px: ${s}`);

  // 2. Keyboard path: "/" -> address -> Enter -> the panel has focus -> Esc -> back in the search box
  if (!phone) {
    await page.keyboard.press('/');
    if (await page.evaluate(() => document.activeElement.id) !== 'search') errors.push(`${label}: "/" did not focus the search box`);
    await page.keyboard.type('350 5th ave');
    await page.waitForFunction(() => document.querySelector('#search-results').dataset.query === '350 5th ave', null, { timeout: 15000 });
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => !document.querySelector('.detail').hidden && /350 5th/.test(document.querySelector('.place').textContent), null, { timeout: 20000 })
      .catch(() => errors.push(`${label}: Enter did not open the address`));
    await page.waitForTimeout(800);
    const focused = await page.evaluate(() => document.activeElement.className);
    console.log(label, 'focus after Enter:', focused);
    if (!/place/.test(focused)) errors.push(`${label}: the panel heading should have focus after Enter (${focused})`);
    // Tab moves into the panel's controls (first: expand)
    await page.keyboard.press('Tab');
    const next = await page.evaluate(() => document.activeElement.getAttribute('aria-label') ?? document.activeElement.textContent);
    console.log(label, 'next Tab:', next);
    const ring = await page.evaluate(() => { const s = getComputedStyle(document.activeElement); return `${s.outlineStyle} ${s.outlineWidth} ${s.outlineOffset}`; });
    if (ring !== 'solid 2px 2px') errors.push(`${label}: focus ring is "${ring}", should be solid 2px with 2px offset`);
    await runAxe(page, `${label} address`);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(600);
    const back = await page.evaluate(() => [document.querySelector('.detail').hidden, document.activeElement.id]);
    console.log(label, 'after Esc: panel hidden', back[0], '| focus', back[1]);
    if (!back[0] || back[1] !== 'search') errors.push(`${label}: Esc should close the panel and return focus to search (${back})`);
    // The key's "?" opens its explanation; Esc closes it and focus returns to "?"
    await page.focus('#legend-q');
    await page.keyboard.press('Enter');
    if (await page.isHidden('#legend-explain')) errors.push(`${label}: the key's "?" should open the explanation`);
    await page.keyboard.press('Escape');
    if (!(await page.isHidden('#legend-explain')) || await page.evaluate(() => document.activeElement.id) !== 'legend-q') errors.push(`${label}: Esc should close the key help and focus "?"`);
    // The month strip and the chips work from the keyboard
    await page.focus('#period-presets [aria-checked="true"]');
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(900);
    if (!/2023/.test(await page.textContent('#period-label'))) errors.push(`${label}: arrow keys should move through the date chips`);
    await page.keyboard.press('ArrowLeft');
    await page.waitForTimeout(900);
    // Offense groups unfold from the keyboard
    await page.focus('button.cat-fold[data-fold="person"]');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(300);
    if (await page.isHidden('#types-person')) errors.push(`${label}: Enter on the chevron should unfold the group`);
    await runAxe(page, `${label} unfolded`);
    const small2 = await smallTargets(page, 24);
    for (const s of small2) errors.push(`${label} unfolded: target under 24 px: ${s}`);
  } else {
    // Phone: filters full screen, Show results returns focus; a search opens the details at half height
    await page.click('.filters-open');
    await page.waitForTimeout(300);
    if (await page.evaluate(() => document.body.dataset.filters) !== 'open') errors.push(`${label}: the filter button should open the filters`);
    await page.click('button.cat-fold[data-fold="person"]');
    await runAxe(page, `${label} filters`);
    const small3 = await smallTargets(page, 44);
    console.log(label, 'filters small targets:', small3.length ? small3.join('; ') : 'none');
    for (const s of small3) errors.push(`${label} filters: target under 44 px: ${s}`);
    await page.click('.show-results');
    await page.waitForTimeout(300);
    if (await page.evaluate(() => document.activeElement.className) !== 'filters-open') errors.push(`${label}: Show results should return focus to the filter button`);
    await page.fill('#search', '350 5th ave');
    await page.waitForFunction(() => document.querySelector('#search-results').dataset.query === '350 5th ave', null, { timeout: 15000 });
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelector('.bsheet').dataset.snap === 'half', null, { timeout: 20000 })
      .catch(() => errors.push(`${label}: details should open at half height`));
    await page.waitForTimeout(1500);
    await runAxe(page, `${label} address`);
    const small4 = await smallTargets(page, 44);
    console.log(label, 'details small targets:', small4.length ? small4.join('; ') : 'none');
    for (const s of small4) errors.push(`${label} details: target under 44 px: ${s}`);
    await page.screenshot({ path: '../design/a11y-phone-address.png' });
  }
  await page.close();
}
await browser.close();
if (errors.length) { console.error(errors.join('\n')); process.exit(1); }
console.log('OK');
