"""Clean the raw NYPD complaint snapshot into one analysis-ready table.

Rules (see docs/DATA_NOTES.md and docs/DECISIONS.md):
  - Window: report years 2016-2025, counted by report date.
  - "(null)" and blank strings become NULL.
  - Duplicate complaint IDs: keep one row (earliest report, then earliest occurrence).
  - Offense category from the stable key code (ky_cd) via config/offense_codes.csv.
    Unknown codes stop the run.
  - Location type:
      precinct_only  rape/sex crimes, sensitive sexual-exploitation offenses, and every complaint
                     placed on the same points (NYPD puts these at the precinct station house);
                     counted in precinct/borough/city totals, never drawn as a place.
      point          drawn at its (snapped) coordinates.
      none           no usable coordinates.

Usage (from pipeline/):  uv run scripts/03_clean.py
Output: data/clean/complaints.parquet + data/clean/clean_meta.json
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import duckdb

ROOT = Path(__file__).resolve().parents[2]
RAW = ROOT / "data" / "raw" / "qgea-i56i"
OUT = ROOT / "data" / "clean"
CONFIG = Path(__file__).resolve().parents[1] / "config"

YEARS = (2016, 2025)
SEX_KY = ("104", "116", "233")
# Sexual-exploitation offenses filed under other key codes: also withheld.
SENSITIVE_PD_DESC = ("PROMOTING A SEXUAL PERFORMANCE", "SEX TRAFFICKING",
                     "USE OF A CHILD IN A SEXUAL PER", "UNLAWFUL DISCLOSURE OF AN INTIMATE IMAGE")
BBOX = (40.49, 40.92, -74.27, -73.68)
TEXT_COLS = ("cmplnt_fr_tm", "ofns_desc", "pd_desc", "crm_atpt_cptd_cd", "law_cat_cd", "boro_nm",
             "loc_of_occur_desc", "prem_typ_desc", "juris_desc", "parks_nm", "hadevelopt",
             "station_name", "patrol_boro")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--raw", type=Path, default=RAW)
    ap.add_argument("--out", type=Path, default=OUT)
    args = ap.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)

    con = duckdb.connect()
    files = [f.as_posix() for f in sorted(args.raw.glob("*.parquet"))]
    con.execute(f"CREATE VIEW raw AS SELECT * FROM read_parquet({files}, union_by_name=true)")
    con.execute(f"CREATE TABLE codes AS SELECT * FROM read_csv('{(CONFIG / 'offense_codes.csv').as_posix()}', all_varchar=true)")
    con.execute(f"CREATE TABLE cats AS SELECT * FROM read_csv('{(CONFIG / 'categories.csv').as_posix()}', all_varchar=true)")

    nul = lambda c: f"NULLIF(NULLIF(trim({c}), '(null)'), '')"
    ts = lambda c: f"TRY_CAST(replace({c}, 'T', ' ') AS TIMESTAMP)"
    text = ",\n".join(f"{nul(c)} AS {c}" for c in TEXT_COLS)

    # 1. Normalize + window + dedupe ---------------------------------------
    con.execute(f"""
        CREATE TABLE w AS
        SELECT * EXCLUDE (rn) FROM (
            SELECT
                cmplnt_num AS id,
                CAST({ts('rpt_dt')} AS DATE) AS report_date,
                CAST({ts('cmplnt_fr_dt')} AS DATE) AS occ_date,
                CAST({ts('cmplnt_to_dt')} AS DATE) AS occ_end_date,
                {text},
                ky_cd, pd_cd,
                TRY_CAST(addr_pct_cd AS SMALLINT) AS precinct,
                TRY_CAST(jurisdiction_code AS SMALLINT) AS jurisdiction_code,
                TRY_CAST(latitude AS DOUBLE)  AS lat,
                TRY_CAST(longitude AS DOUBLE) AS lon,
                latitude AS lat_raw, longitude AS lon_raw,
                row_number() OVER (PARTITION BY cmplnt_num
                                   ORDER BY {ts('rpt_dt')}, {ts('cmplnt_fr_dt')} NULLS LAST) AS rn
            FROM raw
            WHERE {ts('rpt_dt')} >= TIMESTAMP '{YEARS[0]}-01-01'
              AND {ts('rpt_dt')} <  TIMESTAMP '{YEARS[1] + 1}-01-01'
        ) WHERE rn = 1
    """)

    unknown = con.execute("SELECT DISTINCT ky_cd FROM w WHERE ky_cd NOT IN (SELECT ky_cd FROM codes)").fetchall()
    if unknown:
        raise SystemExit(f"Unmapped ky_cd values {unknown}: add them to config/offense_codes.csv")

    # 2. Precinct-only points ----------------------------------------------
    sens = ", ".join(f"'{d}'" for d in SENSITIVE_PD_DESC)
    con.execute(f"""
        CREATE TABLE withheld_pts AS
        SELECT lat_raw, lon_raw, mode(precinct) AS precinct, count(*) AS sex_crime_rows
        FROM w WHERE ky_cd IN {SEX_KY} AND lat_raw IS NOT NULL
        GROUP BY 1, 2
    """)

    # 3. Final table -------------------------------------------------------
    lat0, lat1, lon0, lon1 = BBOX
    con.execute(f"""
        CREATE TABLE clean AS
        SELECT
            w.id,
            w.report_date,
            year(w.report_date)::SMALLINT AS report_year,
            w.occ_date,
            w.occ_end_date,
            coalesce(TRY_CAST(substr(w.cmplnt_fr_tm, 1, 2) AS TINYINT), -1)::TINYINT AS occ_hour,
            (substr(w.cmplnt_fr_tm, 4, 2) = '00') AS occ_time_on_hour,
            TRY_CAST(w.ky_cd AS SMALLINT) AS ky_cd,
            TRY_CAST(w.pd_cd AS SMALLINT) AS pd_cd,
            w.ofns_desc, w.pd_desc,
            codes.category,
            cats."group" AS category_group,
            w.law_cat_cd AS law_category,
            (w.crm_atpt_cptd_cd = 'ATTEMPTED') AS attempted,
            w.boro_nm AS borough,
            w.precinct,
            w.patrol_boro,
            w.juris_desc AS jurisdiction,
            w.jurisdiction_code,
            w.prem_typ_desc AS premise,
            w.loc_of_occur_desc AS location_desc,
            w.parks_nm AS park,
            w.hadevelopt AS nycha_development,
            w.station_name AS transit_station,
            CASE
                WHEN w.ky_cd IN {SEX_KY} OR w.pd_desc IN ({sens}) OR wp.lat_raw IS NOT NULL THEN 'precinct_only'
                WHEN w.lat BETWEEN {lat0} AND {lat1} AND w.lon BETWEEN {lon0} AND {lon1} THEN 'point'
                ELSE 'none'
            END AS location_type,
            CASE WHEN location_type = 'point' THEN w.lat END AS lat,
            CASE WHEN location_type = 'point' THEN w.lon END AS lon
        FROM w
        JOIN codes USING (ky_cd)
        JOIN cats USING (category)
        LEFT JOIN withheld_pts wp ON w.lat_raw = wp.lat_raw AND w.lon_raw = wp.lon_raw
        ORDER BY w.report_date, w.id
    """)

    out = args.out / "complaints.parquet"
    con.execute(f"COPY clean TO '{out.as_posix()}' (FORMAT parquet, COMPRESSION zstd, ROW_GROUP_SIZE 122880)")
    con.execute(f"COPY withheld_pts TO '{(args.out / 'precinct_points.csv').as_posix()}' (HEADER)")

    # 4. Checks + summary --------------------------------------------------
    one = lambda sql: con.execute(sql).fetchone()[0]
    raw_window = one(f"""SELECT count(*) FROM raw WHERE {ts('rpt_dt')} >= TIMESTAMP '{YEARS[0]}-01-01'
                         AND {ts('rpt_dt')} < TIMESTAMP '{YEARS[1] + 1}-01-01'""")
    total = one("SELECT count(*) FROM clean")
    meta = {
        "source": "NYC Open Data qgea-i56i",
        "rows_updated_at": json.loads((args.raw / "manifest.json").read_text(encoding="utf-8")).get("rows_updated_at_iso")
        if (args.raw / "manifest.json").exists() else None,
        "window": list(YEARS),
        "raw_rows_in_window": raw_window,
        "duplicates_removed": raw_window - total,
        "rows": total,
        "by_year": dict(con.execute("SELECT report_year::VARCHAR, count(*) FROM clean GROUP BY 1 ORDER BY 1").fetchall()),
        "by_location_type": dict(con.execute("SELECT location_type, count(*) FROM clean GROUP BY 1 ORDER BY 2 DESC").fetchall()),
        "by_category": dict(con.execute("SELECT category, count(*) FROM clean GROUP BY 1 ORDER BY 2 DESC").fetchall()),
        "precinct_points": one("SELECT count(*) FROM withheld_pts"),
        "precincts_with_points": one("SELECT count(DISTINCT precinct) FROM withheld_pts"),
        "distinct_points": one("SELECT count(DISTINCT (lat, lon)) FROM clean WHERE location_type = 'point'"),
    }
    (args.out / "clean_meta.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")
    assert total == raw_window - meta["duplicates_removed"]
    assert one("SELECT count(*) FROM clean WHERE category IS NULL") == 0
    assert one("SELECT count(*) FROM clean WHERE category = 'sex_crimes' AND location_type <> 'precinct_only'") == 0
    print(json.dumps(meta, indent=2))
    print(f"Wrote {out}")


if __name__ == "__main__":
    main()
