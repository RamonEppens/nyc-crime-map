"""Unit tests for the CompStat table parsers (layout as published by NYPD)."""
import importlib.util
from pathlib import Path

spec = importlib.util.spec_from_file_location(
    "validate", Path(__file__).resolve().parents[1] / "scripts" / "06_validate.py")
v = importlib.util.module_from_spec(spec)
spec.loader.exec_module(v)


def test_parse_citywide():
    rows = [[""] * 4, ["Seven Major Felony Offenses", "", "", ""],
            ["OFFENSE", "2015", "2016", "2017"],
            ["MURDER & NON-NEGL. MANSLAUGHTER", 352.0, 335.0, 292.0],
            ["GRAND LARCENY", 1.0, 44279.0, 2.0],
            ["GRAND LARCENY OF MOTOR VEHICLE", 1.0, 6327.0, 3.0],
            ["TOTAL SEVEN MAJOR FELONY OFFENSES", 9.0, 101716.0, 9.0],
            ["", "", "", ""], ["STATISTICAL NOTES", "", "", ""]]
    got = v.parse_citywide(rows)
    assert got[(101, 2016)] == 335 and got[(109, 2016)] == 44279 and got[(110, 2016)] == 6327
    assert got[("total", 2017)] == 9 and (101, 2015) not in got


def test_parse_precinct():
    rows = [["Seven Major Felony Offenses by Precinct", "", "", ""],
            ["PCT", "CRIME", "2016.0", "2017.0"],
            ["1.0", "MURDER & NON NEGL. MANSLAUGHTER", 0.0, 9.0],
            ["", "ROBBERY               ", 60.0, 69.0],
            ["", "TOTAL SEVEN MAJOR FELONY OFFENSES", 1395.0, 1337.0],
            ["DOC", "FELONY ASSAULT", 500.0, 600.0],
            ["", "TOTAL SEVEN MAJOR FELONY OFFENSES", 700.0, 800.0],
            ["STATISTICAL NOTES", "", "", ""], ["1. something", "", "", ""]]
    got = v.parse_precinct(rows)
    assert got[(1, 101, 2017)] == 9 and got[(1, 105, 2016)] == 60
    assert got[(1, "total", 2016)] == 1395 and got[("DOC", "total", 2017)] == 800
    assert v.pct_diff(101, 100) == 1.0
