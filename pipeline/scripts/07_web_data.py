"""Build the static data files the web map loads (DuckDB-WASM reads them over HTTP Range requests).

Inputs:  data/clean/complaints.parquet, data/clean/point_geo.parquet, data/reference/*,
         pipeline/config/categories.csv
Outputs (data/web/):
  incidents.parquet     one row per complaint, compact codes, spatially sorted (Hilbert curve)
  points.parquet        complaints per snapped location x month x category
  hex.parquet           complaints per H3 cell (res 9, with res-8 parent) x month x category
  agg_nta.parquet       complaints per NTA x month x category (drawable points only)
  agg_precinct.parquet  complaints per NYPD precinct x month x category x location type (all rows)
  nta.geojson, precincts.geojson, boroughs.geojson   simplified boundaries (~5 m tolerance)
  meta.json             dictionaries, labels, populations, totals, notes

Codes: month index m = months since 2016-01 (0..119); day d = days since 2016-01-01;
category = categories.csv `sort` - 1; location type 0 = point, 1 = precinct_only, 2 = none;
law 0 felony, 1 misdemeanor, 2 violation; hour/dow -1 = unknown (dow 0 = Monday).

Usage (from pipeline/):  uv run scripts/07_web_data.py
"""
from __future__ import annotations

import argparse
import csv
import json
from pathlib import Path

import duckdb
import h3
import numpy as np
import pyarrow as pa
from shapely.geometry import mapping, shape
from shapely.ops import unary_union

ROOT = Path(__file__).resolve().parents[2]
CONFIG = Path(__file__).resolve().parents[1] / "config"
ROW_GROUP = 16_384
SIMPLIFY_DEG = 0.00005          # ~5 m
COORD_DECIMALS = 5              # ~1 m
BBOX = (40.49, 40.92, -74.27, -73.68)
BOROUGHS = {"MANHATTAN": 1, "BRONX": 2, "BROOKLYN": 3, "QUEENS": 4, "STATEN ISLAND": 5}


def hilbert_key(lat: np.ndarray, lon: np.ndarray, order: int = 16) -> np.ndarray:
    """Hilbert-curve index of each point on a 2^order grid over the NYC bounding box."""
    n = 1 << order
    x = np.clip(((lon - BBOX[2]) / (BBOX[3] - BBOX[2]) * (n - 1)).astype(np.int64), 0, n - 1)
    y = np.clip(((lat - BBOX[0]) / (BBOX[1] - BBOX[0]) * (n - 1)).astype(np.int64), 0, n - 1)
    d = np.zeros_like(x)
    s = n >> 1
    while s > 0:
        rx = ((x & s) > 0).astype(np.int64)
        ry = ((y & s) > 0).astype(np.int64)
        d += s * s * ((3 * rx) ^ ry)
        # rotate
        flip = ry == 0
        swap_x = flip & (rx == 1)
        x = np.where(swap_x, s - 1 - x, x)
        y = np.where(swap_x, s - 1 - y, y)
        x, y = np.where(flip, y, x), np.where(flip, x, y)
        s >>= 1
    return d


def simplify_geojson(src: Path, dst: Path, keep: list[str], key_fn=None) -> list[dict]:
    feats = json.loads(src.read_text(encoding="utf-8"))["features"]
    out = []
    for f in feats:
        geom = shape(f["geometry"]).simplify(SIMPLIFY_DEG, preserve_topology=True)
        props = {k: f["properties"].get(k) for k in keep}
        if key_fn:
            props = key_fn(props)
        out.append({"type": "Feature", "properties": props, "geometry": round_coords(mapping(geom))})
    dst.write_text(json.dumps({"type": "FeatureCollection", "features": out}, separators=(",", ":")),
                   encoding="utf-8")
    return out


