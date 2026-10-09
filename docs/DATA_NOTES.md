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

## Geography (`05_geography.py`)
- Boundaries: 2020 NTAs (262, NYC Open Data 9nt8-h7nd) and police precincts (78, y76i-bdw7).
  Boroughs = NTAs merged. Population: 2020 Census P1_001N by tract (Census API), summed to NTAs
  via the 2020 tract file (63ge-mke6) → 8,804,190, the official total.
- 183,135 drawable points: 183,063 fall inside an NTA, 68 are within ~50 m (assigned to the
  nearest), 4 are outside (dropped from neighborhood stats). No point sits exactly on a boundary.
- NYPD's precinct field matches the precinct polygon for 95.6% of complaints. Differences are
  stable by year (~4.2–4.8%): mostly neighboring precincts along boundary streets, transit
  complaints at stations (14% differ), and the 105th/113th → 116th split.
- The 116th Precinct was created on 2024-12-19 from parts of the 105th and 113th; it appears in the
  complaint data from 2025 (224 rows dated 2024). Precinct trends for 105/113/116 break at 2025.
- Rule (#16): precinct statistics use NYPD's precinct field (what CompStat uses); neighborhood
  statistics use the NTA polygon each point falls in (stable over time).
- NTA types: parks, airports, cemeteries and Rikers have little or no population → no per-capita
  rates there.

## Validation vs CompStat (`06_validate.py`, `docs/validation/`)
- Seven major felonies, 2016–2025. Citywide our totals are within +0.1% to +0.7% of NYPD's published
  figures every year (each offense within ±2%); murders match exactly in 8 of 10 years.
- Precinct-years: 96% within ±2%, 99% within ±5%.
- Small positive gaps in older years are expected: CompStat freezes each year in January, the open
  dataset reflects later corrections.
- Found an error in NYPD's published precinct table: the 116th Precinct rows for 2016–2023 repeat
  the 115th Precinct's figures. Excluded from scoring and documented.
- Since 2014 CompStat reports complaints inside Department of Correction facilities as "DOC", not by
  precinct; we compare them separately.

## Streets and search (`08_streets.py`)
- Source: NYC Street Centerline (CSCL, `inkn-q76z`), 122,311 segments. Searchable: streets, highways,
  bridges, tunnels, boardwalks, step streets and alleys (10,056 streets = name + borough); ramps,
  paths, driveways and pedestrian overpasses are kept only as "absorbers" (a complaint on a park path
  is not given to the avenue next to it). Ferry routes are dropped.
- Names in CSCL are abbreviated with double spaces ("W  42 ST"). Display names are expanded
  ("West 42nd Street"); search keys use one normalization shared by pipeline and browser.
  Manhattan's 6th Avenue exists only as "AVE OF THE AMERICAS": aliases come from CSCL street codes
  (b5sc) plus `config/street_aliases.csv` (6th Ave, FDR Drive, Lenox Ave, BQE, Triborough...).
- House numbers: left/right ranges per segment; Queens hyphenated numbers (37-12) are encoded as
  1,000,000 + 37 × 1000 + 12, so they never collide with plain numbers. Low numbers sit at the
  segment's first vertex (checked: 350 5th Ave → between 33rd and 34th St; 1 Wall St → at Broadway;
  37-12 80th St → at 37th Ave).
- Corners: segment endpoints shared by two or more streets at the same level code (an expressway
  over an avenue is not a corner): 49,861 intersections, 53,850 street pairs.
- Assignment of mapped complaints: 98.7% get a street, 93.7% a house number; 15.2% sit at an
  intersection and count for every street that meets there (decision #47).
- Busiest block: number // 100 × 100, both sides together. Only station houses are excluded (they
  are never on the map). Open question: some large fraud clusters (e.g. Coney Island, Melrose) may
  be record locations rather than places; not proven, so not excluded.
- Precinct population: 2020 Census blocks (`wmsu-5muw` + Census API P1_001N by block) assigned to
  the precinct containing each block's representative point: 8,804,137 residents placed; the 53
  missing from the 8,804,190 total live in blocks absent from the City's block map.
- Comparison grid: 78,030 points every 100 m on land; for each, complaints within 200 m per offense
  type and year → 101 percentiles (`compare.json`). Typical 2025 circle (all offenses): 36
  complaints; 90th percentile 246. Typical street (≥ 300 m): 2.5 complaints per 100 m per year.

## Charts (`09_charts.py`, `web/src/report.js`)
- Time of day and weekday are those of the occurrence (NYPD's start time); counts stay by report year.
  Unknown times are often recorded as midnight or noon: 00:00 holds 4.6% of complaints vs 3.1% at
  1 am, 12:00 holds 5.7% vs 4.3% at 11 am (all years). The charts say so.
- `agg_time.parquet`: complaints per place × report year × offense type × weekday × hour for the city,
  boroughs, precincts (all complaints), neighborhoods and streets (mapped complaints; at an
  intersection a complaint counts for every street there). 8.1 M rows, 10.8 MB; a place reads only its
  own row groups. Exact locations and hexagons read `incidents.parquet` directly. For areas a period
  that is not whole years uses the whole report years it touches (the chart says which).
- `loc_street.parquet` (from 08): each complaint location → street(s) and hundred-block, for the
  busiest blocks of an area.

- Block highlight (hover in "Where exactly"): a block's line is the street's segments whose midpoint house number (numbered side) falls in the hundred, so a segment that only touches the edge does not count. In Manhattan a hundred-block of an avenue spans several cross streets (Broadway 2200–2299 is West 78th to West 83rd), so "between X and Y" names the outer corners.
