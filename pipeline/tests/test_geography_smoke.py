"""Smoke test: point -> NTA/precinct assignment, boundary and nearest rules, population join.

Run from pipeline/:  uv run pytest
"""
import csv
import json
import subprocess
import sys
from pathlib import Path

import duckdb
import pyarrow as pa
import pyarrow.parquet as pq

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "05_geography.py"


def square(x0, y0, x1, y1):
    return {"type": "MultiPolygon", "coordinates": [[[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]]]}


def test_geography(tmp_path: Path):
    ref, clean = tmp_path / "data" / "reference", tmp_path / "data" / "clean"
    ref.mkdir(parents=True), clean.mkdir(parents=True)
    # Two NTAs side by side, sharing the line lon = -73.95; one precinct covering both.
    ntas = [("BK0101", -74.00, -73.95, "0"), ("BK0102", -73.95, -73.90, "9")]
    (ref / "nta2020.geojson").write_text(json.dumps({"type": "FeatureCollection", "features": [
        {"type": "Feature", "geometry": square(x0, 40.70, x1, 40.75),
         "properties": {"nta2020": c, "ntaname": c, "borocode": "3", "boroname": "Brooklyn",
                        "ntatype": t, "shape_area": "10763910.4"}} for c, x0, x1, t in ntas]}))
    (ref / "precincts.geojson").write_text(json.dumps({"type": "FeatureCollection", "features": [
        {"type": "Feature", "geometry": square(-74.00, 40.70, -73.90, 40.75), "properties": {"precinct": "84"}}]}))
    with open(ref / "tracts2020.csv", "w", newline="") as f:
        csv.writer(f).writerows([["geoid", "boroct2020", "nta2020", "ntaname", "cdta2020"],
                                 ["36047000100", "3000100", "BK0101", "x", "BK01"],
                                 ["36047000200", "3000200", "BK0102", "x", "BK01"]])
    with open(ref / "tract_population.csv", "w", newline="") as f:
        csv.writer(f).writerows([["geoid", "population"], ["36047000100", "1000"], ["36047000200", "0"]])

    pts = [(40.72, -73.98, 84),    # inside BK0101
           (40.72, -73.95, 84),    # on the shared boundary -> lowest code BK0101
           (40.7503, -73.97, 84),  # ~33 m north of the edge -> nearest
           (40.80, -73.97, 84)]    # far away -> none
    rows = [{"lat": la, "lon": lo, "precinct": p, "location_type": "point"} for la, lo, p in pts]
    pq.write_table(pa.Table.from_pylist(rows), clean / "complaints.parquet")

    res = subprocess.run([sys.executable, str(SCRIPT), "--root", str(tmp_path)], capture_output=True, text=True)
    assert res.returncode == 0, res.stderr

    got = {(r[0], r[1]): r[2:] for r in duckdb.sql(
        f"SELECT lat, lon, nta2020, nta_match, precinct_geo FROM '{(clean / 'point_geo.parquet').as_posix()}'").fetchall()}
    assert got[(40.72, -73.98)] == ("BK0101", "inside", 84)
    assert got[(40.72, -73.95)] == ("BK0101", "boundary", 84)
    assert got[(40.7503, -73.97)][:2] == ("BK0102", "nearest") or got[(40.7503, -73.97)][:2] == ("BK0101", "nearest")
    assert got[(40.80, -73.97)] == (None, "none", None)

    nta = list(csv.DictReader(open(ref / "nta.csv")))
    assert {r["nta2020"]: r["population_2020"] for r in nta} == {"BK0101": "1000", "BK0102": "0"}
    assert nta[1]["ntatype"] == "park" and nta[0]["land_km2"] == "1.0"
    meta = json.loads((clean / "geo_meta.json").read_text())
    assert meta["precinct_field_vs_polygon_rows"]["same"] == 3
