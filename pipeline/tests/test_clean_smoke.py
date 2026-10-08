"""Smoke test: cleaning rules on a tiny synthetic snapshot.

Run from pipeline/:  uv run pytest
"""
import json
import subprocess
import sys
from pathlib import Path

import duckdb
import pyarrow as pa
import pyarrow.parquet as pq

from test_audit_smoke import COLS, fake_rows

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "03_clean.py"
STATION = ("40.6713598203364", "-73.8818110231735")


def make_raw(raw: Path):
    raw.mkdir()
    for year in (2015, 2016, 2017):
        rows = list(fake_rows(300, year))
        for i, r in enumerate(rows):
            if r["ofns_desc"] == "RAPE":          # sex crimes sit on a station-house point
                r["latitude"], r["longitude"] = STATION
            elif i % 50 == 0:                      # some other offense on the same point
                r["latitude"], r["longitude"] = STATION
        rows.append(dict(rows[0]))                 # a duplicate id
        table = pa.Table.from_pylist(rows, schema=pa.schema([(c, pa.string()) for c in COLS]))
        pq.write_table(table, raw / f"rpt_year={year}.parquet")


def test_clean_rules(tmp_path: Path):
    raw, out = tmp_path / "raw", tmp_path / "clean"
    make_raw(raw)
    res = subprocess.run([sys.executable, str(SCRIPT), "--raw", str(raw), "--out", str(out)],
                         capture_output=True, text=True)
    assert res.returncode == 0, res.stderr

    meta = json.loads((out / "clean_meta.json").read_text())
    assert meta["window"] == [2016, 2025]
    assert set(meta["by_year"]) == {"2016", "2017"}          # 2015 excluded
    assert meta["duplicates_removed"] == 2
    assert meta["rows"] == 600

    con = duckdb.connect()
    t = f"read_parquet('{(out / 'complaints.parquet').as_posix()}')"
    one = lambda s: con.execute(s).fetchone()[0]
    assert one(f"SELECT count(*) FROM {t} WHERE category = 'sex_crimes' AND location_type <> 'precinct_only'") == 0
    # every complaint on the station point is withheld, and withheld rows carry no coordinates
    assert one(f"SELECT count(*) FROM {t} WHERE location_type = 'precinct_only' AND lat IS NOT NULL") == 0
    assert one(f"SELECT count(*) FROM {t} WHERE category <> 'sex_crimes' AND location_type = 'precinct_only'") > 0
    # "(null)" placeholders normalized
    assert one(f"SELECT count(*) FROM {t} WHERE borough = '(null)'") == 0
