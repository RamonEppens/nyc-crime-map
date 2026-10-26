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
// Data version (version.json, written by `npm run upload:data`, never cached): added to every data
// URL, so after an update the browser can't mix cached pieces of the old files with the new ones
// (decision #88). Missing locally: plain URLs.
const dataVersion = fetch(`${DATA_URL}version.json`, { cache: 'no-store' })
  .then((r) => (r.ok ? r.json() : {})).then((v) => (v.data ? `?v=${v.data}` : '')).catch(() => '');
const dataUrl = async (name) => `${DATA_URL}${name}${await dataVersion}`;

// How each table is read (decision #89). Every HTTP request from the engine costs a round trip to
// the data host (150–300 ms from far away), and the engine makes them one at a time, so reading a
// file in many small pieces is what made panels slow. Instead:
//  - IN_MEMORY: downloaded whole at startup and copied into tables (the map needs them at once);
//  - BUFFERED: downloaded whole in the background after the first map, then queried in memory
//    (one request each, ~30 MB together);
//  - RANGED: incidents (60 MB) stays remote, read in pieces; its queries touch a few row groups.
const IN_MEMORY = ['hex', 'agg_precinct', 'agg_nta'];
const BUFFERED = ['loc_street', 'street_corners', 'street_segments', 'street_blocks', 'points', 'agg_time'];
const RANGED = ['incidents'];
const REMOTE = [...BUFFERED, ...RANGED];

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
    const c = await (await fetch(await dataUrl('start.json'))).json();
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
// Remote tables are opened only once something needs them, and not before the first map is drawn:
// startup only needs the three in-memory tables. Each table has its own promise, so a query waits
// only for the tables it uses.
let openRemote = () => Promise.resolve();
let remoteOpened = null;
export const warmRemote = () => (remoteOpened ??= openRemote());
const tableReady = {};
const REMOTE_RE = new RegExp(`\\b(${REMOTE.join('|')})\\b`, 'g');

/** Test mode (`?db=http://localhost:8765`): queries go to a local SQL server instead of the
 *  in-browser engine. Only a server on this computer is accepted, so a crafted link can never send
 *  someone's searches to another site. */
export const testEngine = (() => {
  try {
    const u = new URL(params.get('db') ?? '');
    return ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname) ? u.origin : null;
  } catch { return null; }
})();

export async function initDb() {
  const httpEngine = testEngine;
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
  // Keep each Parquet file's footer after the first read, instead of fetching it again per query.
  // Only after LOAD: setting a Parquet option earlier makes DuckDB autoload the extension from
  // extensions.duckdb.org instead of our copy, and that build broke reading on the live site (#89).
  for (const setting of ['parquet_metadata_cache', 'enable_http_metadata_cache']) {
    await conn.query(`SET ${setting} = true`).catch(() => null);
  }

  // A whole file in one request (the browser caches it under its versioned URL).
  const download = async (name) => {
    const res = await fetch(await dataUrl(`${name}.parquet`));
    if (!res.ok) throw new Error(`${res.status} loading ${name}.parquet`);
    await db.registerFileBuffer(`${name}.parquet`, new Uint8Array(await res.arrayBuffer()));
  };
  await Promise.all(IN_MEMORY.map(download));
  for (const name of IN_MEMORY) await conn.query(`CREATE TABLE ${name} AS SELECT * FROM read_parquet('${name}.parquet')`);
  for (const name of RANGED) {
    await db.registerFileURL(`${name}.parquet`, await dataUrl(`${name}.parquet`), duckdb.DuckDBDataProtocol.HTTP, false);
  }
  openRemote = async () => {
    for (const name of RANGED) {
      tableReady[name] = conn.query(`CREATE VIEW ${name} AS SELECT * FROM read_parquet('${name}.parquet')`);
    }
    // Smallest first, two downloads at a time: the street search and single places are ready soonest.
    const settle = {};
    for (const name of BUFFERED) {
      tableReady[name] = new Promise((resolve, reject) => { settle[name] = { resolve, reject }; });
      tableReady[name].catch(() => {});            // a failure surfaces in the query that needs it
    }
    const queue = [...BUFFERED];
    const lane = async () => {
      while (queue.length) {
        const name = queue.shift();
        try {
          await download(name);
          await conn.query(`CREATE VIEW ${name} AS SELECT * FROM read_parquet('${name}.parquet')`);
          settle[name].resolve();
        } catch (e) { settle[name].reject(e); }
      }
    };
    await Promise.all([lane(), lane()]);
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

/** Waits until a remote table can be queried (openRemote creates its promise synchronously at
 *  first, except in test mode, where every table is ready at once). */
async function waitFor(table) {
  while (!tableReady[table]) {
    if (testEngine) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  await tableReady[table];
}

/** Run SQL and get an array of plain objects. */
export async function query(sql) {
  if (!engineReady && startCache?.has(sql)) { usedStartCache = true; return startCache.get(sql).map((r) => ({ ...r })); }
  await ready;
  const tables = [...new Set([...sql.matchAll(REMOTE_RE)].map((m) => m[1]))];
  if (tables.length) {
    warmRemote();
    await Promise.all(tables.map((t) => waitFor(t)));
  }
  return run(sql);
}

export async function loadJson(name) {
  const res = await fetch(await dataUrl(name));
  if (!res.ok) throw new Error(`${res.status} loading ${name}`);
  return res.json();
}
export async function loadText(name) {
  const res = await fetch(await dataUrl(name));
  if (!res.ok) throw new Error(`${res.status} loading ${name}`);
  return res.text();
}
export const whenEngineReady = () => ready;
export const engineIsReady = () => engineReady;
