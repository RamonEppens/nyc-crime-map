"""Data for the charts that need the time of day: complaints per place x report year x offense type
x day of week x hour of occurrence.

Places (kind, id): 0 city (0), 1 borough (1-5), 2 precinct (NYPD precinct field), 3 neighborhood
(2020 NTA code), 4 street (from loc_street.parquet; at an intersection a complaint counts for every
street there, as everywhere else). City, boroughs and precincts count every complaint (like their
panels); neighborhoods and streets only complaints with a map location. Exact locations and
hexagons are small enough for the browser to read incidents.parquet directly.

Hour and weekday are those of the occurrence (NYPD's start time); the year is the report year, like
every other count. Unknown times are often recorded as midnight or noon: those two hours run
slightly high (4.6% vs 3.1% at 1 am; 5.7% vs 4.3% at 11 am, all years).

Inputs:  data/web/incidents.parquet, loc_street.parquet (07_web_data.py, 08_streets.py)
Output:  data/web/agg_time.parquet, sorted by kind, id (row groups of 8,192: a place reads few)
Usage (from pipeline/):  uv run scripts/09_charts.py
"""
from __future__ import annotations

import argparse
from pathlib import Path

import duckdb

ROOT = Path(__file__).resolve().parents[2]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", type=Path, default=ROOT)
    web = ap.parse_args().root / "data" / "web"
    P = lambda name: f"'{(web / name).as_posix()}'"
    con = duckdb.connect()
    con.execute(f"CREATE VIEW i AS SELECT m // 12 + 2016 AS year, cat, dow, hour, lt, lat, lon, nta, pct, boro "
                f"FROM read_parquet({P('incidents.parquet')}) WHERE dow >= 0 AND hour >= 0")
    con.execute(f"""COPY (
        SELECT kind::TINYINT AS kind, id::INTEGER AS id, year::SMALLINT AS year, cat, dow, hour, count(*)::INTEGER AS n FROM (
            SELECT 0 AS kind, 0 AS id, year, cat, dow, hour FROM i
            UNION ALL SELECT 1, boro, year, cat, dow, hour FROM i WHERE boro BETWEEN 1 AND 5
            UNION ALL SELECT 2, pct, year, cat, dow, hour FROM i WHERE pct > 0
            UNION ALL SELECT 3, nta, year, cat, dow, hour FROM i WHERE lt = 0 AND nta >= 0
            UNION ALL SELECT 4, ls.street, year, cat, dow, hour FROM i JOIN read_parquet({P('loc_street.parquet')}) ls
                USING (lat, lon) WHERE i.lt = 0)
        GROUP BY ALL ORDER BY kind, id, year, cat, dow, hour)
        TO {P('agg_time.parquet')} (FORMAT parquet, COMPRESSION zstd, ROW_GROUP_SIZE 8192)""")
    n, rows = con.execute(f"SELECT sum(n), count(*) FROM read_parquet({P('agg_time.parquet')}) WHERE kind = 0").fetchone()
    total = con.execute(f"SELECT count(*) FROM read_parquet({P('agg_time.parquet')})").fetchone()[0]
    print(f"agg_time.parquet: {total:,} rows; city check {n:,} complaints")


if __name__ == "__main__":
    main()
