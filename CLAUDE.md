# CLAUDE.md — NYC Crime Map

Context for Claude Code working in this repo. Read before making changes.

## What this is
An interactive, resident-focused map of NYPD complaint data (NYC Open Data dataset
`qgea-i56i`), built to be submitted to the NYC Open Data Project Gallery. Secondary audience:
journalists. Solo project by Ramón Eppens. English only.

Positioning: **the honest guide to this dataset**. The map is the hook; the value is making
the data understandable, including its limits (coordinate jitter, withheld locations,
report vs occurrence dates, category changes, gaps vs CompStat).

## Non-negotiables
- **Reports, not risk.** Counts are complaints reported to NYPD. Never label places "dangerous"
  or "safe". No severity weighting.
- **No suspect/victim demographics** anywhere in the UI, rankings or exports.
- **No NYC logo and no imitation of nyc.gov branding.** Credit: "Data: NYC Open Data / NYPD",
  with links to the dataset.
- **Show the uncertainty.** Incidents without coordinates count in totals and are shown as
  "N without location". Stacked/snapped coordinates are explained, not hidden.
- **Clean-room code.** Do not copy code from other projects; methodology ideas are fine.
- **Accessibility:** WCAG 2.1 AA (contrast, keyboard, screen-reader labels, colorblind-safe palettes).
- **Ramón decides.** Explain trade-offs and propose; don't silently make product or
  methodology decisions. Log decisions in `docs/DECISIONS.md`.

## Layout
- `pipeline/` — Python (uv). Numbered scripts in `pipeline/scripts/`, tests in `pipeline/tests/`.
- `web/` — frontend (Vite, vanilla JS, MapLibre GL 6 + deck.gl 9 + DuckDB-WASM 1.32). Reads `data/web/`.
- `docs/` — DECISIONS.md, DATA_NOTES.md (interpretation), audit/ (generated report).
- `data/` — never committed. `data/raw/` is the untouched snapshot; derived files go elsewhere.

## Commands
```
cd pipeline
uv sync                              # install deps
uv run scripts/01_download.py        # snapshot from the SODA API (~10M rows; resumable)
uv run scripts/02_audit.py           # writes docs/audit/AUDIT_REPORT.md
uv run scripts/03_clean.py           # data/clean/complaints.parquet (rules in DATA_NOTES.md)
uv run scripts/04_reference.py       # boundaries, population, NYPD CompStat tables
uv run scripts/05_geography.py       # point -> NTA / precinct, nta.csv with population
uv run scripts/06_validate.py        # compare with NYPD CompStat -> docs/validation/
uv run scripts/07_web_data.py        # files the map loads -> data/web/
uv run pytest                        # tests

cd web
npm install
npm run fetch:duckdb-ext             # self-hosts the DuckDB Parquet extension (once)
npm run dev                          # http://localhost:5173, data served from ../data/web
python tests/sql_server.py & npm run test:smoke   # headless test with the real queries
```

## Design rules
- Brand green #42A872 (logo) is for the interface only: logo, selection, active states. Never for data.
- Text in brand green on light surfaces uses #2A7D53 (contrast). Check every new color pair for WCAG AA.
- Data colors: single-hue blue hexagon ramps per theme, quantile breaks over hexagons in view (`src/colors.js`);
  points colored by the 4 offense groups.
- Hex grid: `pipeline/scripts/hexgrid.py` (180 m pointy-top axial). The map reads the grid from `meta.json`;
  never hard-code grid constants in the web app. ColumnLayer radius = side, angle 90, coverage 1.
- Basemaps: CARTO dark-matter / positron.
- Font: Public Sans only, self-hosted (@fontsource). Tabular figures for numbers.
- No icon libraries, emojis, gradients, glows, drop-shadow cards, bento grids or em dashes in copy.
  Separation by hairlines; radius 3 px for marks and inputs, 10 px for the floating blocks over the map.
- Layout: map full width; left blocks (brand, Date range, Offense types), legend block top right,
  Night/Light pill bottom left, summary panel on the right. Time logic lives in `src/period.js`.

## Data conventions
- Raw snapshot keeps every column as text, untouched. All parsing/cleaning happens downstream
  and is documented in DATA_NOTES.md.
- Record the dataset `rowsUpdatedAt` with every derived output.
- Analysis window: report years 2016–2025, counted by report date.
- `location_type = 'precinct_only'` rows are never drawn on the map or used in small-area stats.
- Offense categories come only from `pipeline/config/` (keyed on `ky_cd`).
- Every number shown in the UI must be reproducible from the pipeline.
