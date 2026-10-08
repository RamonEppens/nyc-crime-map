import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import sirv from 'sirv';

// Local data: the pipeline writes to ../data/web. In development we serve it at /data/
// with HTTP Range support (DuckDB-WASM reads Parquet files in pieces). In production the
// data lives on Cloudflare R2 and VITE_DATA_URL points there.
const dataDir = fileURLToPath(new URL('../data/web', import.meta.url));

export default defineConfig({
  base: './',
  build: { target: 'es2022' },
  worker: { format: 'es' },
  optimizeDeps: { exclude: ['@duckdb/duckdb-wasm'] },
  plugins: [{
    name: 'serve-local-data',
    configureServer(server) {
      server.middlewares.use('/data', sirv(dataDir, { dev: true, etag: true }));
    },
    configurePreviewServer(server) {
      server.middlewares.use('/data', sirv(dataDir, { dev: true, etag: true }));
    },
  }],
});
