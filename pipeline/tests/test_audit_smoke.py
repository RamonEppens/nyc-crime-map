"""Smoke test: the audit runs end-to-end on a tiny synthetic snapshot.

Run from pipeline/:  uv run pytest
"""
import random
import subprocess
import sys
from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq

COLS = ["cmplnt_num", "cmplnt_fr_dt", "cmplnt_fr_tm", "cmplnt_to_dt", "cmplnt_to_tm", "addr_pct_cd",
        "rpt_dt", "ky_cd", "ofns_desc", "pd_cd", "pd_desc", "crm_atpt_cptd_cd", "law_cat_cd", "boro_nm",
        "loc_of_occur_desc", "prem_typ_desc", "juris_desc", "jurisdiction_code", "parks_nm", "hadevelopt",
        "housing_psa", "x_coord_cd", "y_coord_cd", "susp_age_group", "susp_race", "susp_sex",
        "transit_district", "latitude", "longitude", "patrol_boro", "station_name", "vic_age_group",
        "vic_race", "vic_sex"]


def fake_rows(n: int, year: int):
    rnd = random.Random(year)
    offenses = [("344", "ASSAULT 3 & RELATED OFFENSES", "MISDEMEANOR"), ("109", "GRAND LARCENY", "FELONY"),
                ("578", "HARRASSMENT 2", "VIOLATION"), ("104", "RAPE", "FELONY")]
    for i in range(n):
        ky, desc, law = rnd.choice(offenses)
        located = desc != "RAPE"
        lat, lon = (40.75 + rnd.choice([0, 0.001, rnd.uniform(-0.1, 0.1)]),
                    -73.98 + rnd.choice([0, 0.001, rnd.uniform(-0.1, 0.1)])) if located else (None, None)
        row = dict.fromkeys(COLS)
        row.update(cmplnt_num=f"{year}{i:07d}", cmplnt_fr_dt=f"{year}-0{rnd.randint(1, 9)}-15T00:00:00.000",
                   cmplnt_fr_tm=rnd.choice(["00:00:00", "12:00:00", "17:35:00"]),
                   rpt_dt=f"{year}-10-01T00:00:00.000", ky_cd=ky, ofns_desc=desc, law_cat_cd=law,
                   addr_pct_cd=str(rnd.choice([14, 75, 120])), boro_nm=rnd.choice(["MANHATTAN", "BROOKLYN", None]),
                   prem_typ_desc=rnd.choice(["STREET", "RESIDENCE - APT. HOUSE"]), juris_desc="N.Y. POLICE DEPT",
                   crm_atpt_cptd_cd="COMPLETED", latitude=None if lat is None else f"{lat:.6f}",
                   longitude=None if lon is None else f"{lon:.6f}", vic_race="(null)")
        yield row


def test_audit_runs(tmp_path: Path):
    raw = tmp_path / "raw"
    raw.mkdir()
    for year in (2016, 2017):
        rows = list(fake_rows(500, year))
        table = pa.Table.from_pylist(rows, schema=pa.schema([(c, pa.string()) for c in COLS]))
        pq.write_table(table, raw / f"rpt_year={year}.parquet")
    script = Path(__file__).resolve().parents[1] / "scripts" / "02_audit.py"
    result = subprocess.run([sys.executable, str(script), "--raw", str(raw), "--out", str(tmp_path / "audit")], capture_output=True, text=True)
    assert result.returncode == 0, result.stderr
    report = tmp_path / "audit" / "AUDIT_REPORT.md"
    text = report.read_text(encoding="utf-8")
    assert "1,000 rows" in text and "Coordinate stacking" in text
