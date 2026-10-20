// Data access. Every query in the app is plain DuckDB SQL against a few named views
// (hex, agg_precinct, agg_nta, incidents, points, street_*). Two engines can answer it:
//   - DuckDB-WASM in the browser (normal use), reading Parquet over HTTP Range requests;
//   - a small Python DuckDB server (automated tests): add ?db=http://localhost:8765 to the URL.
// Both run the same SQL on the same files, so tests exercise the real queries.
import * as duckdb from '@duckdb/duckdb-wasm';
import mvpWasm from '@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url';
import mvpWorker from '@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?url';
import ehWasm from '@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url';
import ehWorker from '@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url';

const params = new URLSearchParams(location.search);
export const DATA_URL = new URL(import.meta.env.VITE_DATA_URL || 'data/', document.baseURI).href;

// Small tables are copied into memory once; large ones stay remote and are read in pieces.
const IN_MEMORY = ['hex', 'agg_precinct', 'agg_nta'];
const REMOTE = ['incidents', 'points', 'street_segments', 'street_corners', 'street_blocks', 'agg_time', 'loc_street'];

let run;
let engineReady = false;
// Start cache (data/web/start.json, written by scripts/build-start-cache.mjs): the answers to the
// queries the page asks on first load, so the first map is drawn before the engine has finished
// downloading. Only used until the engine is ready; then the page asks again for real.
let startCache = null;
export let usedStartCache = false;
/** Load start.json if it matches this data (same meta.json); otherwise ignore it. */
export async function loadStartCache(metaText) {
  try {
    const c = await (await fetch(`${DATA_URL}start.json`)).json();
    if (c.meta !== hashText(metaText)) return;
    startCache = new Map(Object.entries(c.answers).map(([sql, { cols, rows }]) =>
      [sql, rows.map((r) => Object.fromEntries(cols.map((k, i) => [k, r[i]])))]));
  } catch { /* no cache: the engine answers everything */ }
}
export function hashText(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return (h >>> 0).toString(16);
}
// Recording mode for the cache builder (test mode only): every answer, by SQL.
const record = params.has('record') ? (globalThis.__startAnswers = {}) : null;
// Queries wait for the engine, so the page can draw the map while DuckDB is still loading.
let resolveReady;
const ready = new Promise((r) => { resolveReady = r; });
// Remote tables are opened (their Parquet footers read) only once something needs them, and not
// before the first map is drawn: startup only needs the three in-memory tables.
let openRemote = () => Promise.resolve();
let remoteOpened = null;
export const warmRemote = () => (remoteOpened ??= openRemote());
const REMOTE_RE = new RegExp(`\\b(${['incidents', 'points', 'street_segments', 'street_corners', 'street_blocks', 'agg_time', 'loc_street'].join('|')})\\b`);

export async function initDb() {
  const httpEngine = params.get('db');
  if (httpEngine) {
    run = async (sql) => {
      const res = await fetch(`${httpEngine}/sql`, { method: 'POST', body: sql });
      if (!res.ok) throw new Error(await res.text());
      const rows = await res.json();
      if (record) record[sql] = rows;
      return rows;
    };
    engineReady = true;
    resolveReady();
    return;
  }

  const bundle = await duckdb.selectBundle({
    mvp: { mainModule: mvpWasm, mainWorker: mvpWorker },
    eh: { mainModule: ehWasm, mainWorker: ehWorker },
  });
  // Start downloading the Parquet extension now, in parallel with the engine (the browser cache
  // then serves DuckDB's own request for it).
  const extRepo = new URL('duckdb-ext', document.baseURI).href;
  fetch(`${extRepo}/version.json`).then((r) => r.json()).then(({ version }) =>
    fetch(`${extRepo}/${version}/${bundle.mainModule.includes('-eh') ? 'wasm_eh' : 'wasm_mvp'}/parquet.duckdb_extension.wasm`)).catch(() => null);
  const worker = new Worker(bundle.mainWorker);
  const db = new duckdb.AsyncDuckDB(new duckdb.ConsoleLogger(duckdb.LogLevel.WARNING), worker);
  await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
  // Read remote Parquet in pieces (HTTP Range), never as whole files. This DuckDB-WASM version
  // defaults to full HTTP reads, so without these settings every file was downloaded whole at
  // startup (~90 MB of data before the map appeared). A HEAD with a Range header tells DuckDB the
  // server supports ranges (GitHub Pages, R2 and the dev server all do).
  await db.open({ filesystem: { reliableHeadRequests: true, allowFullHTTPReads: false, forceFullHTTPReads: false } });
  const conn = await db.connect();

  // Parquet support is an extension; it is self-hosted (see scripts/fetch-duckdb-ext.mjs).
  await conn.query(`SET custom_extension_repository = '${extRepo}'`);
  await conn.query('INSTALL parquet; LOAD parquet;');

  for (const name of [...IN_MEMORY, ...REMOTE]) {
    await db.registerFileURL(`${name}.parquet`, `${DATA_URL}${name}.parquet`,
      duckdb.DuckDBDataProtocol.HTTP, false);
  }
  await Promise.all(IN_MEMORY.map((name) => conn.query(`CREATE TABLE ${name} AS SELECT * FROM read_parquet('${name}.parquet')`)));
  openRemote = async () => {
    for (const name of REMOTE) await conn.query(`CREATE VIEW ${name} AS SELECT * FROM read_parquet('${name}.parquet')`);
  };

  run = async (sql) => {
    const table = await conn.query(sql);
    return table.toArray().map((row) => {
      const obj = row.toJSON();
      for (const k in obj) {
        if (typeof obj[k] === 'bigint') obj[k] = Number(obj[k]);
        else if (obj[k]?.toArray) obj[k] = Array.from(obj[k].toArray(), Number);   // LIST columns (street geometry)
      }
      return obj;
    });
  };
  engineReady = true;
  resolveReady();
}

/** Run SQL and get an array of plain objects. */
export async function query(sql) {
  if (!engineReady && startCache?.has(sql)) { usedStartCache = true; return startCache.get(sql).map((r) => ({ ...r })); }
  await ready;
  if (REMOTE_RE.test(sql)) await warmRemote();
  return run(sql);
}

export async function loadJson(name) {
  const res = await fetch(`${DATA_URL}${name}`);
  if (!res.ok) throw new Error(`${res.status} loading ${name}`);
  return res.json();
}
export async function loadText(name) {
  const res = await fetch(`${DATA_URL}${name}`);
  if (!res.ok) throw new Error(`${res.status} loading ${name}`);
  return res.text();
}
export const whenEngineReady = () => ready;
export const engineIsReady = () => engineReady;
