"""End-to-end smoke test: raw -> 03_clean -> 05_geography -> 07_web_data on synthetic data."""
import csv
import json
import subprocess
import sys
from pathlib import Path

import duckdb

from test_clean_smoke import make_raw
from test_geography_smoke import square

SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"


def run(script, *args):
    res = subprocess.run([sys.executable, str(SCRIPTS / script), *map(str, args)], capture_output=True, text=True)
    assert res.returncode == 0, res.stderr


def test_pipeline_to_web(tmp_path: Path):
    raw = tmp_path / "data" / "raw" / "qgea-i56i"
    raw.parent.mkdir(parents=True)
    make_raw(raw)
    run("03_clean.py", "--raw", raw, "--out", tmp_path / "data" / "clean")

    ref = tmp_path / "data" / "reference"
    ref.mkdir()
    ntas = [("MN0101", -74.30, -73.98, "1"), ("BK0101", -73.98, -73.60, "3")]
    (ref / "nta2020.geojson").write_text(json.dumps({"type": "FeatureCollection", "features": [
        {"type": "Feature", "geometry": square(x0, 40.40, x1, 41.0),
         "properties": {"nta2020": c, "ntaname": c, "borocode": b, "boroname": "x", "ntatype": "0",
                        "shape_area": "1000000"}} for c, x0, x1, b in ntas]}))
    (ref / "precincts.geojson").write_text(json.dumps({"type": "FeatureCollection", "features": [
        {"type": "Feature", "geometry": square(-74.3, 40.4, -73.6, 41.0), "properties": {"precinct": "14"}}]}))
    with open(ref / "tracts2020.csv", "w", newline="") as f:
        csv.writer(f).writerows([["geoid", "boroct2020", "nta2020", "ntaname", "cdta2020"], ["1", "1", "MN0101", "x", "x"]])
    with open(ref / "tract_population.csv", "w", newline="") as f:
        csv.writer(f).writerows([["geoid", "population"], ["1", "500"]])
    run("05_geography.py", "--root", tmp_path)
    run("07_web_data.py", "--root", tmp_path)

    web = tmp_path / "data" / "web"
    meta = json.loads((web / "meta.json").read_text())
    t = meta["totals"]
    assert t["complaints"] == 600 and t["precinct_only"] > 0
    assert t["drawable"] + t["precinct_only"] + t["no_location"] == 600
    q = lambda s: duckdb.sql(s.replace("W/", (web.as_posix() + "/"))).fetchone()
    assert q("SELECT count(*) FROM 'W/incidents.parquet'")[0] == 600
    assert q("SELECT count(*) FROM 'W/incidents.parquet' WHERE lt = 1 AND lat IS NOT NULL")[0] == 0
    assert q("SELECT min(m), max(m) FROM 'W/incidents.parquet'") == (9, 21)       # fake reports: Oct 2016 and Oct 2017
    assert q("SELECT sum(n) FROM 'W/hex.parquet'")[0] == t["drawable"]
    assert q("SELECT count(DISTINCT length(h9)) FROM 'W/hex.parquet'")[0] == 1
    assert {f["properties"]["id"] for f in json.loads((web / "nta.geojson").read_text())["features"]} == {"MN0101", "BK0101"}
    assert len(json.loads((web / "boroughs.geojson").read_text())["features"]) == 2
    assert [c["id"] for c in meta["categories"]][:2] == ["homicide", "sex_crimes"]
