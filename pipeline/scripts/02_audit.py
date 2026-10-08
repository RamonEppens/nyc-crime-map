"""Data audit of the raw NYPD complaint snapshot.

Reads data/raw/qgea-i56i/*.parquet with DuckDB and writes a Markdown report to
docs/audit/AUDIT_REPORT.md (plus CSV tables in docs/audit/tables/). The report
is descriptive only: it measures what is in the data so we can decide, and
document, how to clean and present it.

Suspect/victim demographic columns are only checked for completeness; their
values are never broken down (project decision #3).

Usage (from pipeline/):  uv run scripts/02_audit.py [--raw PATH] [--out PATH]
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
from pathlib import Path

import duckdb

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_RAW = ROOT / "data" / "raw" / "qgea-i56i"
OUT = ROOT / "docs" / "audit"

# Rough bounding box of the five boroughs (WGS84).
BBOX = dict(lat_min=40.49, lat_max=40.92, lon_min=-74.27, lon_max=-73.68)
DEMOGRAPHIC = {"susp_age_group", "susp_race", "susp_sex", "vic_age_group", "vic_race", "vic_sex"}
PLACEHOLDERS = ("(null)", "UNKNOWN", "NULL", "N/A", "")

TS = lambda c: (f"COALESCE(TRY_CAST(replace({c}, 'T', ' ') AS TIMESTAMP), "
                f"TRY_STRPTIME({c}, '%m/%d/%Y'))")


class Report:
    def __init__(self, con: duckdb.DuckDBPyConnection, out: Path):
        self.con, self.parts, self.out = con, [], out
        (out / "tables").mkdir(parents=True, exist_ok=True)

    def h(self, text: str, level: int = 2):
        self.parts.append(f"\n{'#' * level} {text}\n")

    def p(self, text: str):
        self.parts.append(text + "\n")

    def scalar(self, sql: str):
        return self.con.execute(sql).fetchone()[0]

    def table(self, sql: str, name: str | None = None, max_rows: int = 60):
        cur = self.con.execute(sql)
        cols = [d[0] for d in cur.description]
        rows = cur.fetchall()
        if name:
            self.con.execute(f"COPY ({sql}) TO '{(self.out / 'tables' / f'{name}.csv').as_posix()}' (HEADER)")
        def fmt(v):
            if v is None:
                return ""
            if isinstance(v, float):
                return f"{v:,.6f}".rstrip("0").rstrip(".")
            if isinstance(v, int):
                return f"{v:,}"
            return str(v).replace("|", "/")
        lines = ["| " + " | ".join(cols) + " |", "|" + "---|" * len(cols)]
        lines += ["| " + " | ".join(fmt(v) for v in r) + " |" for r in rows[:max_rows]]
        if len(rows) > max_rows:
            lines.append(f"\n_{len(rows) - max_rows} more rows in `tables/{name}.csv`_")
        self.parts.append("\n".join(lines) + "\n")

    def write(self):
        path = self.out / "AUDIT_REPORT.md"
        path.write_text("\n".join(self.parts), encoding="utf-8")
        return path


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--raw", type=Path, default=DEFAULT_RAW)
    ap.add_argument("--out", type=Path, default=OUT)
    args = ap.parse_args()

    con = duckdb.connect()
    files = sorted(args.raw.glob("*.parquet"))
    if not files:
        raise SystemExit(f"No parquet files in {args.raw}. Run 01_download.py first.")
    con.execute(f"""
        CREATE VIEW raw AS SELECT * FROM read_parquet({[f.as_posix() for f in files]}, union_by_name=true);
        CREATE TABLE c AS SELECT
            *,
            {TS('rpt_dt')}        AS rpt_ts,
            {TS('cmplnt_fr_dt')}  AS fr_ts,
            {TS('cmplnt_to_dt')}  AS to_ts,
            TRY_CAST(latitude AS DOUBLE)  AS lat,
            TRY_CAST(longitude AS DOUBLE) AS lon
        FROM raw;
    """)
    cols = [r[0] for r in con.execute("DESCRIBE raw").fetchall()]
    R = Report(con, args.out)

    meta_path = args.raw / "manifest.json"
    manifest = json.loads(meta_path.read_text(encoding="utf-8")) if meta_path.exists() else {}
    total = R.scalar("SELECT count(*) FROM c")

    R.h("NYPD Complaint Data Historic — data audit", 1)
    R.p(f"Generated {dt.date.today().isoformat()} from {len(files)} files, **{total:,} rows**. "
        f"Dataset snapshot (rowsUpdatedAt): {manifest.get('rows_updated_at_iso', 'unknown')}.")
    R.p("Descriptive only. Interpretation and decisions go in `docs/DATA_NOTES.md`.")

    # 1. Volume -------------------------------------------------------------
    R.h("1. Volume by report year")
    R.table("""SELECT year(rpt_ts)::VARCHAR AS report_year, count(*) AS rows,
                      round(100.0*count(*)/sum(count(*)) OVER (), 2) AS pct
               FROM c GROUP BY 1 ORDER BY 1""", "rows_by_report_year")

    # 2. Identity -----------------------------------------------------------
    R.h("2. Complaint ID uniqueness")
    R.table("""SELECT count(*) AS rows, count(DISTINCT cmplnt_num) AS distinct_ids,
                      count(*) - count(DISTINCT cmplnt_num) AS duplicate_rows,
                      count(*) FILTER (WHERE cmplnt_num IS NULL) AS null_ids FROM c""")
    R.table("""SELECT cmplnt_num, count(*) AS n FROM c WHERE cmplnt_num IS NOT NULL
               GROUP BY 1 HAVING n > 1 ORDER BY n DESC LIMIT 20""", "duplicate_ids")

    # 3. Dates --------------------------------------------------------------
    R.h("3. Dates: occurrence vs report")
    R.table(f"""SELECT
          round(100.0*avg((rpt_ts IS NULL)::INT), 3) AS pct_no_report_date,
          round(100.0*avg((cmplnt_fr_dt IS NULL)::INT), 3) AS pct_no_occurrence_date,
          round(100.0*avg((cmplnt_fr_dt IS NOT NULL AND fr_ts IS NULL)::INT), 3) AS pct_unparseable_occurrence,
          round(100.0*avg((to_ts IS NOT NULL)::INT), 2) AS pct_with_end_date,
          round(100.0*avg((fr_ts > rpt_ts)::INT), 3) AS pct_occurs_after_report
        FROM c""")
    R.p("Occurrence year vs report year (rows where they differ are late reports or bad dates):")
    R.table("""SELECT year(rpt_ts)::VARCHAR AS report_year,
                      count(*) FILTER (WHERE year(fr_ts) = year(rpt_ts)) AS same_year,
                      count(*) FILTER (WHERE year(fr_ts) = year(rpt_ts) - 1) AS prev_year,
                      count(*) FILTER (WHERE year(fr_ts) < year(rpt_ts) - 1) AS older,
                      count(*) FILTER (WHERE year(fr_ts) < 1990) AS before_1990,
                      count(*) FILTER (WHERE fr_ts IS NULL) AS no_occ_date
               FROM c GROUP BY 1 ORDER BY 1""", "occurrence_vs_report_year")
    R.p("Reporting lag (days from occurrence start to report), by offense level:")
    R.table("""SELECT law_cat_cd, count(*) AS n,
                      quantile_cont(date_diff('day', fr_ts, rpt_ts), 0.5)  AS p50_days,
                      quantile_cont(date_diff('day', fr_ts, rpt_ts), 0.9)  AS p90_days,
                      quantile_cont(date_diff('day', fr_ts, rpt_ts), 0.99) AS p99_days
               FROM c WHERE fr_ts IS NOT NULL AND rpt_ts IS NOT NULL GROUP BY 1 ORDER BY 2 DESC""",
            "report_lag")

    # 4. Times --------------------------------------------------------------
    R.h("4. Time of day")
    R.p("Heaping at round times (00:00, 12:00, on the hour) signals estimated or default times.")
    R.table("""SELECT round(100.0*avg((cmplnt_fr_tm IS NULL)::INT), 3) AS pct_null,
                      round(100.0*avg((cmplnt_fr_tm LIKE '00:00%')::INT), 2) AS pct_midnight,
                      round(100.0*avg((cmplnt_fr_tm LIKE '12:00%')::INT), 2) AS pct_noon,
                      round(100.0*avg((substr(cmplnt_fr_tm, 4, 2) = '00')::INT), 2) AS pct_on_the_hour
               FROM c""")
    R.table("""SELECT TRY_CAST(substr(cmplnt_fr_tm, 1, 2) AS INT) AS hour, count(*) AS n
               FROM c GROUP BY 1 ORDER BY 1""", "hour_histogram", max_rows=30)

    # 5. Location -----------------------------------------------------------
    R.h("5. Location")
    R.table(f"""SELECT
          round(100.0*avg((lat IS NULL OR lon IS NULL)::INT), 2) AS pct_no_coords,
          round(100.0*avg((lat IS NOT NULL AND NOT (lat BETWEEN {BBOX['lat_min']} AND {BBOX['lat_max']}
                 AND lon BETWEEN {BBOX['lon_min']} AND {BBOX['lon_max']}))::INT), 3) AS pct_outside_nyc_bbox,
          round(100.0*avg((x_coord_cd IS NULL)::INT), 2) AS pct_no_state_plane
        FROM c""")
    R.p("Share without coordinates, by report year:")
    R.table("""SELECT year(rpt_ts)::VARCHAR AS report_year, count(*) AS n,
                      round(100.0*avg((lat IS NULL)::INT), 2) AS pct_no_coords
               FROM c GROUP BY 1 ORDER BY 1""", "no_coords_by_year")
    R.p("Offenses with the highest share of missing coordinates (n ≥ 500):")
    R.table("""SELECT ofns_desc, count(*) AS n, round(100.0*avg((lat IS NULL)::INT), 1) AS pct_no_coords
               FROM c GROUP BY 1 HAVING n >= 500 ORDER BY pct_no_coords DESC, n DESC LIMIT 25""",
            "no_coords_by_offense")
    R.p("**Coordinate stacking**: how many incidents share an identical point.")
    R.table("""WITH pts AS (SELECT round(lat, 6) AS la, round(lon, 6) AS lo, count(*) AS k
                            FROM c WHERE lat IS NOT NULL GROUP BY 1, 2)
               SELECT count(*) AS distinct_points,
                      sum(k) AS located_incidents,
                      round(100.0*sum(k) FILTER (WHERE k >= 2)   / sum(k), 1) AS pct_in_stacks_2plus,
                      round(100.0*sum(k) FILTER (WHERE k >= 16)  / sum(k), 1) AS pct_in_stacks_16plus,
                      round(100.0*sum(k) FILTER (WHERE k >= 100) / sum(k), 1) AS pct_in_stacks_100plus,
                      max(k) AS biggest_stack
               FROM pts""")
    R.p("Largest stacks, with their dominant premise type (candidates for 'registration locations': "
        "precincts, hospitals, transit hubs, malls):")
    R.table("""SELECT round(lat, 6) AS lat, round(lon, 6) AS lon, count(*) AS n,
                      mode(boro_nm) AS boro, mode(addr_pct_cd) AS precinct,
                      mode(prem_typ_desc) AS top_premise,
                      round(100.0*count(*) FILTER (WHERE prem_typ_desc = mode_prem) / count(*), 0) AS pct_top_premise
               FROM (SELECT *, mode(prem_typ_desc) OVER (PARTITION BY round(lat,6), round(lon,6)) AS mode_prem
                     FROM c WHERE lat IS NOT NULL)
               GROUP BY 1, 2 ORDER BY n DESC LIMIT 40""", "largest_stacks")

    # 6. Geography fields ---------------------------------------------------
    R.h("6. Borough and precinct fields")
    R.table("""SELECT coalesce(boro_nm, '<NULL>') AS boro_nm, count(*) AS n,
                      round(100.0*count(*)/sum(count(*)) OVER (), 2) AS pct
               FROM c GROUP BY 1 ORDER BY 2 DESC""", "boro_values")
    R.table("""SELECT count(DISTINCT addr_pct_cd) AS distinct_precincts,
                      round(100.0*avg((addr_pct_cd IS NULL)::INT), 3) AS pct_null_precinct FROM c""")
    R.table("""SELECT coalesce(juris_desc, '<NULL>') AS juris_desc, count(*) AS n,
                      round(100.0*count(*)/sum(count(*)) OVER (), 2) AS pct
               FROM c GROUP BY 1 ORDER BY 2 DESC""", "jurisdiction", max_rows=30)

    # 7. Classification -----------------------------------------------------
    R.h("7. Offense classification")
    R.table("""SELECT count(DISTINCT ky_cd) AS ky_codes, count(DISTINCT ofns_desc) AS ofns_descs,
                      count(DISTINCT pd_cd) AS pd_codes, count(DISTINCT pd_desc) AS pd_descs FROM c""")
    R.p("Key codes with more than one description (labels that changed over time):")
    R.table("""SELECT ky_cd, count(DISTINCT ofns_desc) AS n_labels, string_agg(DISTINCT ofns_desc, ' / ') AS labels
               FROM c GROUP BY 1 HAVING n_labels > 1 ORDER BY 2 DESC""", "ky_cd_multiple_labels")
    R.table("""SELECT coalesce(law_cat_cd, '<NULL>') AS law_cat_cd, count(*) AS n,
                      round(100.0*count(*)/sum(count(*)) OVER (), 2) AS pct
               FROM c GROUP BY 1 ORDER BY 2 DESC""")
    R.table("""SELECT coalesce(crm_atpt_cptd_cd, '<NULL>') AS completed_or_attempted, count(*) AS n
               FROM c GROUP BY 1 ORDER BY 2 DESC""")
    R.p("Top 40 offense descriptions, counts by report year (watch for categories that appear/disappear):")
    years = [r[0] for r in con.execute(
        "SELECT DISTINCT year(rpt_ts) FROM c WHERE rpt_ts IS NOT NULL ORDER BY 1").fetchall()]
    pivot_cols = ", ".join(f"count(*) FILTER (WHERE year(rpt_ts) = {y}) AS \"{y}\"" for y in years)
    R.table(f"""SELECT ofns_desc, count(*) AS total, {pivot_cols}
                FROM c GROUP BY 1 ORDER BY total DESC LIMIT 40""", "offense_by_year", max_rows=40)

    # 8. Completeness -------------------------------------------------------
    R.h("8. Completeness of every column")
    R.p("Null = missing; placeholder = literal values like '(null)' or 'UNKNOWN'. "
        "Demographic columns are listed for completeness only.")
    union = " UNION ALL ".join(
        f"""SELECT '{col}' AS column_name,
                   round(100.0*avg(({col} IS NULL)::INT), 2) AS pct_null,
                   round(100.0*avg(coalesce(upper(trim({col})) IN {tuple(p.upper() for p in PLACEHOLDERS)}, false)::INT), 2) AS pct_placeholder,
                   count(DISTINCT {col}) AS distinct_values
            FROM c""" for col in cols)
    R.table(union + " ORDER BY pct_null DESC, pct_placeholder DESC", "completeness", max_rows=60)

    non_demo = [c for c in cols if c not in DEMOGRAPHIC]
    R.p(f"\n_{len(cols)} columns audited; {len(cols) - len(non_demo)} demographic columns not broken down._")

    path = R.write()
    print(f"Wrote {path}")


if __name__ == "__main__":
    main()
