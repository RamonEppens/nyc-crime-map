"""Attach geography to every drawable location, and build neighborhood reference tables.

Inputs:  data/clean/complaints.parquet, data/reference/* (from 04_reference.py)
Outputs:
  data/clean/point_geo.parquet   one row per distinct (lat, lon): nta2020, borocode, precinct_geo, match
  data/reference/nta.csv         NTA code, name, borough, type, 2020 population, land area
  data/clean/geo_meta.json       match statistics and consistency checks

Assignment rule: a point belongs to the NTA (and precinct polygon) that contains it. NYPD snaps
locations to mid-blocks and intersections, so many points sit exactly on a street that is also a
boundary: those take the polygon with the lowest code (deterministic) and are counted as
"boundary". Points within ~50 m outside every polygon (piers, shorelines) take the nearest one.

Usage (from pipeline/):  uv run scripts/05_geography.py
"""
from __future__ import annotations

import argparse
import csv
import json
from collections import defaultdict
from pathlib import Path

import duckdb
import numpy as np
import pyarrow as pa
import pyarrow.parquet as pq
import shapely
from shapely.geometry import shape

ROOT = Path(__file__).resolve().parents[2]
NEAREST_MAX_DEG = 0.0006   # ~50-65 m at NYC's latitude
SQFT_PER_KM2 = 10_763_910.4
NTA_TYPES = {"0": "residential", "5": "rikers_island", "6": "other_special", "7": "cemetery",
             "8": "airport", "9": "park"}


def load_polygons(path: Path, key: str):
    feats = json.loads(path.read_text(encoding="utf-8"))["features"]
    feats.sort(key=lambda f: str(f["properties"][key]).zfill(8))   # lowest code first
    return [f["properties"] for f in feats], [shape(f["geometry"]) for f in feats]


def assign(points: np.ndarray, polys: list) -> tuple[np.ndarray, np.ndarray]:
    """Index of the containing polygon per point (-1 if none) and a match label."""
    tree = shapely.STRtree(polys)
    idx = np.full(len(points), -1, dtype=np.int64)
    hits = np.zeros(len(points), dtype=np.int64)
    pi, ti = tree.query(points, predicate="intersects")
    order = np.lexsort((ti, pi))                       # per point, lowest polygon index first
    pi, ti = pi[order], ti[order]
    first = np.unique(pi, return_index=True)[1]
    idx[pi[first]] = ti[first]
    np.add.at(hits, pi, 1)
    match = np.where(hits == 1, "inside", np.where(hits > 1, "boundary", "none")).astype(object)

    missing = np.flatnonzero(idx == -1)
    if len(missing):
        mi, mt = tree.query_nearest(points[missing], max_distance=NEAREST_MAX_DEG, all_matches=False)
        idx[missing[mi]] = mt
        match[missing[mi]] = "nearest"
    return idx, match


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", type=Path, default=ROOT, help="project root (for tests)")
    args = ap.parse_args()
    ref, clean = args.root / "data" / "reference", args.root / "data" / "clean"

    # 1. NTA table with population ---------------------------------------
    nta_props, nta_polys = load_polygons(ref / "nta2020.geojson", "nta2020")
    pct_props, pct_polys = load_polygons(ref / "precincts.geojson", "precinct")

    tract_nta = {r["geoid"]: r["nta2020"] for r in csv.DictReader(open(ref / "tracts2020.csv", encoding="utf-8"))}
    pop = defaultdict(int)
    unmatched_tracts = 0
    for r in csv.DictReader(open(ref / "tract_population.csv", encoding="utf-8")):
        nta = tract_nta.get(r["geoid"])
        if nta is None:
            unmatched_tracts += int(r["population"]) > 0
            continue
        pop[nta] += int(r["population"])

    with open(ref / "nta.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["nta2020", "ntaname", "borocode", "boroname", "ntatype", "population_2020", "land_km2"])
        for p in nta_props:
            w.writerow([p["nta2020"], p["ntaname"], p["borocode"], p["boroname"],
                        NTA_TYPES.get(str(p.get("ntatype")), str(p.get("ntatype"))),
                        pop.get(p["nta2020"], 0), round(float(p["shape_area"]) / SQFT_PER_KM2, 4)])

    # 2. Distinct drawable points ----------------------------------------
    con = duckdb.connect()
    res = con.execute(f"""
        SELECT lat, lon, count(*) AS n
        FROM read_parquet('{(clean / "complaints.parquet").as_posix()}')
        WHERE location_type = 'point' GROUP BY 1, 2
    """)
    tbl = res.to_arrow_table() if hasattr(res, "to_arrow_table") else res.fetch_arrow_table()
    lat = tbl["lat"].to_numpy()
    lon = tbl["lon"].to_numpy()
    pts = shapely.points(lon, lat)

    nta_i, nta_match = assign(pts, nta_polys)
    pct_i, pct_match = assign(pts, pct_polys)
    pick = lambda props, i, k: [props[j][k] if j >= 0 else None for j in i]

    out = pa.table({
        "lat": lat, "lon": lon,
        "nta2020": pick(nta_props, nta_i, "nta2020"),
        "borocode": pa.array([int(x) if x is not None else None for x in pick(nta_props, nta_i, "borocode")], pa.int8()),
        "nta_match": nta_match.astype(str),
        "precinct_geo": pa.array([int(float(x)) if x is not None else None for x in pick(pct_props, pct_i, "precinct")], pa.int16()),
        "precinct_match": pct_match.astype(str),
    })
    pq.write_table(out, clean / "point_geo.parquet", compression="zstd")

    # 3. Checks ------------------------------------------------------------
    con.register("pg", out)
    one = lambda sql: con.execute(sql).fetchone()[0]
    rows_total = one(f"SELECT count(*) FROM read_parquet('{(clean / 'complaints.parquet').as_posix()}') WHERE location_type='point'")
    agree = con.execute(f"""
        SELECT count(*) FILTER (WHERE c.precinct = pg.precinct_geo) AS same,
               count(*) FILTER (WHERE c.precinct <> pg.precinct_geo) AS different,
               count(*) FILTER (WHERE c.precinct IS NULL OR pg.precinct_geo IS NULL) AS unknown
        FROM read_parquet('{(clean / 'complaints.parquet').as_posix()}') c
        JOIN pg USING (lat, lon) WHERE c.location_type = 'point'
    """).fetchone()
    by = lambda col: dict(con.execute(f"SELECT {col}, count(*) FROM pg GROUP BY 1 ORDER BY 2 DESC").fetchall())
    meta = {
        "distinct_points": len(out),
        "point_rows": rows_total,
        "nta_match_points": by("nta_match"),
        "precinct_match_points": by("precinct_match"),
        "rows_without_nta": one(f"""SELECT count(*) FROM read_parquet('{(clean / 'complaints.parquet').as_posix()}') c
                                   JOIN pg USING (lat, lon) WHERE pg.nta2020 IS NULL"""),
        "precinct_field_vs_polygon_rows": {"same": agree[0], "different": agree[1], "unknown": agree[2],
                                           "pct_same": round(100 * agree[0] / max(1, agree[0] + agree[1]), 2)},
        "nta_count": len(nta_props),
        "precinct_polygons": len(pct_props),
        "population_total_2020": sum(pop.values()),
        "populated_tracts_without_nta": unmatched_tracts,
    }
    (clean / "geo_meta.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")
    print(json.dumps(meta, indent=2))


if __name__ == "__main__":
    main()
