// Downloads the DuckDB Parquet extension for the browser build and stores it in
// public/duckdb-ext/, so the site never depends on extensions.duckdb.org at runtime.
// Run once after `npm install` (and again if @duckdb/duckdb-wasm is upgraded):
//   npm run fetch:duckdb-ext
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const wasm = await readFile(`${root}node_modules/@duckdb/duckdb-wasm/dist/duckdb-eh.wasm`);
// The DuckDB core version is embedded in the WASM binary (e.g. "v1.4.3").
const versions = [...wasm.toString('latin1').matchAll(/v1\.\d+\.\d+/g)].map((m) => m[0]);
const counts = versions.reduce((acc, v) => ((acc[v] = (acc[v] || 0) + 1), acc), {});
const version = process.env.DUCKDB_VERSION
  ?? Object.keys(counts).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))[0];

for (const platform of ['wasm_eh', 'wasm_mvp']) {
  const url = `https://extensions.duckdb.org/${version}/${platform}/parquet.duckdb_extension.wasm`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} for ${url} (set DUCKDB_VERSION to override)`);
  const dir = `${root}public/duckdb-ext/${version}/${platform}`;
  await mkdir(dir, { recursive: true });
  const bytes = Buffer.from(await res.arrayBuffer());
  await writeFile(`${dir}/parquet.duckdb_extension.wasm`, bytes);
  console.log(`saved ${platform} parquet extension for ${version} (${(bytes.length / 1e6).toFixed(1)} MB)`);
}
await writeFile(`${root}public/duckdb-ext/version.json`, JSON.stringify({ version }));
