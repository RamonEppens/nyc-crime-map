// Builds data/web/start.json: the answers to the queries the page asks on first load (default
// dates, all offenses; 3D and 2D views), so the first map appears before DuckDB-WASM has finished
// downloading (~35 MB the first time). The page ignores the file if meta.json has changed, so a
// stale cache is never shown; rebuild it after re-running the pipeline.
// Needs the same two servers as the smoke test:
//   npm run dev            (http://localhost:5173)
//   python tests/sql_server.py ../data/web 8765
// Usage: node scripts/build-start-cache.mjs [baseUrl] [sqlUrl]
import { chromium } from 'playwright';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const base = process.argv[2] ?? 'http://localhost:5173/';
const sql = process.argv[3] ?? 'http://localhost:8765';
const dataDir = fileURLToPath(new URL('../../data/web/', import.meta.url));
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const answers = {};
for (const view of ['hex', 'precincts']) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(`${base}?db=${encodeURIComponent(sql)}&record=1&basemap=none&view=${view}`);
  await page.waitForSelector('body[data-ready="true"]', { timeout: 120000 });
  await page.waitForTimeout(4000);                 // the borough shapes arrive a moment later
  Object.assign(answers, await page.evaluate(() => globalThis.__startAnswers));
  await page.close();
}
await browser.close();
const metaText = readFileSync(`${dataDir}meta.json`, 'utf8');
const hash = (t) => { let h = 2166136261; for (let i = 0; i < t.length; i++) h = Math.imul(h ^ t.charCodeAt(i), 16777619); return (h >>> 0).toString(16); };
const compact = Object.fromEntries(Object.entries(answers).map(([q, rows]) => {
  const cols = rows.length ? Object.keys(rows[0]) : [];
  return [q, { cols, rows: rows.map((r) => cols.map((c) => r[c])) }];
}));
const out = JSON.stringify({ meta: hash(metaText), built: new Date().toISOString(), answers: compact });
writeFileSync(`${dataDir}start.json`, out);
console.log(`start.json: ${Object.keys(compact).length} answers, ${(out.length / 1024).toFixed(0)} KB`);
