"""Download the street and census-block data used by search, streets and precinct population.

  - Centerline (CSCL), NYC Open Data inkn-q76z       -> centerline.geojsonl  (one segment per line)
  - 2020 Census Blocks, NYC Open Data wmsu-5muw       -> census_blocks2020.geojson
  - 2020 Census population by block (Census API, PL 94-171, P1_001N) -> block_population.csv

Network only; the processing is in 08_streets.py, which runs offline.
Usage (from pipeline/):  uv run scripts/08_download_streets.py
Output: data/reference/ (+ entries in data/reference/manifest.json)
"""
from __future__ import annotations

import csv
import datetime as dt
import importlib.util
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location("ref", HERE / "04_reference.py")   # reuse get(), census_key()
ref = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(ref)

OUT = ref.OUT
SODA = ref.SODA
PAGE = 20000
CENTERLINE_FIELDS = [
    "the_geom", "physicalid", "full_street_name", "stname_label", "street_name", "b5sc",
    "boroughcode", "l_low_hn", "l_high_hn", "r_low_hn", "r_high_hn", "rw_type", "status",
    "segment_type", "from_level_code", "to_level_code", "shape_length",
]


def centerline() -> int:
    """All segments, paged, written as GeoJSON lines (resumable by re-running)."""
    path = OUT / "centerline.geojsonl"
    tmp = path.with_suffix(".part")
    n = 0
    with open(tmp, "w", encoding="utf-8") as f:
        offset = 0
        while True:
            r = ref.get(f"{SODA}/resource/inkn-q76z.geojson",
                        {"$select": ",".join(CENTERLINE_FIELDS), "$order": "physicalid",
                         "$limit": PAGE, "$offset": offset})
            feats = r.json()["features"]
            for feat in feats:
                f.write(json.dumps(feat, separators=(",", ":")) + "\n")
            n += len(feats)
            print(f"  {n:,} segments")
            if len(feats) < PAGE:
                break
            offset += PAGE
    tmp.replace(path)
    return n


def blocks() -> int:
    r = ref.get(f"{SODA}/resource/wmsu-5muw.geojson", {"$select": "the_geom,geoid,borocode", "$limit": 60000})
    n = len(r.json()["features"])
    (OUT / "census_blocks2020.geojson").write_bytes(r.content)
    return n


def block_population() -> tuple[int, int]:
    key = ref.census_key()
    rows_out = []
    for county in ref.NYC_COUNTIES.split(","):
        r = ref.get("https://api.census.gov/data/2020/dec/pl",
                    [("get", "P1_001N"), ("for", "block:*"), ("in", "state:36"), ("in", f"county:{county}"),
                     ("in", "tract:*"), ("key", key)])
        try:
            rows = r.json()
        except ValueError:
            sys.exit(f"Census API did not return JSON for county {county} (check the key):\n{r.text[:300]}")
        h = rows[0]
        i = {c: h.index(c) for c in ("P1_001N", "state", "county", "tract", "block")}
        for row in rows[1:]:
            rows_out.append((row[i["state"]] + row[i["county"]] + row[i["tract"]] + row[i["block"]], int(row[i["P1_001N"]])))
        print(f"  county {county}: {len(rows) - 1:,} blocks")
    with open(OUT / "block_population.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["geoid", "population"])
        w.writerows(rows_out)
    return len(rows_out), sum(p for _, p in rows_out)


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    mpath = OUT / "manifest.json"
    manifest = json.loads(mpath.read_text(encoding="utf-8")) if mpath.exists() else {"files": {}}
    now = dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")

    print("centerline.geojsonl (inkn-q76z)")
    n = centerline()
    manifest["files"]["centerline.geojsonl"] = {"source": f"{SODA}/d/inkn-q76z", "segments": n,
                                                "rows_updated_at": ref.soda_updated("inkn-q76z"), "downloaded_at": now}

    print("census_blocks2020.geojson (wmsu-5muw)")
    n = blocks()
    print(f"  {n:,} blocks")
    manifest["files"]["census_blocks2020.geojson"] = {"source": f"{SODA}/d/wmsu-5muw", "features": n,
                                                      "rows_updated_at": ref.soda_updated("wmsu-5muw"), "downloaded_at": now}

    print("block_population.csv (Census API 2020 PL P1_001N)")
    n, total = block_population()
    print(f"  {n:,} blocks, population {total:,} (2020 Census official NYC total: 8,804,190)")
    manifest["files"]["block_population.csv"] = {
        "source": "https://api.census.gov/data/2020/dec/pl (P1_001N by block)", "blocks": n,
        "total_population": total, "downloaded_at": now}

    mpath.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    print(f"Done. Files in {OUT}")


if __name__ == "__main__":
    main()
