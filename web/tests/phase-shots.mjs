// Review screenshots for the redesign phases: 3 sizes x 2 map themes x (nothing selected, a place
// selected). Needs the dev server and the test SQL server (same as tests/smoke.mjs).
// Usage: node tests/phase-shots.mjs <outDir> [baseUrl] [sqlUrl]
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const out = process.argv[2] ?? 'tests/screens/phase';
const base = process.argv[3] ?? 'http://localhost:5173/';
const sql = process.argv[4] ?? 'http://localhost:8765';
mkdirSync(out, { recursive: true });
const sizes = [[1440, 900], [1280, 800], [390, 844]];
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const errors = [];
for (const theme of ['light', 'dark']) {
  for (const [w, h] of sizes) {
    const page = await browser.newPage({ viewport: { width: w, height: h }, isMobile: w < 768, hasTouch: w < 768 });
    page.on('pageerror', (e) => errors.push(`${theme} ${w}: ${e.message}`));
    await page.goto(`${base}?db=${encodeURIComponent(sql)}&basemap=none&theme=${theme}`);
    await page.waitForSelector('body[data-ready="true"]', { timeout: 90000 });
    await page.waitForTimeout(2500);
    await page.screenshot({ path: `${out}/${theme}-${w}-none.png`, timeout: 90000 });
    await page.evaluate(() => window.__select.nta(10));
    await page.waitForTimeout(3500);
    await page.screenshot({ path: `${out}/${theme}-${w}-place.png`, timeout: 90000 });
    await page.close();
  }
}
await browser.close();
console.log(errors.length ? errors.join('\n') : 'OK');
