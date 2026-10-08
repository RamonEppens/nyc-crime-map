"""Validate our cleaned data against NYPD's own published CompStat totals.

Compares the seven major felonies (murder, rape, robbery, felony assault, burglary, grand larceny,
grand larceny of motor vehicle), 2016-2025, citywide and by precinct, using NYPD's historical
tables (downloaded by 04_reference.py). CompStat counts by record create date, like our report date.

Known definitional differences (documented, not "fixed"):
  - Murder in CompStat comes from NYPD's Shooting & Homicide Database, not the complaint system.
  - Since 2014 complaints inside Department of Correction facilities are a separate "DOC" row,
    not part of any precinct. We compare them separately (jurisdiction = DEPT OF CORRECTIONS).
  - The 116th Precinct was created on 2024-12-19 from parts of the 105th and 113th.
  - Published-table error: CompStat's 116th Precinct rows for 2016-2023 repeat the 115th Precinct's
    figures (the 116th did not exist yet). Those rows are excluded from scoring and reported.

Usage (from pipeline/):  uv run scripts/06_validate.py
Output: docs/validation/VALIDATION.md + docs/validation/*.csv
"""
from __future__ import annotations

import argparse
import csv
from pathlib import Path

import duckdb

ROOT = Path(__file__).resolve().parents[2]
YEARS = list(range(2016, 2026))
OFFENSES = {  # our key code -> CompStat row label prefix
    101: "MURDER", 104: "RAPE", 105: "ROBBERY", 106: "FELONY ASSAULT", 107: "BURGLARY",
    109: "GRAND LARCENY", 110: "GRAND LARCENY OF MOTOR",
}
LABELS = {101: "Murder", 104: "Rape", 105: "Robbery", 106: "Felony assault", 107: "Burglary",
          109: "Grand larceny", 110: "Grand larceny of motor vehicle"}


def offense_of(label: str) -> int | str | None:
    label = " ".join(label.upper().split())
    if label.startswith("TOTAL"):
        return "total"
    # longest prefix first so "GRAND LARCENY OF MOTOR" beats "GRAND LARCENY"
    for ky, prefix in sorted(OFFENSES.items(), key=lambda kv: -len(kv[1])):
        if label.startswith(prefix):
            return ky
    return None


def year_columns(header: list) -> dict[int, int]:
    out = {}
    for i, v in enumerate(header):
        try:
            y = int(float(v))
        except (TypeError, ValueError):
            continue
        if y in YEARS:
            out[y] = i
    return out


def parse_citywide(rows: list[list]) -> dict[tuple, float]:
    """{(offense, year): count} from the citywide sheet (header row starts with 'OFFENSE')."""
    h = next(i for i, r in enumerate(rows) if str(r[0]).strip().upper() == "OFFENSE")
    cols = year_columns(rows[h])
    out = {}
    for r in rows[h + 1:]:
        off = offense_of(str(r[0]))
        if off is None:
            continue
        for y, c in cols.items():
            out[(off, y)] = float(r[c])
    return out


def parse_precinct(rows: list[list]) -> dict[tuple, float]:
    """{(precinct, offense, year): count}; precinct is an int or 'DOC'."""
    h = next(i for i, r in enumerate(rows) if str(r[0]).strip().upper() == "PCT")
    cols = year_columns(rows[h])
    out, pct = {}, None
    for r in rows[h + 1:]:
        cell = str(r[0]).strip()
        if cell.upper().startswith("STATISTICAL"):
            break
        if cell:
            try:
                pct = int(float(cell))
            except ValueError:
                pct = cell.upper()
        off = offense_of(str(r[1]))
        if pct is None or off is None:
            continue
        for y, c in cols.items():
            try:
                out[(pct, off, y)] = float(r[c])
            except (TypeError, ValueError):
                pass
    return out


def read_xls(path: Path) -> list[list]:
    import xlrd
    sh = xlrd.open_workbook(path).sheet_by_index(0)
    return [sh.row_values(i) for i in range(sh.nrows)]


