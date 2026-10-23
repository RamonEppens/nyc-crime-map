import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

// Local data: the pipeline writes to ../data/web. In development (and `vite preview`) we serve it at
// /data/ with HTTP Range support, because DuckDB-WASM reads Parquet files in pieces. In production
// the data lives on GitHub Pages / Cloudflare R2 (VITE_DATA_URL).
//
// Our own handler, not sirv: sirv answers a range that ends at byte 0 ("bytes=0-0") with the whole
// file, and DuckDB-WASM then fails with "TProtocolException: Invalid data" (decision #75).
const dataDir = fileURLToPath(new URL('../data/web', import.meta.url));
const TYPES = { '.json': 'application/json', '.geojson': 'application/geo+json', '.parquet': 'application/octet-stream' };

function serveData(req, res, next) {
  const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '');
  const file = path.resolve(dataDir, rel);
  if (!file.startsWith(dataDir + path.sep)) { res.statusCode = 403; return res.end(); }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return next();
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Type', TYPES[path.extname(file)] ?? 'application/octet-stream');
    res.setHeader('Cache-Control', 'no-cache');
    const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
    let start = 0, end = st.size - 1;
    if (m) {
      if (m[1] === '' && m[2] === '') { res.statusCode = 416; return res.end(); }
      if (m[1] === '') { start = Math.max(0, st.size - Number(m[2])); }       // suffix: last N bytes
      else { start = Number(m[1]); if (m[2] !== '') end = Math.min(Number(m[2]), st.size - 1); }
      if (start > end || start >= st.size) {
        res.statusCode = 416; res.setHeader('Content-Range', `bytes */${st.size}`); return res.end();
      }
      res.statusCode = 206;
      res.setHeader('Content-Range', `bytes ${start}-${end}/${st.size}`);
    }
    res.setHeader('Content-Length', end - start + 1);
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file, { start, end }).pipe(res);
  });
}

export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    rollupOptions: { input: { main: fileURLToPath(new URL('index.html', import.meta.url)), about: fileURLToPath(new URL('about.html', import.meta.url)), privacy: fileURLToPath(new URL('privacy.html', import.meta.url)) } },
  },
  worker: { format: 'es' },
  optimizeDeps: { exclude: ['@duckdb/duckdb-wasm'] },
  plugins: [{
    name: 'serve-local-data',
    configureServer(server) { server.middlewares.use('/data', serveData); },
    configurePreviewServer(server) { server.middlewares.use('/data', serveData); },
  }],
});
