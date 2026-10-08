"""Test SQL server: answers the app's queries with DuckDB (Python) on the real Parquet files.

The browser app sends SQL to POST /sql when opened with ?db=http://localhost:8765, so headless
tests run the exact production queries without needing DuckDB-WASM or its extensions.

Usage:  python tests/sql_server.py [data_dir] [port]
"""
import json
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import duckdb

DATA = Path(sys.argv[1] if len(sys.argv) > 1 else Path(__file__).resolve().parents[2] / "data" / "web")
PORT = int(sys.argv[2]) if len(sys.argv) > 2 else 8765

base = duckdb.connect()
for name in ("hex", "agg_precinct", "agg_nta"):
    base.execute(f"CREATE TABLE {name} AS SELECT * FROM read_parquet('{(DATA / f'{name}.parquet').as_posix()}')")
for name in ("incidents", "points", "street_segments", "street_corners", "street_blocks"):
    path = DATA / f"{name}.parquet"
    if path.exists():
        base.execute(f"CREATE VIEW {name} AS SELECT * FROM read_parquet('{path.as_posix()}')")


class Handler(BaseHTTPRequestHandler):
    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "*")

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_POST(self):
        sql = self.rfile.read(int(self.headers.get("Content-Length", 0))).decode()
        try:
            cur = base.cursor()          # one cursor per request: a shared one mixes results
            res = cur.execute(sql)
            cols = [d[0] for d in res.description]
            rows = [dict(zip(cols, r)) for r in res.fetchall()]
            body, code = json.dumps(rows, default=str).encode(), 200
        except Exception as e:  # noqa: BLE001 - report any SQL error to the test
            body, code = str(e).encode(), 400
        self.send_response(code)
        self._cors()
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    print(f"SQL test server on :{PORT} using {DATA}")
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