def pct_diff(ours: float, theirs: float) -> float | None:
    return None if not theirs else round(100 * (ours - theirs) / theirs, 2)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", type=Path, default=ROOT)
    args = ap.parse_args()
    comp = args.root / "data" / "reference" / "compstat"
    out = args.root / "docs" / "validation"
    out.mkdir(parents=True, exist_ok=True)

    city = parse_citywide(read_xls(comp / "seven-major-felony-offenses-2000-2025.xls"))
    prec = parse_precinct(read_xls(comp / "seven-major-felony-offenses-by-precinct-2000-2025.xls"))

    kys = ", ".join(str(k) for k in OFFENSES)
    rows = duckdb.sql(f"""
        SELECT report_year, ky_cd,
               CASE WHEN jurisdiction = 'DEPT OF CORRECTIONS' THEN 'DOC' ELSE precinct::VARCHAR END AS pct,
               count(*) AS n
        FROM read_parquet('{(args.root / "data" / "clean" / "complaints.parquet").as_posix()}')
        WHERE ky_cd IN ({kys}) AND report_year BETWEEN {YEARS[0]} AND {YEARS[-1]}
        GROUP BY ALL
    """).fetchall()
    ours_city, ours_pct = {}, {}
    for y, ky, pct, n in rows:
        ours_city[(ky, y)] = ours_city.get((ky, y), 0) + n
        ours_city[("total", y)] = ours_city.get(("total", y), 0) + n
        p = "DOC" if pct == "DOC" else (int(pct) if pct is not None else None)
        ours_pct[(p, y)] = ours_pct.get((p, y), 0) + n

    # Citywide table ------------------------------------------------------
    city_rows = []
    for off in list(OFFENSES) + ["total"]:
        for y in YEARS:
            o, t = ours_city.get((off, y), 0), city.get((off, y))
            city_rows.append({"offense": LABELS.get(off, "Total seven major felonies"), "year": y,
                              "ours": o, "compstat": int(t) if t is not None else None,
                              "diff_pct": pct_diff(o, t) if t is not None else None})
    with open(out / "citywide.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=list(city_rows[0]))
        w.writeheader(), w.writerows(city_rows)

    # Precinct totals (seven majors combined) -----------------------------
    pct_rows = []
    for (p, off, y), t in prec.items():
        if off != "total":
            continue
        o = ours_pct.get((p, y), 0)
        pct_rows.append({"precinct": p, "year": y, "ours": o, "compstat": int(t), "diff_pct": pct_diff(o, t)})
    pct_rows.sort(key=lambda r: (str(r["precinct"]).zfill(4), r["year"]))
    with open(out / "precincts.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=list(pct_rows[0]))
        w.writeheader(), w.writerows(pct_rows)

    # Report ---------------------------------------------------------------
    def known_error(r):  # CompStat 116th rows before its creation duplicate the 115th
        return r["precinct"] == 116 and r["year"] < 2024
    excluded = [r for r in pct_rows if known_error(r)]
    scored = [r for r in pct_rows if r["diff_pct"] is not None and r["compstat"] >= 100 and not known_error(r)]
    within = lambda x: round(100 * sum(abs(r["diff_pct"]) <= x for r in scored) / max(1, len(scored)), 1)
    worst = sorted(scored, key=lambda r: -abs(r["diff_pct"]))[:15]
    md = ["# Validation against NYPD CompStat\n",
          "Our cleaned complaints vs NYPD's published historical tables for the seven major felonies "
          "(`data/reference/compstat/`). Generated by `pipeline/scripts/06_validate.py`.\n",
          "## Citywide, difference % (ours vs CompStat)\n",
          "| Offense | " + " | ".join(map(str, YEARS)) + " |", "|---|" + "---|" * len(YEARS)]
    for off in list(OFFENSES) + ["total"]:
        cells = [next(r for r in city_rows if r["offense"] == LABELS.get(off, "Total seven major felonies") and r["year"] == y)
                 for y in YEARS]
        md.append(f"| {LABELS.get(off, '**Total**')} | " +
                  " | ".join("" if c["diff_pct"] is None else f"{c['diff_pct']:+.2f}" for c in cells) + " |")
    md += ["\nAbsolute counts are in `citywide.csv`.\n",
           "## By precinct (seven majors combined, precinct-years with ≥100 CompStat complaints)\n",
           f"- Precinct-years compared: {len(scored)}",
           f"- Excluded: {len(excluded)} rows for the 116th Precinct before 2024. In NYPD's published "
           "table they repeat the 115th Precinct's figures; the 116th was created on 2024-12-19.",
           f"- Within ±1%: {within(1)}% · within ±2%: {within(2)}% · within ±5%: {within(5)}%\n",
           "Largest differences:\n", "| Precinct | Year | Ours | CompStat | Diff % |", "|---|---|---|---|---|"]
    md += [f"| {r['precinct']} | {r['year']} | {r['ours']:,} | {r['compstat']:,} | {r['diff_pct']:+.2f} |" for r in worst]
    md.append("\nFull table in `precincts.csv`.\n")
    (out / "VALIDATION.md").write_text("\n".join(md), encoding="utf-8")
    print("\n".join(md))


if __name__ == "__main__":
    main()
