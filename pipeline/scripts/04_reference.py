"""Download reference data: boundaries, population and NYPD's own published totals.

  - 2020 Neighborhood Tabulation Areas (NYC Open Data 9nt8-h7nd)      -> nta2020.geojson
  - Police Precincts (NYC Open Data y76i-bdw7)                        -> precincts.geojson
  - 2020 Census Tracts, attributes only (NYC Open Data 63ge-mke6)     -> tracts2020.csv
  - 2020 Census population by tract (US Census API, PL 94-171, P1_001N) -> tract_population.csv
  - NYPD historical CompStat tables, seven major felonies (nyc.gov)   -> compstat/*.xls

Usage (from pipeline/):  uv run scripts/04_reference.py
Output: data/reference/ + data/reference/manifest.json
"""
from __future__ import annotations

import csv
import datetime as dt
import json
import sys
import time
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "data" / "reference"
SODA = "https://data.cityofnewyork.us"
NYPD = "https://www.nyc.gov/assets/nypd/downloads/excel/analysis_and_planning/historical-crime-data"
COMPSTAT_FILES = [
    "seven-major-felony-offenses-2000-2025.xls",
    "seven-major-felony-offenses-by-precinct-2000-2025.xls",
]
NYC_COUNTIES = "005,047,061,081,085"  # Bronx, Brooklyn, Manhattan, Queens, Staten Island
ENV_FILE = Path(__file__).resolve().parents[1] / ".env"


def census_key() -> str:
    """Free key from https://api.census.gov/data/key_signup.html, stored in pipeline/.env
    as CENSUS_API_KEY=... (git-ignored) or in the environment variable of the same name."""
    import os
    key = os.environ.get("CENSUS_API_KEY")
    if not key and ENV_FILE.exists():
        for line in ENV_FILE.read_text(encoding="utf-8-sig").splitlines():
            line = line.strip().strip('"')
            if line.startswith("CENSUS_API_KEY="):
                key = line.split("=", 1)[1].strip().strip('"')
            elif line and "=" not in line and not line.startswith("#"):
                key = line          # file holds just the key
    if not key:
        sys.exit("Missing Census API key. Get one free at https://api.census.gov/data/key_signup.html\n"
                 f"and save it in {ENV_FILE} as:  CENSUS_API_KEY=your_key")
    return key


def get(url: str, params=None, tries: int = 5) -> requests.Response:
    for i in range(tries):
        try:
            r = requests.get(url, params=params, timeout=180,
                             headers={"User-Agent": "nyc-crime-map data pipeline"})
            if r.status_code == 200:
                return r
            err = f"HTTP {r.status_code}"
            if 400 <= r.status_code < 500 and r.status_code != 429:
                sys.exit(f"{err} for {url}: {r.text[:300]}")
        except requests.RequestException as e:
            err = str(e)
        print(f"  retry {i + 1}/{tries}: {err}")
        time.sleep(5 * 2**i)
    sys.exit(f"Giving up: {url}")


def soda_updated(dataset: str) -> str:
    meta = get(f"{SODA}/api/views/{dataset}.json").json()
    return dt.datetime.fromtimestamp(meta["rowsUpdatedAt"], dt.timezone.utc).isoformat()


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "compstat").mkdir(exist_ok=True)
    manifest: dict = {"downloaded_at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"), "files": {}}

    for name, dataset in [("nta2020.geojson", "9nt8-h7nd"), ("precincts.geojson", "y76i-bdw7")]:
        print(f"{name} ({dataset})")
        r = get(f"{SODA}/resource/{dataset}.geojson", {"$limit": 5000})
        n = len(r.json()["features"])
        (OUT / name).write_bytes(r.content)
        manifest["files"][name] = {"source": f"{SODA}/d/{dataset}", "features": n,
                                   "rows_updated_at": soda_updated(dataset)}
        print(f"  {n} features")

    print("tracts2020.csv (63ge-mke6)")
    r = get(f"{SODA}/resource/63ge-mke6.csv",
            {"$select": "geoid,boroct2020,nta2020,ntaname,cdta2020", "$limit": 10000})
    (OUT / "tracts2020.csv").write_bytes(r.content)
    manifest["files"]["tracts2020.csv"] = {"source": f"{SODA}/d/63ge-mke6",
                                           "rows_updated_at": soda_updated("63ge-mke6")}

    print("tract_population.csv (Census API 2020 PL P1_001N)")
    key = census_key()
    data = []
    for county in NYC_COUNTIES.split(","):
        r = get("https://api.census.gov/data/2020/dec/pl",
                [("get", "P1_001N"), ("for", "tract:*"), ("in", "state:36"), ("in", f"county:{county}"), ("key", key)])
        try:
            rows = r.json()
        except ValueError:
            sys.exit(f"Census API did not return JSON for county {county} (check the key):\n{r.text[:300]}")
        header = rows[0]
        data += rows[1:]
        print(f"  county {county}: {len(rows) - 1} tracts")
    i_pop, i_st, i_co, i_tr = (header.index(c) for c in ("P1_001N", "state", "county", "tract"))
    with open(OUT / "tract_population.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["geoid", "population"])
        for row in data:
            w.writerow([row[i_st] + row[i_co] + row[i_tr], int(row[i_pop])])
    total = sum(int(r[i_pop]) for r in data)
    manifest["files"]["tract_population.csv"] = {
        "source": "https://api.census.gov/data/2020/dec/pl (P1_001N, total population)",
        "tracts": len(data), "total_population": total}
    print(f"  {len(data)} tracts, population {total:,} (2020 Census official NYC total: 8,804,190)")

    for fname in COMPSTAT_FILES:
        print(f"compstat/{fname}")
        r = get(f"{NYPD}/{fname}")
        (OUT / "compstat" / fname).write_bytes(r.content)
        manifest["files"][f"compstat/{fname}"] = {"source": f"{NYPD}/{fname}", "bytes": len(r.content)}

    (OUT / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    print(f"Done. Files in {OUT}")


if __name__ == "__main__":
    main()
