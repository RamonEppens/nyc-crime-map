"""Rewrite the map's Parquet files so the browser engine can read them (decision #87).

DuckDB 1.5 writes Parquet that DuckDB-WASM 1.4 (the engine inside the map) partly fails to read:
some columns raise "TProtocolException: Invalid data" (agg_precinct, agg_nta). The native engine
reads them fine, so the pipeline and tests never noticed. Rewriting with Arrow's Parquet writer
gives standard files every engine reads. Same rows, same order, same row-group sizes, ZSTD.

Run last, after 07_web_data, 08_streets and 09_charts:  uv run scripts/10_web_compat.py
"""
from __future__ import annotations

import argparse
from pathlib import Path

import duckdb
import pyarrow.parquet as pq

ROOT = Path(__file__).resolve().parents[2]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", type=Path, default=ROOT)
    web = ap.parse_args().root / "data" / "web"
    for stale in web.glob("*.parquet.tmp"):         # left over from an interrupted run
        stale.unlink()
    for path in sorted(web.glob("*.parquet")):
        # Windows can't replace a file that is still open: every reader below is closed first.
        with pq.ParquetFile(path) as pf:
            created_by, num_rows = pf.metadata.created_by, pf.metadata.num_rows
            rg_rows = pf.metadata.row_group(0).num_rows
            table = None if not created_by.startswith("DuckDB") else pf.read()
        if table is None:
            print(f"  {path.name}: already written by Arrow")
            continue
        tmp = path.with_suffix(".parquet.tmp")
        pq.write_table(table, tmp, row_group_size=rg_rows, compression="zstd", compression_level=3,
                       use_dictionary=True, write_statistics=True)
        del table
        # Same content, row for row, before replacing.
        a, b = tmp.as_posix(), path.as_posix()
        con = duckdb.connect()
        diff = con.execute(f"SELECT count(*) FROM ((SELECT * FROM read_parquet('{a}') EXCEPT ALL SELECT * FROM read_parquet('{b}')) "
                           f"UNION ALL (SELECT * FROM read_parquet('{b}') EXCEPT ALL SELECT * FROM read_parquet('{a}')))").fetchone()[0]
        con.close()
        with pq.ParquetFile(tmp) as check:
            same_rows = check.metadata.num_rows == num_rows
        if diff or not same_rows:
            tmp.unlink()
            raise SystemExit(f"{path.name}: rewritten file differs ({diff} rows), left unchanged")
        try:
            tmp.replace(path)
        except PermissionError:
            tmp.unlink()
            raise SystemExit(f"{path.name} is open in another program (stop `npm run dev` or the preview, then run again)")
        print(f"  {path.name}: {num_rows:,} rows, row groups of {rg_rows:,}")


if __name__ == "__main__":
    main()
