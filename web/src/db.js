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
const REMOTE = ['incidents', 'points', 'street_segments', 'street_corners', 'street_blocks'];

let run;

export async function initDb() {
  const httpEngine = params.get('db');
  if (httpEngine) {
    run = async (sql) => {
      const res = await fetch(`${httpEngine}/sql`, { method: 'POST', body: sql });
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    };
    return;
  }

  const bundle = await duckdb.selectBundle({
    mvp: { mainModule: mvpWasm, mainWorker: mvpWorker },
    eh: { mainModule: ehWasm, mainWorker: ehWorker },
  });
  const worker = new Worker(bundle.mainWorker);
  const db = new duckdb.AsyncDuckDB(new duckdb.ConsoleLogger(duckdb.LogLevel.WARNING), worker);
  await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
  const conn = await db.connect();

  // Parquet support is an extension; it is self-hosted (see scripts/fetch-duckdb-ext.mjs).
  const extRepo = new URL('duckdb-ext', document.baseURI).href;
  await conn.query(`SET custom_extension_repository = '${extRepo}'`);
  await conn.query('INSTALL parquet; LOAD parquet;');

  for (const name of [...IN_MEMORY, ...REMOTE]) {
    await db.registerFileURL(`${name}.parquet`, `${DATA_URL}${name}.parquet`,
      duckdb.DuckDBDataProtocol.HTTP, false);
  }
  for (const name of IN_MEMORY) {
    await conn.query(`CREATE TABLE ${name} AS SELECT * FROM read_parquet('${name}.parquet')`);
  }
  for (const name of REMOTE) {
    await conn.query(`CREATE VIEW ${name} AS SELECT * FROM read_parquet('${name}.parquet')`);
  }

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
}

/** Run SQL and get an array of plain objects. */
export function query(sql) {
  return run(sql);
}

export async function loadJson(name) {
  const res = await fetch(`${DATA_URL}${name}`);
  if (!res.ok) throw new Error(`${res.status} loading ${name}`);
  return res.json();
}
