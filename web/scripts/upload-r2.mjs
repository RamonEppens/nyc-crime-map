// Uploads data/web/* to the Cloudflare R2 bucket the live map reads (decision #86).
//   npm run upload:data            upload new and changed files
//   npm run upload:data -- --dry   only list what would change
// Keys come from pipeline/.env (git-ignored): R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_ENDPOINT.
// Unchanged files are skipped (their MD5 equals the bucket's ETag). After uploading, the script
// checks the public URL the way a browser will use it: a Range request from the site's origin.
import { S3Client, HeadObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const BUCKET = 'nyc-crime-map';
const PUBLIC_URL = 'https://pub-ac437e8cf4604031a0cba49bc0966606.r2.dev';
const SITE = 'https://ramoneppens.github.io';
const root = fileURLToPath(new URL('../../', import.meta.url));
const dataDir = path.join(root, 'data', 'web');
const dry = process.argv.includes('--dry');

const env = Object.fromEntries(readFileSync(path.join(root, 'pipeline', '.env'), 'utf8')
  .split(/\r?\n/).map((l) => l.trim()).filter((l) => /^R2_\w+=/.test(l))
  .map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).trim().replace(/^"|"$/g, '')]; }));
for (const k of ['R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_ENDPOINT']) {
  if (!env[k]) { console.error(`Missing ${k} in pipeline/.env`); process.exit(1); }
}
const s3 = new S3Client({
  region: 'auto', endpoint: env.R2_ENDPOINT,
  credentials: { accessKeyId: env.R2_ACCESS_KEY_ID, secretAccessKey: env.R2_SECRET_ACCESS_KEY },
});

const TYPES = { '.parquet': 'application/vnd.apache.parquet', '.json': 'application/json', '.geojson': 'application/geo+json' };
// meta.json and start.json say which data version the map uses: always revalidate them.
const cacheOf = (name) => (/^(meta|start)\.json$/.test(name) ? 'public, max-age=0, must-revalidate' : 'public, max-age=3600');

const files = readdirSync(dataDir).filter((f) => TYPES[path.extname(f)] && statSync(path.join(dataDir, f)).isFile()).sort();
let sent = 0, same = 0, bytes = 0;
const sums = [];
for (const name of files) {
  const body = readFileSync(path.join(dataDir, name));
  const md5 = createHash('md5').update(body).digest('hex');
  sums.push(`${name}:${md5}`);
  const remote = await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: name })).catch(() => null);
  if (remote?.ETag?.replace(/"/g, '') === md5) { same++; continue; }
  console.log(`${dry ? 'would upload' : 'uploading'} ${name} (${(body.length / 1e6).toFixed(1)} MB)`);
  if (!dry) {
    await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: name, Body: body, ContentType: TYPES[path.extname(name)], CacheControl: cacheOf(name) }));
  }
  sent++; bytes += body.length;
}
console.log(`${sent} ${dry ? 'to upload' : 'uploaded'} (${(bytes / 1e6).toFixed(1)} MB), ${same} unchanged`);

// version.json: one hash of every file's content. The map adds it to each data URL (?v=…), so a
// browser never mixes cached pieces of an old file with a new one (decision #88). Never cached.
const version = createHash('sha256').update(sums.join('\n')).digest('hex').slice(0, 12);
const current = await fetch(`${PUBLIC_URL}/version.json`, { cache: 'no-store' }).then((r) => (r.ok ? r.json() : {})).catch(() => ({}));
if (current.data !== version) {
  console.log(`${dry ? 'would set' : 'setting'} data version ${version} (was ${current.data ?? 'none'})`);
  if (!dry) await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: 'version.json', Body: JSON.stringify({ data: version }),
    ContentType: 'application/json', CacheControl: 'no-store' }));
} else console.log(`data version ${version} unchanged`);

if (!dry) {
  // The browser's view: a Range read of a Parquet file, sent from the live site's origin.
  const res = await fetch(`${PUBLIC_URL}/hex.parquet`, { headers: { Range: 'bytes=0-3', Origin: SITE } });
  const magic = Buffer.from(await res.arrayBuffer()).toString();
  const cors = res.headers.get('access-control-allow-origin');
  const ok = res.status === 206 && magic === 'PAR1' && cors === SITE;
  console.log(`Public check: HTTP ${res.status}, first bytes "${magic}", CORS ${cors ?? 'missing'} → ${ok ? 'OK' : 'PROBLEM'}`);
  if (!ok) process.exit(1);
}
