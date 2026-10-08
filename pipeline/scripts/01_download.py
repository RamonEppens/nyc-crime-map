"""Download NYPD Complaint Data Historic (qgea-i56i) from NYC Open Data.

One file per *report year* (rpt_dt), pulled through the SODA API as CSV and
stored as raw Parquet: every column kept as text, values untouched. Each year
is validated against the API's own row count before it is accepted.

Usage (from the pipeline/ folder):
    uv run scripts/01_download.py                      # 2006-2025 + rows without rpt_dt
    uv run scripts/01_download.py --from-year 2016     # a subset
    uv run scripts/01_download.py --force 2024         # re-download one year

Optional env var: SOCRATA_APP_TOKEN (free at data.cityofnewyork.us; raises rate limits).
Output: data/raw/qgea-i56i/rpt_year=YYYY.parquet + manifest.json + metadata.json
"""
from __future__ import annotations

import argparse
import datetime as dt
import io
import json
import os
import sys
import time
from pathlib import Path

import pyarrow as pa
import pyarrow.csv as pacsv
import pyarrow.parquet as pq
import requests

DOMAIN = "https://data.cityofnewyork.us"
DATASET = "qgea-i56i"
PAGE_SIZE = 200_000
ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "data" / "raw" / DATASET


def make_session() -> requests.Session:
    s = requests.Session()
    s.headers["User-Agent"] = "nyc-crime-map data pipeline"
    token = os.environ.get("SOCRATA_APP_TOKEN")
    if token:
        s.headers["X-App-Token"] = token
    return s


def get(s: requests.Session, url: str, params: dict | None = None, tries: int = 6) -> requests.Response:
    for i in range(tries):
        try:
            r = s.get(url, params=params, timeout=600)
        except requests.RequestException as e:
            err = str(e)
        else:
            if r.status_code == 200:
                return r
            if 400 <= r.status_code < 500 and r.status_code != 429:
                sys.exit(f"HTTP {r.status_code} (not retrying): {r.text[:500]}")
            err = f"HTTP {r.status_code}"
        wait = min(5 * 2**i, 120)
        print(f"    retry {i + 1}/{tries} after {err}; waiting {wait}s", flush=True)
        time.sleep(wait)
    sys.exit(f"Giving up after {tries} tries: {url} {params}")


def fetch_metadata(s: requests.Session) -> dict:
    meta = get(s, f"{DOMAIN}/api/views/{DATASET}.json").json()
    (OUT / "metadata.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")
    return meta


def data_columns(meta: dict) -> list[str]:
    """Real data columns only: no system (:id...) or computed-region columns, no
    point/location column (latitude/longitude already exist as plain fields)."""
    cols = []
    for c in meta["columns"]:
        name = c["fieldName"]
        if name.startswith(":") or c.get("dataTypeName") in ("point", "location"):
            continue
        cols.append(name)
    return cols


def year_filter(year: int | None) -> str:
    if year is None:
        return "rpt_dt IS NULL"
    return f"rpt_dt >= '{year}-01-01T00:00:00' AND rpt_dt < '{year + 1}-01-01T00:00:00'"


def api_count(s: requests.Session, where: str) -> int:
    r = get(s, f"{DOMAIN}/resource/{DATASET}.json", {"$select": "count(*) AS n", "$where": where})
    return int(r.json()[0]["n"])


def download_year(s: requests.Session, year: int | None, cols: list[str]) -> dict:
    label = "unknown" if year is None else str(year)
    where = year_filter(year)
    expected = api_count(s, where)
    final = OUT / f"rpt_year={label}.parquet"
    tmp = final.with_suffix(".parquet.part")
    print(f"[{label}] {expected:,} rows expected", flush=True)

    schema = pa.schema([(c, pa.string()) for c in cols])
    convert = pacsv.ConvertOptions(
        column_types={c: pa.string() for c in cols},
        include_columns=cols,
        null_values=[""],
        strings_can_be_null=True,
    )
    got, offset = 0, 0
    with pq.ParquetWriter(tmp, schema, compression="zstd") as writer:
        while offset < expected or expected == 0:
            r = get(s, f"{DOMAIN}/resource/{DATASET}.csv", {
                "$select": ",".join(cols),
                "$where": where,
                "$order": ":id",
                "$limit": PAGE_SIZE,
                "$offset": offset,
            })
            table = pacsv.read_csv(io.BytesIO(r.content), convert_options=convert)
            if table.num_rows == 0:
                break
            writer.write_table(table.select(cols).cast(schema))
            got += table.num_rows
            offset += PAGE_SIZE
            print(f"    {got:,}/{expected:,}", flush=True)
            if table.num_rows < PAGE_SIZE:
                break

    if got != expected:
        tmp.unlink(missing_ok=True)
        sys.exit(f"[{label}] row count mismatch: downloaded {got:,}, API says {expected:,}. Re-run.")
    tmp.replace(final)
    return {"rows": got, "api_count": expected, "file": final.name,
            "downloaded_at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")}


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--from-year", type=int, default=2006)
    ap.add_argument("--to-year", type=int, default=2025)
    ap.add_argument("--no-unknown", action="store_true", help="skip rows with no report date")
    ap.add_argument("--force", nargs="*", default=[], help="years to re-download even if present")
    args = ap.parse_args()

    OUT.mkdir(parents=True, exist_ok=True)
    s = make_session()
    meta = fetch_metadata(s)
    cols = data_columns(meta)
    updated = dt.datetime.fromtimestamp(meta["rowsUpdatedAt"], dt.timezone.utc).isoformat()
    print(f"Dataset last updated {updated}; {len(cols)} columns", flush=True)

    manifest_path = OUT / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8")) if manifest_path.exists() else {}
    if manifest.get("rows_updated_at") not in (None, meta["rowsUpdatedAt"]):
        print("WARNING: the dataset changed since the last download; use --force for a clean snapshot.")
    manifest.update({"dataset": DATASET, "rows_updated_at": meta["rowsUpdatedAt"],
                     "rows_updated_at_iso": updated, "columns": cols})
    manifest.setdefault("years", {})

    years: list[int | None] = list(range(args.from_year, args.to_year + 1))
    if not args.no_unknown:
        years.append(None)
    for y in years:
        label = "unknown" if y is None else str(y)
        if label in manifest["years"] and (OUT / manifest["years"][label]["file"]).exists() \
                and label not in args.force:
            print(f"[{label}] already downloaded, skipping")
            continue
        manifest["years"][label] = download_year(s, y, cols)
        manifest_path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")

    total = sum(v["rows"] for v in manifest["years"].values())
    print(f"Done. {total:,} rows across {len(manifest['years'])} files in {OUT}")


if __name__ == "__main__":
    main()
