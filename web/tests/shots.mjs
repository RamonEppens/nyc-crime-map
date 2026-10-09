// Design review screenshots: node tests/shots.mjs <outDir> [themes]
import { chromium } from 'playwright';
const out = process.argv[2] ?? '../design';
const themes = (process.argv[3] ?? 'dark,light').split(',');
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const errors = [];
for (const theme of themes) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`http://localhost:5173/?db=${encodeURIComponent('http://localhost:8765')}&basemap=none&theme=${theme}`);
  await page.waitForSelector('body[data-ready="true"]', { timeout: 60000 });
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${out}/${theme}-1-start.png` });
  await page.click('#search'); await page.keyboard.type('broad'); await page.waitForTimeout(2500);
  await page.screenshot({ path: `${out}/${theme}-2-search.png` });
  await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
  await page.evaluate(() => window.__select.nta(10));
  await page.waitForTimeout(3500);
  await page.screenshot({ path: `${out}/${theme}-3-nta.png` });
  await page.click('.charts-open');
  await page.waitForFunction(() => document.querySelectorAll('.chart-card .chart-svg').length >= 3, null, { timeout: 60000 });
  await page.waitForTimeout(1000);
  await page.screenshot({ path: `${out}/${theme}-4-charts.png` });
  await page.click('.detail .expand'); await page.waitForTimeout(1200);
  await page.screenshot({ path: `${out}/${theme}-5-wide.png` });
  await page.click('.detail .expand'); await page.click('.charts-back');
  await page.click('[data-view="precincts"]'); await page.waitForTimeout(3000);
  await page.screenshot({ path: `${out}/${theme}-6-precincts.png` });
  await page.close();
}
console.log(errors.length ? errors : 'OK');
await browser.close();