def round_coords(geom: dict) -> dict:
    def r(c):
        return [round(c[0], COORD_DECIMALS), round(c[1], COORD_DECIMALS)] if isinstance(c[0], float) else [r(x) for x in c]
    return {"type": geom["type"], "coordinates": r(geom["coordinates"])}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", type=Path, default=ROOT)
    args = ap.parse_args()
    clean, ref, out = (args.root / "data" / p for p in ("clean", "reference", "web"))
    out.mkdir(parents=True, exist_ok=True)
    con = duckdb.connect()
    P = lambda p: f"'{p.as_posix()}'"

    # Dictionaries --------------------------------------------------------
    cats = list(csv.DictReader(open(CONFIG / "categories.csv", encoding="utf-8")))
    cats.sort(key=lambda c: int(c["sort"]))
    con.execute("CREATE TABLE cat AS SELECT * FROM (VALUES " +
                ", ".join(f"('{c['category']}', {i})" for i, c in enumerate(cats)) + ") t(category, code)")
    ntas = list(csv.DictReader(open(ref / "nta.csv", encoding="utf-8")))
    con.execute("CREATE TABLE nta AS SELECT * FROM (VALUES " +
                ", ".join(f"('{n['nta2020']}', {i})" for i, n in enumerate(ntas)) + ") t(nta2020, code)")
    con.execute(f"CREATE TABLE c AS SELECT * FROM read_parquet({P(clean / 'complaints.parquet')})")
    con.execute(f"CREATE TABLE g AS SELECT * FROM read_parquet({P(clean / 'point_geo.parquet')})")
    premises = [r[0] for r in con.execute(
        "SELECT premise FROM c WHERE premise IS NOT NULL GROUP BY 1 ORDER BY count(*) DESC").fetchall()]
    con.execute("CREATE TABLE prem AS SELECT * FROM (VALUES " +
                ", ".join(f"('{p.replace(chr(39), chr(39) * 2)}', {i})" for i, p in enumerate(premises)) + ") t(premise, code)")
    pd_labels = dict(con.execute("SELECT pd_cd, mode(pd_desc) FROM c WHERE pd_cd IS NOT NULL GROUP BY 1").fetchall())

    # Points: Hilbert key + H3 cells ---------------------------------------
    pts = con.execute("SELECT lat, lon FROM g").fetchnumpy()
    lat, lon = pts["lat"], pts["lon"]
    hk = hilbert_key(lat, lon)
    h9 = [h3.latlng_to_cell(a, b, 9) for a, b in zip(lat, lon)]
    h8 = [h3.cell_to_parent(c, 8) for c in h9]
    con.register("pk", pa.table({"lat": lat, "lon": lon, "hk": hk, "h9": h9, "h8": h8}))
    con.execute("""CREATE TABLE gp AS SELECT g.*, pk.hk, pk.h9, pk.h8, coalesce(nta.code, -1)::SMALLINT AS nta_code
                   FROM g JOIN pk USING (lat, lon) LEFT JOIN nta USING (nta2020)""")

    # Incidents -------------------------------------------------------------
    boro_case = "CASE " + " ".join(f"WHEN c.borough = '{b}' THEN {i}" for b, i in BOROUGHS.items()) + " ELSE 0 END"
    con.execute(f"""
        CREATE TABLE inc AS SELECT
            TRY_CAST(c.id AS BIGINT) AS id,
            date_diff('day', DATE '2016-01-01', c.report_date)::SMALLINT AS d,
            ((year(c.report_date) - 2016) * 12 + month(c.report_date) - 1)::TINYINT AS m,
            cat.code::TINYINT AS cat,
            c.ky_cd, c.pd_cd,
            CASE c.law_category WHEN 'FELONY' THEN 0 WHEN 'MISDEMEANOR' THEN 1 WHEN 'VIOLATION' THEN 2 END::TINYINT AS law,
            c.attempted AS att,
            c.occ_hour AS hour,
            coalesce(isodow(c.occ_date) - 1, -1)::TINYINT AS dow,
            coalesce(prem.code, -1)::SMALLINT AS prem,
            CASE c.location_type WHEN 'point' THEN 0 WHEN 'precinct_only' THEN 1 ELSE 2 END::TINYINT AS lt,
            c.lat::FLOAT AS lat, c.lon::FLOAT AS lon,
            coalesce(gp.nta_code, -1)::SMALLINT AS nta,
            coalesce(c.precinct, -1)::SMALLINT AS pct,
            coalesce(gp.borocode, {boro_case})::TINYINT AS boro,
            gp.hk, gp.h8, gp.h9
        FROM c
        JOIN cat USING (category)
        LEFT JOIN prem USING (premise)
        LEFT JOIN gp ON c.lat = gp.lat AND c.lon = gp.lon
    """)
    con.execute(f"""COPY (SELECT * EXCLUDE (hk, h8, h9) FROM inc ORDER BY hk NULLS LAST, pct, d)
                    TO {P(out / 'incidents.parquet')} (FORMAT parquet, COMPRESSION zstd, ROW_GROUP_SIZE {ROW_GROUP})""")

    # Points / hex / aggregates ------------------------------------------
    con.execute(f"""COPY (SELECT lat, lon, nta, m, cat, count(*)::SMALLINT AS n, any_value(hk) AS hk
                          FROM inc WHERE lt = 0 GROUP BY lat, lon, nta, m, cat ORDER BY hk, m, cat)
                    TO {P(out / 'points_tmp.parquet')} (FORMAT parquet)""")
    con.execute(f"""COPY (SELECT * EXCLUDE (hk) FROM read_parquet({P(out / 'points_tmp.parquet')}))
                    TO {P(out / 'points.parquet')} (FORMAT parquet, COMPRESSION zstd, ROW_GROUP_SIZE {ROW_GROUP})""")
    (out / "points_tmp.parquet").unlink()
    con.execute(f"""COPY (SELECT h8, h9, m, cat, count(*)::INTEGER AS n
                          FROM inc WHERE lt = 0 GROUP BY ALL ORDER BY h8, h9, m, cat)
                    TO {P(out / 'hex.parquet')} (FORMAT parquet, COMPRESSION zstd, ROW_GROUP_SIZE {ROW_GROUP})""")
    con.execute(f"""COPY (SELECT nta, m, cat, count(*)::INTEGER AS n FROM inc WHERE lt = 0 AND nta >= 0
                          GROUP BY ALL ORDER BY nta, m, cat)
                    TO {P(out / 'agg_nta.parquet')} (FORMAT parquet, COMPRESSION zstd)""")
    con.execute(f"""COPY (SELECT pct, boro, m, cat, lt, count(*)::INTEGER AS n FROM inc
                          GROUP BY ALL ORDER BY pct, m, cat, lt)
                    TO {P(out / 'agg_precinct.parquet')} (FORMAT parquet, COMPRESSION zstd)""")

    # Boundaries ------------------------------------------------------------
    nta_index = {n["nta2020"]: i for i, n in enumerate(ntas)}
    nta_feats = simplify_geojson(ref / "nta2020.geojson", out / "nta.geojson",
                                 ["nta2020", "ntaname", "borocode"],
                                 lambda p: {"code": nta_index[p["nta2020"]], "id": p["nta2020"],
                                            "name": p["ntaname"], "boro": int(p["borocode"])})
    simplify_geojson(ref / "precincts.geojson", out / "precincts.geojson", ["precinct"],
                     lambda p: {"pct": int(float(p["precinct"]))})
    src = json.loads((ref / "nta2020.geojson").read_text(encoding="utf-8"))["features"]
    boros = []
    for b in range(1, 6):
        parts = [shape(f["geometry"]) for f in src if int(f["properties"]["borocode"]) == b]
        if not parts:
            continue
        geom = unary_union(parts).simplify(SIMPLIFY_DEG, preserve_topology=True)
        boros.append({"type": "Feature", "properties": {"boro": b},
                      "geometry": round_coords(mapping(geom))})
    (out / "boroughs.geojson").write_text(json.dumps({"type": "FeatureCollection", "features": boros},
                                                     separators=(",", ":")), encoding="utf-8")

    # Meta ------------------------------------------------------------------
    one = lambda sql: con.execute(sql).fetchone()[0]
    clean_meta = json.loads((clean / "clean_meta.json").read_text(encoding="utf-8"))
    meta = {
        "source": {"dataset": "NYPD Complaint Data Historic", "id": "qgea-i56i",
                   "url": "https://data.cityofnewyork.us/d/qgea-i56i",
                   "rows_updated_at": clean_meta.get("rows_updated_at")},
        "window": {"first_month": "2016-01", "months": 120, "first_day": "2016-01-01"},
        "categories": [{"code": i, "id": c["category"], "label": c["label"], "group": c["group"]}
                       for i, c in enumerate(cats)],
        "boroughs": {str(i): b.title() for b, i in BOROUGHS.items()},
        "ntas": [{"code": i, "id": n["nta2020"], "name": n["ntaname"], "boro": int(n["borocode"]),
                  "type": n["ntatype"], "population": int(n["population_2020"]), "km2": float(n["land_km2"])}
                 for i, n in enumerate(ntas)],
        "premises": premises,
        "pd": {str(k): v for k, v in sorted(pd_labels.items())},
        "law": ["Felony", "Misdemeanor", "Violation"],
        "location_types": ["point", "precinct_only", "none"],
        "totals": {
            "complaints": one("SELECT count(*) FROM inc"),
            "drawable": one("SELECT count(*) FROM inc WHERE lt = 0"),
            "precinct_only": one("SELECT count(*) FROM inc WHERE lt = 1"),
            "no_location": one("SELECT count(*) FROM inc WHERE lt = 2"),
            "points": one("SELECT count(*) FROM gp"),
            "population_2020": sum(int(n["population_2020"]) for n in ntas),
        },
        "files": {p.name: p.stat().st_size for p in sorted(out.iterdir()) if p.suffix in (".parquet", ".geojson")},
    }
    (out / "meta.json").write_text(json.dumps(meta, separators=(",", ":"), ensure_ascii=False), encoding="utf-8")

    # Checks -----------------------------------------------------------------
    t = meta["totals"]
    assert t["complaints"] == clean_meta["rows"]
    assert t["drawable"] + t["precinct_only"] + t["no_location"] == t["complaints"]
    assert one(f"SELECT sum(n) FROM read_parquet({P(out / 'points.parquet')})") == t["drawable"]
    assert one(f"SELECT sum(n) FROM read_parquet({P(out / 'hex.parquet')})") == t["drawable"]
    assert one(f"SELECT sum(n) FROM read_parquet({P(out / 'agg_precinct.parquet')})") == t["complaints"]
    assert len(nta_feats) == len(ntas)
    print(json.dumps({"totals": t, "files_mb": {k: round(v / 1e6, 2) for k, v in meta["files"].items()},
                      "hex_cells_res9": one(f"SELECT count(DISTINCT h9) FROM read_parquet({P(out / 'hex.parquet')})"),
                      "hex_cells_res8": one(f"SELECT count(DISTINCT h8) FROM read_parquet({P(out / 'hex.parquet')})")},
                     indent=2))


if __name__ == "__main__":
    main()
