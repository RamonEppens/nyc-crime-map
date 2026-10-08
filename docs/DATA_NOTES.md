# Data notes

How we interpret and clean the NYPD complaint data. Sources: the audit
(`docs/audit/AUDIT_REPORT.md`, snapshot rowsUpdatedAt 2026-04-28) plus follow-up queries.
Rules are implemented in `pipeline/scripts/03_clean.py`; decisions are logged in `DECISIONS.md`.

## Snapshot
- 10,071,507 rows, report years 2006–2025. Every row has a report date. 2026 is not in this
  dataset (it lives in *NYPD Complaint Data Current YTD*, `5uac-w243`).
- 1,106 rows (0.01%) share a `cmplnt_num` with another row. Rule: keep the earliest-reported row (#15).
- Text "(null)" is used as a placeholder in most text columns → normalize to NULL.

## Window — report years 2016–2025 (#2)
- Before 2016, ~1,200–3,600 rows/year have no offense description; from 2016 it's ~10–50/year.
- 2020 is a COVID outlier (−10% volume). 2022 shows a jump in several categories.

## Dates
- Report date (`rpt_dt`) is complete; occurrence date is missing for 0.007%.
- ~98% of complaints are reported the same year they occurred; median reporting lag is 0 days
  (p90: 5 days misdemeanors, 13 days felonies).
- Count by report date; occurrence time only for time-of-day views (#11).
- Time of day: 34% of times fall exactly on the hour and noon is inflated (2.6%) → times are often
  estimated. The day×hour heatmap needs a note.

## Locations — the most important finding
- Virtually every row has coordinates (only 479 missing, mostly 2006–2007).
  **But coordinates are snapped:** ~70,000 distinct points per year for ~500,000 complaints.
  ~50% of complaints in a year share their point with 15+ others.
- **Rape and sex crimes are placed on a few fixed points — apparently the precinct station
  houses** — never at the real location (privacy). The same points also hold ~35% of murders
  (2016+) and small numbers of other offenses. There are 128 such coordinate pairs (some
  precincts have more than one, with different decimal precision); each belongs 100% to one
  precinct (78 precincts). Everything on them, plus sexual-exploitation offenses filed under other codes,
  is `precinct_only`: counted in precinct/borough/city totals, never drawn (#12). The points are
  exported to `data/clean/precinct_points.csv`; still to verify against station-house addresses.
- Housing Police complaints (344k since 2016) sit on ~3,250 points (NYCHA developments);
  Transit Police complaints (152k) on ~1,700 points (subway stations).
- The largest stacks are real places: Macy's Herald Square (29k, department store), JFK terminals,
  Queens Center mall, Port Authority Bus Terminal, 125th St station. One Bronx point (41st pct,
  12.8k, premise "OTHER", mostly offenses against public administration / felony assault) looks
  like a correctional facility — to verify.
- Design consequence: "one dot per incident" is misleading here. The honest unit is the
  **snapped location**, drawn with size by count.

## Offense categories
- Use the stable key code `ky_cd`, not the label: several labels changed in 2024
  (e.g. "OTHER OFFENSES RELATED TO THEF" → full label; "NYS LAWS-UNCLASSIFIED FELONY",
  "OTHER STATE LAWS (NON PENAL LA" and "THEFT OF SERVICES" drop to 0 while "OTHER STATE LAWS" jumps).
- Some categories mostly measure police activity, not victimization: vehicle & traffic laws
  (6k → 25k, 2020 → 2025), dangerous drugs (34k in 2006 → 8k in 2021 → 19k in 2025),
  dangerous weapons, offenses against public administration, criminal trespass.
  They form the "enforcement" group, and the UI says so (#13). Mapping: `pipeline/config/`.
- Code 361 is mostly aggravated harassment (victim-reported) → grouped with harassment.
  Code 126 is mostly criminal contempt 1 / reckless endangerment → other crimes against persons.

## Jurisdiction
- 89% NYPD, 7% Housing Police, 2.6% Transit Police, rest Port Authority, Correction, etc.
- "POLICE DEPT NYC" (8,955 rows) is a separate label from "N.Y. POLICE DEPT" — to check.

## Demographics
- Suspect/victim fields are excluded by design (decision #3). Suspect fields are 40–64% unknown anyway.

## Known differences vs CompStat
_TBD (validation step)._
